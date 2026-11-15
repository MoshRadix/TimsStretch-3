pub mod stream_server;
pub mod waveform;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;
use stream_server::{ensure_stream_server, parse_byte_range, StreamRegistry};
use tauri::http::{header, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_updater::UpdaterExt;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub stream_url: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredAudioFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub mtime_ms: u64,
    pub stream_url: String,
    pub position: f64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFileResult {
    pub saved: bool,
    pub path: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub last_audio_path: Option<String>,
    pub playback_position: f64,
    pub shortcuts: HashMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatusInfo {
    pub current_version: String,
    pub available: bool,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub release_url: String,
    pub installer_url: Option<String>,
    pub downloaded: bool,
    pub message: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressPayload {
    pub percent: f64,
    pub message: String,
}

pub struct AppState {
    pub registry: StreamRegistry,
    pub session: Mutex<PersistedSession>,
    pub update_info: Mutex<UpdateStatusInfo>,
}

fn session_file_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("session.json"))
}

fn load_session_from_disk(app: &AppHandle) -> PersistedSession {
    if let Some(p) = session_file_path(app) {
        if let Ok(raw) = fs::read_to_string(p) {
            if let Ok(parsed) = serde_json::from_str::<PersistedSession>(&raw) {
                return parsed;
            }
        }
    }
    PersistedSession::default()
}

fn persist_session_to_disk(app: &AppHandle, session: &PersistedSession) {
    if let Some(p) = session_file_path(app) {
        if let Ok(json) = serde_json::to_string_pretty(session) {
            let _ = fs::write(p, json);
        }
    }
}

async fn build_audio_file_info(
    path: &Path,
    registry: &StreamRegistry,
) -> Result<AudioFileInfo, String> {
    let meta = fs::metadata(path).map_err(|e| format!("Cannot read file metadata: {}", e))?;
    let size = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("audio.wav")
        .to_string();

    let token = registry.register_file(path);
    let port = ensure_stream_server(registry.clone()).await?;
    let stream_url = format!("http://127.0.0.1:{}/stream/{}", port, token);

    Ok(AudioFileInfo {
        name,
        path: path.to_string_lossy().to_string(),
        size,
        mtime_ms,
        stream_url,
    })
}

#[tauri::command]
async fn open_audio_dialog(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<AudioFileInfo>, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Open Audio Track (.mp3 / .wav)")
        .add_filter("Audio Files (*.mp3, *.wav)", &["mp3", "wav"])
        .blocking_pick_file();

    let file_path = match picked {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("Invalid file path: {}", e))?,
        None => return Ok(None),
    };

    let info = build_audio_file_info(&file_path, &state.registry).await?;

    if let Ok(mut guard) = state.session.lock() {
        guard.last_audio_path = Some(info.path.clone());
        guard.playback_position = 0.0;
        persist_session_to_disk(&app, &guard);
    }

    Ok(Some(info))
}

#[tauri::command]
async fn register_audio_path(
    file_path: String,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AudioFileInfo, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    let info = build_audio_file_info(path, &state.registry).await?;
    if let Ok(mut guard) = state.session.lock() {
        guard.last_audio_path = Some(info.path.clone());
        guard.playback_position = 0.0;
        persist_session_to_disk(&app, &guard);
    }
    Ok(info)
}

