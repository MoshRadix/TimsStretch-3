import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { relaunch } from "@tauri-apps/plugin-process";

export interface AudioFileInfo {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
  streamUrl: string;
}

export interface RestoredAudioFileInfo extends AudioFileInfo {
  position: number;
}

export interface SaveFileResult {
  saved: boolean;
  path: string | null;
}

export interface WaveformProgressPayload {
  path: string;
  progress: number;
  partialPeaks: number[];
}

export interface UpdateStatusInfo {
  currentVersion: string;
  available: boolean;
  latestVersion: string | null;
  releaseNotes: string | null;
  releaseUrl: string;
  installerUrl?: string | null;
  downloaded: boolean;
  message: string;
}

export interface UpdateProgressPayload {
  percent: number;
  message: string;
}

export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

export async function openAudioDialog(): Promise<AudioFileInfo | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  return await invoke<AudioFileInfo | null>("open_audio_dialog");
}

export async function registerAudioPath(filePath: string): Promise<AudioFileInfo> {
  return await invoke<AudioFileInfo>("register_audio_path", { filePath });
}

export async function restoreLastAudio(): Promise<RestoredAudioFileInfo | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  try {
    return await invoke<RestoredAudioFileInfo | null>("restore_last_audio");
  } catch {
    return null;
  }
}

export async function savePlaybackPosition(position: number): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("save_playback_position", { position });
  } catch {
    // Ignore non-critical persistence errors
  }
}

export async function clearLastAudio(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("clear_last_audio");
  } catch {
    // Ignore
  }
}

export async function generateWaveform(
  filePath: string,
  bins = 512
): Promise<number[]> {
  if (!isTauriRuntime()) {
    return Array.from({ length: bins }, (_, i) =>
      Math.max(0.08, Math.min(0.95, 0.42 + 0.35 * Math.sin(i * 0.14)))
    );
  }
  return await invoke<number[]>("generate_waveform", { filePath, bins });
}

export async function saveTranscriptFile(
  suggestedName: string,
  content: string
): Promise<SaveFileResult> {
  if (!isTauriRuntime()) {
    const bomContent = content.startsWith("\uFEFF") ? content : `\uFEFF${content}`;
    const blob = new Blob([bomContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = suggestedName.endsWith(".txt") ? suggestedName : `${suggestedName}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    return { saved: true, path: a.download };
  }
  return await invoke<SaveFileResult>("save_transcript_file", {
    suggestedName,
    content,
  });
}

export async function saveWavRecording(
  suggestedName: string,
  pcmSamples: Float32Array,
  sampleRate: number,
  fallbackWavBlob?: Blob
): Promise<SaveFileResult> {
  if (!isTauriRuntime()) {
    if (fallbackWavBlob) {
      const url = URL.createObjectURL(fallbackWavBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = suggestedName.endsWith(".wav") ? suggestedName : `${suggestedName}.wav`;
      a.click();
      URL.revokeObjectURL(url);
      return { saved: true, path: a.download };
    }
    return { saved: false, path: null };
  }
  return await invoke<SaveFileResult>("save_wav_recording", {
    suggestedName,
    pcmSamples: Array.from(pcmSamples),
    sampleRate: Math.round(sampleRate),
  });
}

export async function syncGlobalShortcuts(
  shortcuts: Record<string, string>
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("update_global_shortcuts", { shortcuts });
  } catch {
    // Ignore unsupported OS shortcut combinations
  }
}

export async function listenWaveformProgress(
  handler: (payload: WaveformProgressPayload) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return await listen<WaveformProgressPayload>("waveform://progress", (event) => {
    handler(event.payload);
  });
}

export async function listenShortcutActions(
  handler: (action: string) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return await listen<string>("shortcut://action", (event) => {
    handler(event.payload);
  });
}

export async function listenNativeFileDrop(
  onDropPath: (path: string) => void,
  onHoverChange?: (hovering: boolean) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  try {
    return await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "over" || event.payload.type === "enter") {
        onHoverChange?.(true);
      } else if (event.payload.type === "leave") {
        onHoverChange?.(false);
      } else if (event.payload.type === "drop") {
        onHoverChange?.(false);
        const firstPath = event.payload.paths?.[0];
        if (firstPath) {
          onDropPath(firstPath);
        }
      }
    });
  } catch {
    return () => {};
  }
}

export async function getUpdateState(): Promise<UpdateStatusInfo> {
  if (!isTauriRuntime()) {
    return {
      currentVersion: "1.0.0",
      available: false,
      latestVersion: "1.0.0",
      releaseNotes: null,
      releaseUrl: "https://github.com/MoshRadix/TimsStretch-3/releases/latest",
      installerUrl: null,
      downloaded: false,
      message: "Running in browser preview mode (v1.0.0).",
    };
  }
  return await invoke<UpdateStatusInfo>("get_update_state");
}

export async function checkForUpdates(): Promise<UpdateStatusInfo> {
  if (!isTauriRuntime()) {
    try {
      const res = await fetch(
        "https://api.github.com/repos/MoshRadix/TimsStretch-3/releases/latest"
      );
      if (res.ok) {
        const data = await res.json();
        const latest = String(data.tag_name || "1.0.0").replace(/^v/, "");
        const available = latest !== "1.0.0";
        return {
          currentVersion: "1.0.0",
          available,
          latestVersion: latest,
          releaseNotes: data.body ?? null,
          releaseUrl:
            data.html_url ||
            "https://github.com/MoshRadix/TimsStretch-3/releases/latest",
          installerUrl: null,
          downloaded: false,
          message: available
            ? `Mandatory update v${latest} is available.`
            : "You are running the latest version (v1.0.0).",
        };
      }
    } catch {
      // Fallback
    }
    return getUpdateState();
  }
  return await invoke<UpdateStatusInfo>("check_for_updates");
}

export async function installUpdateAndRestart(): Promise<UpdateStatusInfo> {
  const status = await invoke<UpdateStatusInfo>("install_update");
  await relaunch();
  return status;
}

export async function listenUpdateAvailable(
  handler: (payload: UpdateStatusInfo) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return await listen<UpdateStatusInfo>("update://available", (event) => {
    handler(event.payload);
  });
}

export async function listenUpdateProgress(
  handler: (payload: UpdateProgressPayload) => void
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return await listen<UpdateProgressPayload>("update://progress", (event) => {
    handler(event.payload);
  });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (!isTauriRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  try {
    await invoke("open_external_url", { url });
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
