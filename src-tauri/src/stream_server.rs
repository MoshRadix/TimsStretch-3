use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

#[derive(Clone, Default)]
pub struct StreamRegistry {
    tokens: Arc<RwLock<HashMap<String, PathBuf>>>,
}

impl StreamRegistry {
    pub fn new() -> Self {
        Self {
            tokens: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn register_file(&self, path: &Path) -> String {
        let mut hasher = Sha256::new();
        hasher.update(path.to_string_lossy().as_bytes());
        let token = hex::encode(&hasher.finalize()[..16]);
        if let Ok(mut guard) = self.tokens.write() {
            guard.insert(token.clone(), path.to_path_buf());
        }
        token
    }

    pub fn resolve_token(&self, token: &str) -> Option<PathBuf> {
        let clean = token.trim_matches('/').split('?').next().unwrap_or(token);
        self.tokens.read().ok()?.get(clean).cloned()
    }
}

static SERVER_PORT: OnceCell<u16> = OnceCell::const_new();

pub async fn ensure_stream_server(registry: StreamRegistry) -> Result<u16, String> {
    let port = SERVER_PORT
        .get_or_try_init(|| async move {
            let listener = TcpListener::bind("127.0.0.1:0")
                .await
                .map_err(|e| format!("Failed to bind local range stream server: {}", e))?;
            let addr = listener
                .local_addr()
                .map_err(|e| format!("Failed to query stream server address: {}", e))?;
            let port = addr.port();

            tokio::spawn(async move {
                loop {
                    if let Ok((socket, _)) = listener.accept().await {
                        let reg = registry.clone();
                        tokio::spawn(async move {
                            let _ = handle_client(socket, reg).await;
                        });
                    }
                }
            });

            Ok::<u16, String>(port)
        })
        .await?;

    Ok(*port)
}

fn guess_mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "m4a" | "mp4" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

async fn handle_client(mut stream: TcpStream, registry: StreamRegistry) -> std::io::Result<()> {
    let mut req_buf = [0u8; 4096];
    let n = stream.read(&mut req_buf).await?;
    if n == 0 {
        return Ok(());
    }

    let req_str = String::from_utf8_lossy(&req_buf[..n]);
    let mut lines = req_str.lines();
    let request_line = match lines.next() {
        Some(l) => l,
        None => return Ok(()),
    };

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("GET");
    let raw_uri = parts.next().unwrap_or("/");

    if method == "OPTIONS" {
        let resp = "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type\r\n\r\n";
        use tokio::io::AsyncWriteExt;
        stream.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    let token = raw_uri
        .trim_start_matches('/')
        . trim_start_matches("stream/")
        .split('/')
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("");

    let file_path = match registry.resolve_token(token) {
        Some(p) => p,
        None => {
            use tokio::io::AsyncWriteExt;
            let resp = "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            stream.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
    };

    let mut file = match File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => {
            use tokio::io::AsyncWriteExt;
            let resp = "HTTP/1.1 404 Not Found\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\n\r\n";
            stream.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
    };

    let total_size = file.metadata().await?.len();
    let mime = guess_mime(&file_path);

    let mut range_header: Option<String> = None;
    for line in lines {
        if line.is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            }
        }
    }

    use tokio::io::AsyncWriteExt;

    if let Some(range_val) = range_header {
        if let Some((start, end)) = parse_byte_range(&range_val, total_size) {
            let chunk_len = (end - start + 1).min(4 * 1024 * 1024); // Cap single range chunk to 4 MB for fast streaming
            let actual_end = start + chunk_len - 1;

            file.seek(SeekFrom::Start(start)).await?;
            let header = format!(
                "HTTP/1.1 206 Partial Content\r\n\
                 Content-Type: {}\r\n\
                 Accept-Ranges: bytes\r\n\
                 Content-Range: bytes {}-{}/{}\r\n\
                 Content-Length: {}\r\n\
                 Access-Control-Allow-Origin: *\r\n\
                 Cache-Control: no-store\r\n\r\n",
                mime, start, actual_end, total_size, chunk_len
            );
            stream.write_all(header.as_bytes()).await?;
            if method != "HEAD" {
                let mut take = file.take(chunk_len);
                tokio::io::copy(&mut take, &mut stream).await?;
            }
            return Ok(());
        }
    }

    let header = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {}\r\n\
         Accept-Ranges: bytes\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Cache-Control: no-store\r\n\r\n",
        mime, total_size
    );
    stream.write_all(header.as_bytes()).await?;
    if method != "HEAD" {
        tokio::io::copy(&mut file, &mut stream).await?;
    }
    Ok(())
}

pub fn parse_byte_range(range_header: &str, total_size: u64) -> Option<(u64, u64)> {
    if total_size == 0 {
        return None;
    }
    let spec = range_header.strip_prefix("bytes=")?;
    let (start_str, end_str) = spec.split_once('-')?;
    let start: u64 = start_str.trim().parse().ok()?;
    if start >= total_size {
        return None;
    }
    let end: u64 = if end_str.trim().is_empty() {
        total_size - 1
    } else {
        end_str.trim().parse::<u64>().ok()?.min(total_size - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}