#[tauri::command]
async fn restore_last_audio(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<RestoredAudioFileInfo>, String> {
    let (last_path_opt, position) = {
        let guard = state
            .session
            .lock()
            .map_err(|_| "Session lock poisoned".to_string())?;
        (guard.last_audio_path.clone(), guard.playback_position)
    };

    let last_path = match last_path_opt {
        Some(p) if !p.trim().is_empty() => p,
        _ => return Ok(None),
    };

    let path = Path::new(&last_path);
    if !path.exists() {
        return Ok(None);
    }

    let info = build_audio_file_info(path, &state.registry).await?;
    Ok(Some(RestoredAudioFileInfo {
        name: info.name,
        path: info.path,
        size: info.size,
        mtime_ms: info.mtime_ms,
        stream_url: info.stream_url,
        position,
    }))
}

#[tauri::command]
fn save_playback_position(
    position: f64,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.session.lock() {
        guard.playback_position = position.max(0.0);
        persist_session_to_disk(&app, &guard);
    }
    Ok(())
}

#[tauri::command]
fn clear_last_audio(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Ok(mut guard) = state.session.lock() {
        guard.last_audio_path = None;
        guard.playback_position = 0.0;
        persist_session_to_disk(&app, &guard);
    }
    Ok(())
}

#[tauri::command]
async fn generate_waveform(
    file_path: String,
    bins: usize,
    app: AppHandle,
) -> Result<Vec<f32>, String> {
    tokio::task::spawn_blocking(move || waveform::compute_waveform_streaming(&file_path, bins, &app))
        .await
        .map_err(|e| format!("Waveform task failed: {}", e))?
}

#[tauri::command]
async fn save_transcript_file(
    suggested_name: String,
    content: String,
    app: AppHandle,
) -> Result<SaveFileResult, String> {
    let default_name = if suggested_name.trim().is_empty() {
        "m0sh-transcript.txt".to_string()
    } else if suggested_name.to_ascii_lowercase().ends_with(".txt") {
        suggested_name
    } else {
        format!("{}.txt", suggested_name)
    };

    let picked = app
        .dialog()
        .file()
        .set_title("Save Transcript (.txt)")
        .set_file_name(&default_name)
        .add_filter("UTF-8 Text File (*.txt)", &["txt"])
        .blocking_save_file();

    let dest_path = match picked {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("Invalid destination path: {}", e))?,
        None => {
            return Ok(SaveFileResult {
                saved: false,
                path: None,
            })
        }
    };

    // Prepend UTF-8 BOM (\uFEFF) so Dhivehi (Thaana) text opens cleanly in Windows Notepad / Word
    let mut payload = Vec::with_capacity(content.len() + 3);
    if !content.starts_with('\u{FEFF}') {
        payload.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    payload.extend_from_slice(content.as_bytes());

    let tmp_path = dest_path.with_extension("txt.tmp");
    {
        let mut f =
            File::create(&tmp_path).map_err(|e| format!("Failed to create file: {}", e))?;
        f.write_all(&payload)
            .map_err(|e| format!("Failed to write transcript: {}", e))?;
        f.sync_all()
            .map_err(|e| format!("Failed to flush file: {}", e))?;
    }
    fs::rename(&tmp_path, &dest_path).or_else(|_| {
        fs::copy(&tmp_path, &dest_path)?;
        let _ = fs::remove_file(&tmp_path);
        Ok::<(), std::io::Error>(())
    }).map_err(|e| format!("Failed to finalize transcript file: {}", e))?;

    Ok(SaveFileResult {
        saved: true,
        path: Some(dest_path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn save_wav_recording(
    suggested_name: String,
    pcm_samples: Vec<f32>,
    sample_rate: u32,
    app: AppHandle,
) -> Result<SaveFileResult, String> {
    let default_name = if suggested_name.trim().is_empty() {
        "m0sh-recording.wav".to_string()
    } else if suggested_name.to_ascii_lowercase().ends_with(".wav") {
        suggested_name
    } else {
        format!("{}.wav", suggested_name)
    };

    let picked = app
        .dialog()
        .file()
        .set_title("Save Recorded WAV Audio")
        .set_file_name(&default_name)
        .add_filter("WAV Audio (*.wav)", &["wav"])
        .blocking_save_file();

    let dest_path = match picked {
        Some(fp) => fp
            .into_path()
            .map_err(|e| format!("Invalid destination path: {}", e))?,
        None => {
            return Ok(SaveFileResult {
                saved: false,
                path: None,
            })
        }
    };

    tokio::task::spawn_blocking(move || -> Result<SaveFileResult, String> {
        let sr = sample_rate.max(8000);
        let num_channels: u16 = 1;
        let bits_per_sample: u16 = 16;
        let bytes_per_sample: u16 = bits_per_sample / 8;
        let block_align: u16 = num_channels * bytes_per_sample;
        let byte_rate: u32 = sr * (block_align as u32);
        let data_size: u32 = (pcm_samples.len() as u64 * 2).min(u32::MAX as u64 - 44) as u32;
        let riff_size: u32 = 36 + data_size;

        let file = File::create(&dest_path)
            .map_err(|e| format!("Failed to create WAV file: {}", e))?;
        let mut writer = BufWriter::with_capacity(64 * 1024, file);

        let mut header = [0u8; 44];
        header[0..4].copy_from_slice(b"RIFF");
        header[4..8].copy_from_slice(&riff_size.to_le_bytes());
        header[8..12].copy_from_slice(b"WAVE");
        header[12..16].copy_from_slice(b"fmt ");
        header[16..20].copy_from_slice(&16u32.to_le_bytes());
        header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM = 1
        header[22..24].copy_from_slice(&num_channels.to_le_bytes());
        header[24..28].copy_from_slice(&sr.to_le_bytes());
        header[28..32].copy_from_slice(&byte_rate.to_le_bytes());
        header[32..34].copy_from_slice(&block_align.to_le_bytes());
        header[34..36].copy_from_slice(&bits_per_sample.to_le_bytes());
        header[36..40].copy_from_slice(b"data");
        header[40..44].copy_from_slice(&data_size.to_le_bytes());

        writer
            .write_all(&header)
            .map_err(|e| format!("Failed to write WAV header: {}", e))?;

        for &sample in &pcm_samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let pcm16 = (clamped * 32767.0).round() as i16;
            writer
                .write_all(&pcm16.to_le_bytes())
                .map_err(|e| format!("Failed to write WAV sample: {}", e))?;
        }

        writer
            .flush()
            .map_err(|e| format!("Failed to finalize WAV file: {}", e))?;

        Ok(SaveFileResult {
            saved: true,
            path: Some(dest_path.to_string_lossy().to_string()),
        })
    })
    .await
    .map_err(|e| format!("WAV encoding thread failed: {}", e))?
}

fn normalize_shortcut_for_os(accel: &str) -> Option<String> {
    let trimmed = accel.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Skip OS registration for keys that aren't valid global hotkeys (like bare Space or Alt+,)
    // so they remain active exclusively inside the app window without hijacking OS typing.
    let lower = trimmed.to_ascii_lowercase();
    if lower == "space" || lower.ends_with("+comma") || lower.ends_with("+,") || !lower.contains('+') {
        return None;
    }
    Some(trimmed.to_string())
}

#[tauri::command]
fn update_global_shortcuts(
    shortcuts: HashMap<String, String>,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if let Ok(mut guard) = state.session.lock() {
        guard.shortcuts = shortcuts.clone();
        persist_session_to_disk(&app, &guard);
    }

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();

    let action_map = [
        ("playPause", "toggle-play"),
        ("seekBackward", "seek-backward"),
        ("seekForward", "seek-forward"),
        ("speedUp", "speed-up"),
        ("speedDown", "speed-down"),
        ("pitchUp", "pitch-up"),
        ("pitchDown", "pitch-down"),
        ("openSettings", "open-settings"),
    ];

    for (key_name, action_event) in action_map {
        if let Some(raw_combo) = shortcuts.get(key_name) {
            if let Some(valid_accel) = normalize_shortcut_for_os(raw_combo) {
                let event_payload = action_event.to_string();
                let app_clone = app.clone();
                let _ = gs.on_shortcut(valid_accel.as_str(), move |_app, _scut, ev| {
                    if ev.state == ShortcutState::Pressed {
                        let _ = app_clone.emit("shortcut://action", event_payload.clone());
                    }
                });
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn get_update_state(state: State<'_, Arc<AppState>>) -> Result<UpdateStatusInfo, String> {
    let guard = state
        .update_info
        .lock()
        .map_err(|_| "Update state lock poisoned".to_string())?;
    Ok(guard.clone())
}

fn compare_semver(current: &str, latest: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        v.trim_start_matches('v')
            .split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let c = parse(current);
    let l = parse(latest);
    for i in 0..3 {
        let cv = *c.get(i).unwrap_or(&0);
        let lv = *l.get(i).unwrap_or(&0);
        if lv > cv {
            return true;
        }
        if lv < cv {
            return false;
        }
    }
    false
}

fn pick_platform_installer_asset(assets: &[serde_json::Value]) -> Option<String> {
    let mut exe_url: Option<String> = None;
    let mut msi_url: Option<String> = None;
    let mut _dmg_url: Option<String> = None;
    let mut _appimage_url: Option<String> = None;

    for asset in assets {
        let name = asset
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let dl_url = match asset.get("browser_download_url").and_then(|v| v.as_str()) {
            Some(u) => u.to_string(),
            None => continue,
        };
        if name.ends_with(".sig") || name.ends_with(".json") {
            continue;
        }
        if name.ends_with("-setup.exe") || name.ends_with(".exe") {
            exe_url = Some(dl_url);
        } else if name.ends_with(".msi") {
            msi_url = Some(dl_url);
        } else if name.ends_with(".dmg") {
            _dmg_url = Some(dl_url);
        } else if name.ends_with(".appimage") {
            _appimage_url = Some(dl_url);
        }
    }

    #[cfg(target_os = "windows")]
    {
        exe_url.or(msi_url)
    }
    #[cfg(target_os = "macos")]
    {
        _dmg_url
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        _appimage_url
    }
}

async fn perform_update_check(
    app: &AppHandle,
    state: &Arc<AppState>,
) -> Result<UpdateStatusInfo, String> {
    let current_version = app.package_info().version.to_string();
    let release_url = "https://github.com/MoshRadix/TimsStretch-3/releases/latest".to_string();

    // First attempt native Tauri updater check
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            let info = UpdateStatusInfo {
                current_version,
                available: true,
                latest_version: Some(update.version.clone()),
                release_notes: update.body.clone(),
                release_url,
                installer_url: None,
                downloaded: false,
                message: format!("Mandatory update v{} found. Updating now...", update.version),
            };
            if let Ok(mut guard) = state.update_info.lock() {
                *guard = info.clone();
            }
            let _ = app.emit("update://available", info.clone());
            return Ok(info);
        }
    }

    // Fallback to GitHub Releases REST API check (checks both repo name variants)
    let client = reqwest::Client::builder()
        .user_agent("M0SH-TimeStretch-3-Updater/1.0")
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let api_endpoints = [
        "https://api.github.com/repos/MoshRadix/TimsStretch-3/releases/latest",
        "https://api.github.com/repos/MoshRadix/mosh-timestretch-3/releases/latest",
    ];

    for endpoint in api_endpoints {
        let resp = client.get(endpoint).send().await;
        if let Ok(r) = resp {
            if r.status().is_success() {
                if let Ok(json) = r.json::<serde_json::Value>().await {
                    let tag = json
                        .get("tag_name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&current_version)
                        .trim_start_matches('v')
                        .to_string();
                    let notes = json
                        .get("body")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let html_url = json
                        .get("html_url")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&release_url)
                        .to_string();
                    let installer_url = json
                        .get("assets")
                        .and_then(|a| a.as_array())
                        .and_then(|arr| pick_platform_installer_asset(arr));
                    let is_newer = compare_semver(&current_version, &tag);

                    let info = UpdateStatusInfo {
                        current_version: current_version.clone(),
                        available: is_newer,
                        latest_version: Some(tag.clone()),
                        release_notes: notes,
                        release_url: html_url,
                        installer_url,
                        downloaded: false,
                        message: if is_newer {
                            format!("Mandatory update v{} found. Updating now...", tag)
                        } else {
                            format!("You are running the latest version (v{}).", current_version)
                        },
                    };
                    if let Ok(mut guard) = state.update_info.lock() {
                        *guard = info.clone();
                    }
                    if is_newer {
                        let _ = app.emit("update://available", info.clone());
                    }
                    return Ok(info);
                }
            }
        }
    }

    let up_to_date = UpdateStatusInfo {
        current_version: current_version.clone(),
        available: false,
        latest_version: Some(current_version.clone()),
        release_notes: None,
        release_url,
        installer_url: None,
        downloaded: false,
        message: format!("You are on the latest version (v{}).", current_version),
    };
    if let Ok(mut guard) = state.update_info.lock() {
        *guard = up_to_date.clone();
    }
    Ok(up_to_date)
}

#[tauri::command]
async fn check_for_updates(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpdateStatusInfo, String> {
    perform_update_check(&app, state.inner()).await
}

#[tauri::command]
async fn install_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<UpdateStatusInfo, String> {
    let _ = app.emit(
        "update://progress",
        UpdateProgressPayload {
            percent: 5.0,
            message: "Connecting to release server...".to_string(),
        },
    );

    // 1. Primary path: Native Tauri Updater (signed bundle + latest.json)
    if let Ok(updater) = app.updater() {
        if let Ok(Some(update)) = updater.check().await {
            let mut downloaded_bytes: u64 = 0;
            let update_version = update.version.clone();
            let app_progress = app.clone();
            let app_finish = app.clone();

            update
                .download_and_install(
                    move |chunk_len, content_len| {
                        downloaded_bytes += chunk_len as u64;
                        let total = content_len.unwrap_or(0);
                        let pct = if total > 0 {
                            ((downloaded_bytes as f64 / total as f64) * 100.0).clamp(5.0, 99.0)
                        } else {
                            50.0
                        };
                        let _ = app_progress.emit(
                            "update://progress",
                            UpdateProgressPayload {
                                percent: pct,
                                message: format!("Downloading update v{}... {:.0}%", update_version, pct),
                            },
                        );
                    },
                    move || {
                        let _ = app_finish.emit(
                            "update://progress",
                            UpdateProgressPayload {
                                percent: 100.0,
                                message: "Installing update & restarting M0SH TimeStretch 3...".to_string(),
                            },
                        );
                    },
                )
                .await
                .map_err(|e| format!("Failed to install update: {}", e))?;

            if let Ok(mut guard) = state.update_info.lock() {
                guard.downloaded = true;
                guard.message = "Update installed. Restarting application...".to_string();
                return Ok(guard.clone());
            }
        }
    }

    // 2. Fallback path: Direct GitHub Releases installer asset download & execution
    let mut installer_url_opt = state
        .update_info
        .lock()
        .ok()
        .and_then(|g| g.installer_url.clone());

    if installer_url_opt.is_none() {
        if let Ok(refreshed) = perform_update_check(&app, state.inner()).await {
            installer_url_opt = refreshed.installer_url;
        }
    }

    if let Some(installer_url) = installer_url_opt {
        let _ = app.emit(
            "update://progress",
            UpdateProgressPayload {
                percent: 25.0,
                message: "Downloading release installer from GitHub...".to_string(),
            },
        );

        let client = reqwest::Client::builder()
            .user_agent("M0SH-TimeStretch-3-Updater/1.0")
            .build()
            .map_err(|e| format!("HTTP client error: {}", e))?;

        let response = client
            .get(&installer_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download installer: {}", e))?;

        if !response.status().is_success() {
            return Err(format!(
                "Installer download failed with HTTP {}",
                response.status()
            ));
        }

        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("Failed reading installer bytes: {}", e))?;

        let _ = app.emit(
            "update://progress",
            UpdateProgressPayload {
                percent: 90.0,
                message: "Launching installer & restarting...".to_string(),
            },
        );

        let file_name = installer_url
            .split('/')
            .last()
            .unwrap_or("TimeStretch-3-Update-Setup.exe");
        let temp_path = std::env::temp_dir().join(file_name);
        fs::write(&temp_path, &bytes)
            .map_err(|e| format!("Failed to write temp installer: {}", e))?;

        #[cfg(target_os = "windows")]
        {
            let path_str = temp_path.to_string_lossy().to_string();
            if path_str.to_ascii_lowercase().ends_with(".msi") {
                std::process::Command::new("msiexec")
                    .args(["/i", &path_str, "/passive"])
                    .spawn()
                    .map_err(|e| format!("Failed to launch MSI installer: {}", e))?;
            } else {
                std::process::Command::new(&temp_path)
                    .arg("/S")
                    .spawn()
                    .or_else(|_| std::process::Command::new(&temp_path).spawn())
                    .map_err(|e| format!("Failed to launch setup installer: {}", e))?;
            }
        }

        let _ = app.emit(
            "update://progress",
            UpdateProgressPayload {
                percent: 100.0,
                message: "Update installer launched. Closing old version...".to_string(),
            },
        );

        app.exit(0);
    }

    Err("No installable update package found for this platform.".to_string())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("Only http/https URLs are supported.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", trimmed])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(trimmed)
            .spawn()
            .map_err(|e| format!("Failed to open URL in browser: {}", e))?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let registry = StreamRegistry::new();
    let protocol_registry = registry.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("moshstream", move |_ctx, request| {
            let uri = request.uri().to_string();
            let token = uri
                .split("://localhost/")
                .nth(1)
                .unwrap_or("")
                .trim_matches('/');

            let path = match protocol_registry.resolve_token(token) {
                Some(p) => p,
                None => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Vec::new())
                        .unwrap();
                }
            };

            let mut file = match File::open(&path) {
                Ok(f) => f,
                Err(_) => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                        .body(Vec::new())
                        .unwrap();
                }
            };

            let total_size = file.metadata().map(|m| m.len()).unwrap_or(0);
            let mime = match path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str()
            {
                "mp3" => "audio/mpeg",
                "wav" => "audio/wav",
                _ => "application/octet-stream",
            };

            if let Some(range_hdr) = request.headers().get(header::RANGE) {
                if let Ok(range_str) = range_hdr.to_str() {
                    if let Some((start, end)) = parse_byte_range(range_str, total_size) {
                        let chunk_len = (end - start + 1).min(4 * 1024 * 1024);
                        let actual_end = start + chunk_len - 1;
                        let mut buf = vec![0u8; chunk_len as usize];
                        if file.seek(SeekFrom::Start(start)).is_ok()
                            && file.read_exact(&mut buf).is_ok()
                        {
                            return Response::builder()
                                .status(StatusCode::PARTIAL_CONTENT)
                                .header(header::CONTENT_TYPE, mime)
                                .header(header::ACCEPT_RANGES, "bytes")
                                .header(
                                    header::CONTENT_RANGE,
                                    format!("bytes {}-{}/{}", start, actual_end, total_size),
                                )
                                .header(header::CONTENT_LENGTH, chunk_len.to_string())
                                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                                .body(buf)
                                .unwrap();
                        }
                    }
                }
            }

            let read_len = total_size.min(4 * 1024 * 1024) as usize;
            let mut buf = vec![0u8; read_len];
            let _ = file.read(&mut buf);

            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, mime)
                .header(header::ACCEPT_RANGES, "bytes")
                .header(header::CONTENT_LENGTH, read_len.to_string())
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(buf)
                .unwrap()
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let initial_session = load_session_from_disk(&handle);
            let pkg_version = app.package_info().version.to_string();

            let state = Arc::new(AppState {
                registry: registry.clone(),
                session: Mutex::new(initial_session),
                update_info: Mutex::new(UpdateStatusInfo {
                    current_version: pkg_version.clone(),
                    available: false,
                    latest_version: Some(pkg_version),
                    release_notes: None,
                    release_url:
                        "https://github.com/MoshRadix/TimsStretch-3/releases/latest"
                            .to_string(),
                    installer_url: None,
                    downloaded: false,
                    message: "Checking for updates...".to_string(),
                }),
            });

            let bg_handle = handle.clone();
            let bg_state = state.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let _ = perform_update_check(&bg_handle, &bg_state).await;
            });

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_audio_dialog,
            register_audio_path,
            restore_last_audio,
            save_playback_position,
            clear_last_audio,
            generate_waveform,
            save_transcript_file,
            save_wav_recording,
            update_global_shortcuts,
            get_update_state,
            check_for_updates,
            install_update,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running M0SH TimeStretch application");
}
