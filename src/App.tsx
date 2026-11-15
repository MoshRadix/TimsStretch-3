import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_DSP_SETTINGS,
  DspSettings,
  MoshAudioEngine,
  OutputLevels,
} from "./audio/audio-engine";
import {
  CompletedRecording,
  LiveWavRecorder,
  RecorderStatus,
} from "./audio/wav-recorder";
import {
  AudioFileInfo,
  checkForUpdates,
  clearLastAudio,
  generateWaveform,
  getUpdateState,
  installUpdateAndRestart,
  listenNativeFileDrop,
  listenShortcutActions,
  listenUpdateAvailable,
  listenUpdateProgress,
  listenWaveformProgress,
  openAudioDialog,
  openExternalUrl,
  registerAudioPath,
  restoreLastAudio,
  savePlaybackPosition,
  saveTranscriptFile,
  saveWavRecording,
  syncGlobalShortcuts,
  UpdateStatusInfo,
} from "./bridge/tauri-bridge";
import { countWordsAndChars, mapKeyToThaana } from "./utils/thaana";
import releaseNotesMarkdown from "../RELEASE_NOTES.md?raw";

type ActivePage = "player" | "recorder";
type ThemeMode = "dark" | "light";
type LanguageMode = "en" | "dv";

interface ShortcutMap {
  playPause: string;
  seekBackward: string;
  seekForward: string;
  speedUp: string;
  speedDown: string;
  pitchDown: string;
  pitchUp: string;
  openSettings: string;
}

const DEFAULT_SHORTCUTS: ShortcutMap = {
  playPause: "Ctrl+Space",
  seekBackward: "Ctrl+Left",
  seekForward: "Ctrl+Right",
  speedUp: "Ctrl+Up",
  speedDown: "Ctrl+Down",
  pitchDown: "Ctrl+[",
  pitchUp: "Ctrl+]",
  openSettings: "Alt+,",
};

const SHORTCUT_LABELS: Record<keyof ShortcutMap, string> = {
  playPause: "Play / Pause",
  seekBackward: "Seek Backward (-3s)",
  seekForward: "Seek Forward (+3s)",
  speedUp: "Speed Up (+0.05×)",
  speedDown: "Speed Down (-0.05×)",
  pitchDown: "Pitch Down (-1 st)",
  pitchUp: "Pitch Up (+1 st)",
  openSettings: "Open Shortcuts & Settings",
};

const WAVEFORM_THEME_COLORS: Record<
  ThemeMode,
  { unplayed: string; played: string; bookmark: string; playhead: string }
> = {
  dark: {
    unplayed: "#2b3c56",
    played: "#22d3ee",
    bookmark: "#fbbf24",
    playhead: "#f8fafc",
  },
  light: {
    unplayed: "#cbd5e1",
    played: "#0d9488",
    bookmark: "#d97706",
    playhead: "#0f172a",
  },
};

function formatTime(sec: number, showTenths = false): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return showTenths ? "00:00.0" : "00:00";
  }
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  const wholeSecs = Math.floor(rem);
  const mm = String(mins).padStart(2, "0");
  const ss = String(wholeSecs).padStart(2, "0");
  if (!showTenths) {
    return `${mm}:${ss}`;
  }
  const tenths = Math.floor((rem - wholeSecs) * 10);
  return `${mm}:${ss}.${tenths}`;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function defaultWaveformBins(count = 512): number[] {
  return Array.from({ length: count }, (_, idx) => {
    const t = idx / count;
    return Math.max(
      0.08,
      Math.min(
        0.92,
        0.34 + 0.25 * Math.sin(t * Math.PI * 8) + 0.16 * Math.cos(t * Math.PI * 21)
      )
    );
  });
}

function bipolarFillVars(
  value: number,
  min: number,
  max: number
): React.CSSProperties {
  const span = max - min;
  const centerPct = ((0 - min) / span) * 100;
  const valPct = ((value - min) / span) * 100;
  const start = Math.min(centerPct, valPct);
  const width = Math.abs(valPct - centerPct);
  return {
    "--fill-start": `${start.toFixed(2)}%`,
    "--fill-width": `${width.toFixed(2)}%`,
  } as React.CSSProperties;
}

function unipolarFillVars(
  value: number,
  min: number,
  max: number
): React.CSSProperties {
  const pct = ((value - min) / (max - min)) * 100;
  return {
    "--slider-fill": `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`,
  } as React.CSSProperties;
}

function renderInlineMarkdown(text: string): React.ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return tokens.map((tok, i) => {
    if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) {
      return <strong key={i}>{tok.slice(2, -2)}</strong>;
    }
    if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) {
      return (
        <code key={i} className="rn-code">
          {tok.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={i}>{tok}</React.Fragment>;
  });
}

function FormattedReleaseNotes({ markdown }: { markdown: string }) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let listItems: { text: string; sub: boolean }[] = [];

  const flushList = (keyPrefix: string) => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul key={`list-${keyPrefix}`} className="rn-list">
        {listItems.map((item, idx) => (
          <li
            key={idx}
            className={item.sub ? "rn-subitem" : "rn-item"}
          >
            {renderInlineMarkdown(item.text)}
          </li>
        ))}
      </ul>
    );
    listItems = [];
  };

  lines.forEach((rawLine, idx) => {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList(`empty-${idx}`);
      return;
    }
    if (trimmed === "---") {
      flushList(`hr-${idx}`);
      blocks.push(<hr key={`hr-${idx}`} className="rn-divider" />);
      return;
    }
    if (trimmed.startsWith("#### ")) {
      flushList(`h4-${idx}`);
      blocks.push(
        <h4 key={`h4-${idx}`} className="rn-h4">
          {renderInlineMarkdown(trimmed.slice(5))}
        </h4>
      );
      return;
    }
    if (trimmed.startsWith("### ")) {
      flushList(`h3-${idx}`);
      blocks.push(
        <h3 key={`h3-${idx}`} className="rn-h3">
          {renderInlineMarkdown(trimmed.slice(4))}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList(`h2-${idx}`);
      blocks.push(
        <h2 key={`h2-${idx}`} className="rn-h2">
          {renderInlineMarkdown(trimmed.slice(3))}
        </h2>
      );
      return;
    }
    if (trimmed.startsWith("# ")) {
      flushList(`h1-${idx}`);
      blocks.push(
        <h1 key={`h1-${idx}`} className="rn-h1">
          {renderInlineMarkdown(trimmed.slice(2))}
        </h1>
      );
      return;
    }
    const bulletMatch = rawLine.match(/^(\s*)[-*]\s+(.+)$/);
    if (bulletMatch) {
      const indent = bulletMatch[1].length;
      listItems.push({
        text: bulletMatch[2],
        sub: indent >= 2,
      });
      return;
    }
    flushList(`p-${idx}`);
    blocks.push(
      <p key={`p-${idx}`} className="rn-p">
        {renderInlineMarkdown(trimmed)}
      </p>
    );
  });

  flushList("end");
  return <>{blocks}</>;
}

export default function App() {
  // Navigation, Theme, and Modals
  const [activePage, setActivePage] = useState<ActivePage>("player");
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("m0sh-theme-v2");
    return saved === "dark" ? "dark" : "light";
  });
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [aboutModalOpen, setAboutModalOpen] = useState(false);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [clearTranscriptModalOpen, setClearTranscriptModalOpen] = useState(false);

  // Audio Track & Playback State
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const engineRef = useRef<MoshAudioEngine | null>(null);
  const [currentTrack, setCurrentTrack] = useState<AudioFileInfo | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isDragOver, setIsDragOver] = useState(false);

  // Waveform State
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>(() =>
    defaultWaveformBins(512)
  );
  const [waveformLoadingProgress, setWaveformLoadingProgress] = useState<number | null>(
    null
  );
  const [hoverTime, setHoverTime] = useState<{ x: number; time: number } | null>(
    null
  );
  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isScrubbingWaveformRef = useRef(false);

  // DSP Settings & Bookmarks
  const [dsp, setDsp] = useState<DspSettings>({ ...DEFAULT_DSP_SETTINGS });
  const [bookmarks, setBookmarks] = useState<number[]>([]);
  const [outputLevels] = useState<OutputLevels>({
    rmsDb: -60,
    peakDb: -60,
    percent: 0,
  });
  const outputMeterFillRef = useRef<HTMLDivElement | null>(null);
  const outputMeterReadoutRef = useRef<HTMLSpanElement | null>(null);
  const currentTimeRef = useRef<number>(0);

  // Bilingual Transcription Editor State
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const selectionRef = useRef<{
    start: number;
    end: number;
    direction: "forward" | "backward" | "none";
  }>({ start: 0, end: 0, direction: "none" });
  const [langMode, setLangMode] = useState<LanguageMode>("dv");
  const [fontSize, setFontSize] = useState<number>(16);
  const [transcript, setTranscript] = useState<string>(() => {
    return localStorage.getItem("m0sh-transcript:default") ?? "";
  });
  const [copiedBanner, setCopiedBanner] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>("Ready · 100% Local On-Device");
  const autosaveTimerRef = useRef<number | null>(null);

  // Shortcuts & Self-Updater State
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(() => {
    try {
      const raw = localStorage.getItem("m0sh-shortcuts");
      if (raw) {
        return { ...DEFAULT_SHORTCUTS, ...JSON.parse(raw) };
      }
    } catch {
      // Fallback
    }
    return { ...DEFAULT_SHORTCUTS };
  });
  const [capturingShortcutKey, setCapturingShortcutKey] =
    useState<keyof ShortcutMap | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusInfo>({
    currentVersion: "1.0.0",
    available: false,
    latestVersion: "1.0.0",
    releaseNotes: null,
    releaseUrl: "https://github.com/MoshRadix/TimsStretch-3/releases/latest",
    downloaded: false,
    message: "Checking for updates...",
  });
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [updateProgressPercent, setUpdateProgressPercent] = useState(0);
  const [updateProgressMessage, setUpdateProgressMessage] = useState("");
  const [updateInstallError, setUpdateInstallError] = useState<string | null>(null);
  const hasTriggeredForcedUpdateRef = useRef(false);

  // Live WAV Recorder State
  const recorderRef = useRef<LiveWavRecorder | null>(null);
  const [recorderStatus, setRecorderStatus] = useState<RecorderStatus>("ready");
  const [recorderElapsed, setRecorderElapsed] = useState(0);
  const [recorderMeterBars, setRecorderMeterBars] = useState<number[]>(() =>
    Array(72).fill(4)
  );
  const [recorderDb, setRecorderDb] = useState<{ rmsDb: number; peakDb: number }>({
    rmsDb: -60,
    peakDb: -60,
  });
  const [recorderLevelPercent, setRecorderLevelPercent] = useState(0);
  const [recorderPeakPercent, setRecorderPeakPercent] = useState(0);
  const [recorderClipping, setRecorderClipping] = useState(false);
  const [micGainPercent, setMicGainPercent] = useState<number>(() => {
    const saved = Number(localStorage.getItem("m0sh-mic-gain"));
    return Number.isFinite(saved) && saved >= 25 && saved <= 400 ? saved : 150;
  });
  const [completedRecording, setCompletedRecording] =
    useState<CompletedRecording | null>(null);
  const [isRecordingSaved, setIsRecordingSaved] = useState(false);
  const [replaceModalOpen, setReplaceModalOpen] = useState(false);
  const [recordingFilename, setRecordingFilename] = useState<string>(() => {
    const today = new Date().toISOString().slice(0, 10);
    return `m0sh-recording-${today}.wav`;
  });

  // Apply Theme Attribute
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("m0sh-theme-v2", theme);
  }, [theme]);

  // Continuous Transcription Editor Focus Preservation
  const restoreEditorFocus = useCallback(() => {
    if (
      activePage !== "player" ||
      settingsModalOpen ||
      aboutModalOpen ||
      releaseNotesOpen ||
      clearTranscriptModalOpen
    ) {
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (!editorRef.current) return;
      editorRef.current.focus({ preventScroll: true });
      const maxLen = editorRef.current.value.length;
      const start = Math.min(selectionRef.current.start, maxLen);
      const end = Math.min(selectionRef.current.end, maxLen);
      try {
        editorRef.current.setSelectionRange(
          start,
          end,
          selectionRef.current.direction
        );
      } catch {
        // Ignore selection range errors
      }
    });
  }, [
    activePage,
    settingsModalOpen,
    aboutModalOpen,
    releaseNotesOpen,
    clearTranscriptModalOpen,
  ]);

  useEffect(() => {
    restoreEditorFocus();
  }, [restoreEditorFocus]);

  useEffect(() => {
    const handleGlobalPointerUp = (ev: PointerEvent) => {
      if (
        activePage !== "player" ||
        settingsModalOpen ||
        aboutModalOpen ||
        releaseNotesOpen ||
        clearTranscriptModalOpen
      )
        return;
      const target = ev.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(".modal-backdrop") ||
        target.tagName === "TEXTAREA" ||
        (target.tagName === "INPUT" &&
          (target as HTMLInputElement).type === "text") ||
        target.tagName === "SELECT"
      ) {
        return;
      }
      restoreEditorFocus();
    };
    window.addEventListener("pointerup", handleGlobalPointerUp);
    return () => window.removeEventListener("pointerup", handleGlobalPointerUp);
  }, [
    activePage,
    settingsModalOpen,
    aboutModalOpen,
    releaseNotesOpen,
    clearTranscriptModalOpen,
    restoreEditorFocus,
  ]);

  // Compute unique storage key per file
  const currentFileKey = useMemo(() => {
    if (!currentTrack) return "default";
    return `${currentTrack.path}:${currentTrack.size}`;
  }, [currentTrack]);

  // Debounced 300ms Transcript Autosave
  useEffect(() => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      localStorage.setItem("m0sh-transcript:default", transcript);
      localStorage.setItem(`m0sh-transcript:${currentFileKey}`, transcript);
      const nowStr = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      setStatusMessage(`Autosaved locally at ${nowStr}`);
    }, 300);

    return () => {
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
      }
    };
  }, [transcript, currentFileKey]);

  // Persist per-file DSP, Bookmarks & Transcription Language Mode
  useEffect(() => {
    if (!currentTrack) return;
    localStorage.setItem(
      `m0sh-dsp:${currentFileKey}`,
      JSON.stringify({ dsp, bookmarks, langMode })
    );
    localStorage.setItem(`m0sh-lang:${currentFileKey}`, langMode);
  }, [dsp, bookmarks, langMode, currentTrack, currentFileKey]);

  // Initialize Web Audio Engine
  useEffect(() => {
    if (!audioRef.current) return;
    engineRef.current = new MoshAudioEngine(audioRef.current);
  }, []);

  // Sync DSP Settings into Audio Engine
  useEffect(() => {
    engineRef.current?.applyAllSettings(dsp);
  }, [dsp]);

  // Load Track Helper
  const loadAudioFileInfo = useCallback(
    async (info: AudioFileInfo, initialPosition = 0) => {
      const fileKey = `${info.path}:${info.size}`;
      setCurrentTrack(info);
      setIsPlaying(false);
      setCurrentTime(initialPosition);

      // Restore per-file DSP, Bookmarks & Language Mode (defaults to Dhivehi 'dv')
      const savedLang = localStorage.getItem(`m0sh-lang:${fileKey}`);
      if (savedLang === "en" || savedLang === "dv") {
        setLangMode(savedLang);
      } else {
        setLangMode("dv");
      }

      try {
        const savedMeta = localStorage.getItem(`m0sh-dsp:${fileKey}`);
        if (savedMeta) {
          const parsed = JSON.parse(savedMeta);
          if (parsed.dsp) setDsp({ ...DEFAULT_DSP_SETTINGS, ...parsed.dsp });
          if (Array.isArray(parsed.bookmarks)) setBookmarks(parsed.bookmarks);
          if (
            !savedLang &&
            (parsed.langMode === "en" || parsed.langMode === "dv")
          ) {
            setLangMode(parsed.langMode);
          }
        } else {
          setBookmarks([]);
        }
      } catch {
        setBookmarks([]);
      }

      // Restore per-file Transcript if present
      const savedTranscript = localStorage.getItem(`m0sh-transcript:${fileKey}`);
      if (savedTranscript !== null && savedTranscript.length > 0) {
        setTranscript(savedTranscript);
      }

      if (audioRef.current) {
        audioRef.current.src = info.streamUrl;
        audioRef.current.load();
        const onLoaded = () => {
          if (audioRef.current && initialPosition > 0) {
            audioRef.current.currentTime = Math.min(
              initialPosition,
              audioRef.current.duration || initialPosition
            );
          }
          engineRef.current?.applyAllSettings(dsp);
          audioRef.current?.removeEventListener("loadedmetadata", onLoaded);
        };
        audioRef.current.addEventListener("loadedmetadata", onLoaded);
      }

      setWaveformLoadingProgress(0.02);
      try {
        const peaks = await generateWaveform(info.path, 512);
        if (peaks && peaks.length > 0) {
          setWaveformPeaks(peaks);
        }
      } catch {
        setWaveformPeaks(defaultWaveformBins(512));
      } finally {
        setWaveformLoadingProgress(null);
      }
    },
    [dsp]
  );

  // Startup Restoration, Waveform Progress Listener, Native File Drop & Mandatory Self-Updater
  const triggerForcedSelfUpdate = useCallback(
    async (status: UpdateStatusInfo) => {
      if (!status.available) return;

      // Safely pause playback and persist current playhead & transcript before restarting
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
        setIsPlaying(false);
        void savePlaybackPosition(audioRef.current.currentTime);
      }

      setIsInstallingUpdate(true);
      setUpdateInstallError(null);
      setUpdateProgressPercent((prev) => Math.max(prev, 8));
      setUpdateProgressMessage(
        `Downloading & installing mandatory update v${status.latestVersion ?? ""}...`
      );

      try {
        await installUpdateAndRestart();
      } catch (err) {
        setIsInstallingUpdate(false);
        setUpdateInstallError(
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    []
  );

  useEffect(() => {
    let unlistenWave: (() => void) | null = null;
    let unlistenDrop: (() => void) | null = null;
    let unlistenUpdateAvail: (() => void) | null = null;
    let unlistenUpdateProg: (() => void) | null = null;

    const runAutoUpdateCheck = async () => {
      try {
        const st = await checkForUpdates();
        setUpdateStatus(st);
        if (st.available && !hasTriggeredForcedUpdateRef.current) {
          hasTriggeredForcedUpdateRef.current = true;
          void triggerForcedSelfUpdate(st);
        }
      } catch {
        // Ignore transient network errors during background poll
      }
    };

    (async () => {
      unlistenWave = await listenWaveformProgress((payload) => {
        if (payload.partialPeaks?.length) {
          setWaveformPeaks(payload.partialPeaks);
        }
        setWaveformLoadingProgress(
          payload.progress >= 0.999 ? null : payload.progress
        );
      });

      unlistenDrop = await listenNativeFileDrop(
        async (droppedPath) => {
          if (!/\.(mp3|wav)$/i.test(droppedPath)) return;
          try {
            const info = await registerAudioPath(droppedPath);
            await loadAudioFileInfo(info, 0);
          } catch {
            // Ignore invalid drop
          }
        },
        (hovering) => setIsDragOver(hovering)
      );

      unlistenUpdateAvail = await listenUpdateAvailable((payload) => {
        setUpdateStatus(payload);
        if (payload.available && !hasTriggeredForcedUpdateRef.current) {
          hasTriggeredForcedUpdateRef.current = true;
          void triggerForcedSelfUpdate(payload);
        }
      });

      unlistenUpdateProg = await listenUpdateProgress((payload) => {
        setUpdateProgressPercent(payload.percent);
        setUpdateProgressMessage(payload.message);
      });

      const restored = await restoreLastAudio();
      if (restored) {
        await loadAudioFileInfo(restored, restored.position || 0);
      }

      const upState = await getUpdateState();
      setUpdateStatus(upState);
      if (upState.available && !hasTriggeredForcedUpdateRef.current) {
        hasTriggeredForcedUpdateRef.current = true;
        void triggerForcedSelfUpdate(upState);
      } else {
        await runAutoUpdateCheck();
      }
    })();

    // Re-check for new releases periodically (every 10 minutes) and when window regains focus
    const pollInterval = window.setInterval(() => {
      void runAutoUpdateCheck();
    }, 10 * 60 * 1000);

    const onWindowFocus = () => {
      void runAutoUpdateCheck();
    };
    window.addEventListener("focus", onWindowFocus);

    return () => {
      window.clearInterval(pollInterval);
      window.removeEventListener("focus", onWindowFocus);
      unlistenWave?.();
      unlistenDrop?.();
      unlistenUpdateAvail?.();
      unlistenUpdateProg?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync Shortcuts to Rust Global Shortcut Plugin & LocalStorage
  useEffect(() => {
    localStorage.setItem("m0sh-shortcuts", JSON.stringify(shortcuts));
    void syncGlobalShortcuts(shortcuts as unknown as Record<string, string>);
  }, [shortcuts]);

  // Transport Actions
  const handleTogglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    await engineRef.current?.ensureInitialized();
    engineRef.current?.applyAllSettings(dsp);

    if (audio.paused) {
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    } else {
      audio.pause();
      setIsPlaying(false);
      void savePlaybackPosition(audio.currentTime);
    }
    restoreEditorFocus();
  }, [currentTrack, dsp, restoreEditorFocus]);

  const handleStopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.currentTime = 0;
    setCurrentTime(0);
    setIsPlaying(false);
    void savePlaybackPosition(0);
    restoreEditorFocus();
  }, [restoreEditorFocus]);

  const handleSeekRelative = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current;
      if (!audio || !currentTrack) return;
      const target = Math.max(
        0,
        Math.min(audio.duration || duration || 0, audio.currentTime + deltaSeconds)
      );
      audio.currentTime = target;
      setCurrentTime(target);
      void savePlaybackPosition(target);
      restoreEditorFocus();
    },
    [currentTrack, duration, restoreEditorFocus]
  );

  const handleSeekToRatio = useCallback(
    (ratio: number) => {
      const audio = audioRef.current;
      if (!audio || !currentTrack) return;
      const total = audio.duration || duration || 0;
      if (total <= 0) return;
      const target = Math.max(0, Math.min(total, ratio * total));
      audio.currentTime = target;
      setCurrentTime(target);
    },
    [currentTrack, duration]
  );

  // Listen to Global OS Shortcut Events & In-App Keybindings
  const executeShortcutAction = useCallback(
    (action: string) => {
      switch (action) {
        case "toggle-play":
          void handleTogglePlay();
          break;
        case "seek-backward":
          handleSeekRelative(-3);
          break;
        case "seek-forward":
          handleSeekRelative(3);
          break;
        case "speed-up":
          setDsp((prev) => ({
            ...prev,
            speed: Math.min(2.0, Number((prev.speed + 0.05).toFixed(2))),
          }));
          break;
        case "speed-down":
          setDsp((prev) => ({
            ...prev,
            speed: Math.max(0.5, Number((prev.speed - 0.05).toFixed(2))),
          }));
          break;
        case "pitch-up":
          setDsp((prev) => ({
            ...prev,
            pitchSemitones: Math.min(12, prev.pitchSemitones + 1),
          }));
          break;
        case "pitch-down":
          setDsp((prev) => ({
            ...prev,
            pitchSemitones: Math.max(-12, prev.pitchSemitones - 1),
          }));
          break;
        case "open-settings":
          setSettingsModalOpen((v) => !v);
          break;
      }
    },
    [handleTogglePlay, handleSeekRelative]
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listenShortcutActions((action) => {
      executeShortcutAction(action);
    }).then((fn) => {
      unlisten = fn;
    });
    return () => {
      unlisten?.();
    };
  }, [executeShortcutAction]);

  // Format KeyboardEvent into combo string (e.g. "Ctrl+Space", "Alt+,")
  const formatKeyEventCombo = (e: KeyboardEvent | React.KeyboardEvent): string => {
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");

    let keyName = e.key;
    if (keyName === " ") keyName = "Space";
    else if (keyName.startsWith("Arrow")) keyName = keyName.replace("Arrow", "");
    else if (keyName.length === 1) keyName = keyName.toUpperCase();

    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
      return parts.join("+");
    }
    parts.push(keyName);
    return parts.join("+");
  };

  useEffect(() => {
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (capturingShortcutKey) return;
      const combo = formatKeyEventCombo(e);
      if (!combo) return;

      const entries: [keyof ShortcutMap, string][] = [
        ["playPause", "toggle-play"],
        ["seekBackward", "seek-backward"],
        ["seekForward", "seek-forward"],
        ["speedUp", "speed-up"],
        ["speedDown", "speed-down"],
        ["pitchDown", "pitch-down"],
        ["pitchUp", "pitch-up"],
        ["openSettings", "open-settings"],
      ];

      for (const [k, act] of entries) {
        if (shortcuts[k].toLowerCase() === combo.toLowerCase()) {
          // Avoid hijacking plain Space inside the textarea
          if (
            combo.toLowerCase() === "space" &&
            document.activeElement === editorRef.current
          ) {
            continue;
          }
          e.preventDefault();
          executeShortcutAction(act);
          return;
        }
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [shortcuts, capturingShortcutKey, executeShortcutAction]);

  // 60fps Canvas Waveform Renderer & Zero-Lag Output Level Meter Loop
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  useEffect(() => {
    let rafId = 0;
    let lastStateTimeUpdateMs = 0;
    let lastReadoutUpdateMs = 0;
    let lastDrawnTime = -1;
    let lastDrawnW = 0;
    let lastDrawnH = 0;
    let wasPaused = true;

    const renderFrame = (nowMs: number) => {
      const audio = audioRef.current;
      const isPaused = !audio || audio.paused;

      if (!isPaused && engineRef.current) {
        const curT = audio.currentTime;
        currentTimeRef.current = curT;

        // Throttle React state updates for MM:SS readout (~8 Hz) so 60fps meter/canvas never blocks on full React tree re-renders
        if (nowMs - lastStateTimeUpdateMs >= 120) {
          lastStateTimeUpdateMs = nowMs;
          setCurrentTime(curT);
        }

        const levels = engineRef.current.getOutputLevels();
        if (outputMeterFillRef.current) {
          outputMeterFillRef.current.style.width = `${levels.percent.toFixed(1)}%`;
        }
        if (outputMeterReadoutRef.current && nowMs - lastReadoutUpdateMs >= 50) {
          lastReadoutUpdateMs = nowMs;
          outputMeterReadoutRef.current.textContent = `RMS ${levels.rmsDb.toFixed(1)} dB · Peak ${levels.peakDb.toFixed(1)} dB`;
        }
        wasPaused = false;
      } else if (!wasPaused) {
        wasPaused = true;
        if (outputMeterFillRef.current) {
          outputMeterFillRef.current.style.width = "0%";
        }
        if (outputMeterReadoutRef.current) {
          outputMeterReadoutRef.current.textContent = "RMS -60.0 dB · Peak -60.0 dB";
        }
      }

      const canvas = waveformCanvasRef.current;
      if (canvas) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const targetW = Math.max(1, Math.floor(rect.width * dpr));
        const targetH = Math.max(1, Math.floor(rect.height * dpr));
        const curTime = audio && !audio.paused ? audio.currentTime : currentTimeRef.current;

        const sizeChanged = targetW !== lastDrawnW || targetH !== lastDrawnH;
        const timeChanged = Math.abs(curTime - lastDrawnTime) > 0.002;

        if (sizeChanged || timeChanged || !isPaused) {
          lastDrawnW = targetW;
          lastDrawnH = targetH;
          lastDrawnTime = curTime;

          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.save();
            ctx.scale(dpr, dpr);
            const w = rect.width;
            const h = rect.height;
            ctx.clearRect(0, 0, w, h);

            // Cached theme palette (never calls getComputedStyle per frame)
            const palette = WAVEFORM_THEME_COLORS[theme];
            const bins = waveformPeaks.length || 512;
            const totalDur = audio?.duration || duration || 0;
            const progressRatio =
              totalDur > 0 ? Math.max(0, Math.min(1, curTime / totalDur)) : 0;

            const barStep = w / bins;
            const barWidth = Math.max(1.2, barStep * 0.66);
            const midY = h / 2;

            for (let i = 0; i < bins; i++) {
              const amp = Math.max(0.05, Math.min(1.0, waveformPeaks[i] ?? 0.1));
              const barH = Math.max(4, amp * (h - 14));
              const x = i * barStep + (barStep - barWidth) * 0.5;
              const y = midY - barH * 0.5;
              const binRatio = (i + 0.5) / bins;

              ctx.fillStyle =
                binRatio <= progressRatio ? palette.played : palette.unplayed;
              ctx.beginPath();
              ctx.roundRect(x, y, barWidth, barH, 1.5);
              ctx.fill();
            }

            // Bookmark Pins with Top Triangles
            if (totalDur > 0 && bookmarks.length > 0) {
              ctx.fillStyle = palette.bookmark;
              ctx.strokeStyle = palette.bookmark;
              ctx.lineWidth = 1.5;
              for (const bm of bookmarks) {
                const bx = Math.max(2, Math.min(w - 2, (bm / totalDur) * w));
                ctx.beginPath();
                ctx.moveTo(bx, 0);
                ctx.lineTo(bx, h);
                ctx.stroke();

                ctx.beginPath();
                ctx.moveTo(bx - 4, 0);
                ctx.lineTo(bx + 4, 0);
                ctx.lineTo(bx, 6);
                ctx.closePath();
                ctx.fill();
              }
            }

            // Crisp Playhead Line
            if (totalDur > 0) {
              const px = Math.max(1, Math.min(w - 1, progressRatio * w));
              ctx.strokeStyle = palette.playhead;
              ctx.lineWidth = 1.8;
              ctx.beginPath();
              ctx.moveTo(px, 0);
              ctx.lineTo(px, h);
              ctx.stroke();
            }

            ctx.restore();
          }
        }
      }

      rafId = requestAnimationFrame(renderFrame);
    };

    rafId = requestAnimationFrame(renderFrame);
    return () => cancelAnimationFrame(rafId);
  }, [theme, waveformPeaks, bookmarks, duration, activePage]);

  // Open Audio File Dialog or Browser Fallback
  const handleOpenAudioClick = async () => {
    const info = await openAudioDialog();
    if (info) {
      await loadAudioFileInfo(info, 0);
      restoreEditorFocus();
      return;
    }

    // Fallback file input when running in standalone browser dev mode
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".mp3,.wav,audio/mpeg,audio/wav";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      await loadAudioFileInfo(
        {
          name: file.name,
          path: file.name,
          size: file.size,
          mtimeMs: file.lastModified,
          streamUrl: url,
        },
        0
      );
      restoreEditorFocus();
    };
    input.click();
  };

  const handleUnloadAudio = async () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }
    setCurrentTrack(null);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBookmarks([]);
    setWaveformPeaks(defaultWaveformBins(512));
    await clearLastAudio();
    restoreEditorFocus();
  };

  // Phonetic Thaana Key Interception in Dhivehi ('dv') Mode
  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (langMode !== "dv") return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    const mapped = mapKeyToThaana(e.key);
    if (!mapped) return;

    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart ?? transcript.length;
    const end = el.selectionEnd ?? transcript.length;
    const nextValue =
      transcript.slice(0, start) + mapped + transcript.slice(end);
    const nextCursor = start + mapped.length;

    selectionRef.current = {
      start: nextCursor,
      end: nextCursor,
      direction: "none",
    };
    setTranscript(nextValue);

    requestAnimationFrame(() => {
      if (editorRef.current) {
        editorRef.current.setSelectionRange(nextCursor, nextCursor);
      }
    });
  };

  const handleInsertTimestamp = () => {
    const exactTime = audioRef.current?.currentTime ?? currentTime;
    const stamp = `[${formatTime(exactTime)}] `;
    const el = editorRef.current;
    const start = el ? el.selectionStart : selectionRef.current.start;
    const end = el ? el.selectionEnd : selectionRef.current.end;
    const nextText =
      transcript.slice(0, start) + stamp + transcript.slice(end);
    const nextPos = start + stamp.length;
    selectionRef.current = {
      start: nextPos,
      end: nextPos,
      direction: "none",
    };
    setTranscript(nextText);
    restoreEditorFocus();
  };

  const handleCopyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcript);
      setCopiedBanner(true);
      window.setTimeout(() => setCopiedBanner(false), 2000);
    } catch {
      // Ignore clipboard permission errors
    }
    restoreEditorFocus();
  };

  const handleSaveTranscriptTxt = async () => {
    const baseTrack = currentTrack
      ? currentTrack.name.replace(/\.[^.]+$/, "")
      : "m0sh";
    const suggested = `${baseTrack}-transcript.txt`;
    const result = await saveTranscriptFile(suggested, transcript);
    if (result.saved && result.path) {
      setStatusMessage(`Saved UTF-8 BOM transcript: ${result.path}`);
    }
    restoreEditorFocus();
  };

  // Live WAV Recorder Handlers & Real-Time Mic Gain Sync
  useEffect(() => {
    localStorage.setItem("m0sh-mic-gain", String(micGainPercent));
    recorderRef.current?.setMicGain(micGainPercent / 100);
  }, [micGainPercent]);

  useEffect(() => {
    if (activePage !== "recorder") {
      if (recorderStatus !== "recording" && recorderStatus !== "paused") {
        void recorderRef.current?.cleanupStream();
        setRecorderLevelPercent(0);
        setRecorderPeakPercent(0);
        setRecorderClipping(false);
      }
      return;
    }

    if (!recorderRef.current) {
      recorderRef.current = new LiveWavRecorder();
    }
    recorderRef.current.setMicGain(micGainPercent / 100);

    if (recorderStatus === "ready" || recorderStatus === "stopped") {
      void recorderRef.current
        .startMonitoring((frame) => {
          setRecorderDb({ rmsDb: frame.rmsDb, peakDb: frame.peakDb });
          setRecorderLevelPercent(frame.percent);
          setRecorderPeakPercent(frame.peakPercent);
          setRecorderClipping(frame.clipping);
          setRecorderMeterBars((prev) => [
            ...prev.slice(1),
            Math.max(4, Math.round(frame.percent)),
          ]);
        })
        .catch(() => {
          // Wait for explicit Start Recording click if permission not yet granted
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage]);

  const startNewRecordingSession = async () => {
    setReplaceModalOpen(false);
    if (!recorderRef.current) {
      recorderRef.current = new LiveWavRecorder();
    }
    recorderRef.current.setMicGain(micGainPercent / 100);
    try {
      setRecorderElapsed(0);
      setRecorderMeterBars(Array(72).fill(4));
      await recorderRef.current.start((frame) => {
        setRecorderElapsed(frame.elapsedSeconds);
        setRecorderDb({ rmsDb: frame.rmsDb, peakDb: frame.peakDb });
        setRecorderLevelPercent(frame.percent);
        setRecorderPeakPercent(frame.peakPercent);
        setRecorderClipping(frame.clipping);
        setRecorderMeterBars((prev) => [
          ...prev.slice(1),
          Math.max(4, Math.round(frame.percent)),
        ]);
      });
      setRecorderStatus("recording");
      setIsRecordingSaved(false);
    } catch (err) {
      setStatusMessage(`Microphone access failed: ${String(err)}`);
    }
  };

  const handleStartRecordingClick = async () => {
    if (completedRecording && !isRecordingSaved) {
      setReplaceModalOpen(true);
      return;
    }
    await startNewRecordingSession();
  };

  const handleStopRecordingClick = async () => {
    if (!recorderRef.current) return;
    const result = await recorderRef.current.stop();
    setCompletedRecording(result);
    setRecorderStatus("stopped");
    setIsRecordingSaved(false);
  };

  const handleSaveCompletedWav = async (): Promise<string | null> => {
    if (!completedRecording) return null;
    const res = await saveWavRecording(
      recordingFilename,
      completedRecording.pcmSamples,
      completedRecording.sampleRate,
      completedRecording.wavBlob
    );
    if (res.saved) {
      setIsRecordingSaved(true);
      if (res.path) {
        setStatusMessage(`Saved WAV recording: ${res.path}`);
      }
      return res.path;
    }
    return null;
  };

  const handleSaveAndStartNewRecording = async () => {
    const savedPath = await handleSaveCompletedWav();
    if (savedPath !== null) {
      await startNewRecordingSession();
    }
  };

  const handleOpenRecordingInPlayer = async () => {
    if (!completedRecording) return;
    let savedPath = isRecordingSaved ? null : await handleSaveCompletedWav();
    if (savedPath) {
      try {
        const info = await registerAudioPath(savedPath);
        setActivePage("player");
        await loadAudioFileInfo(info, 0);
        return;
      } catch {
        // Fallback to object URL below
      }
    }
    setActivePage("player");
    await loadAudioFileInfo(
      {
        name: recordingFilename,
        path: savedPath || recordingFilename,
        size: completedRecording.wavBlob.size,
        mtimeMs: Date.now(),
        streamUrl: completedRecording.objectUrl,
      },
      0
    );
  };

  // Self-Update Check Handler
  const handleCheckForUpdates = async () => {
    setIsCheckingUpdate(true);
    try {
      const st = await checkForUpdates();
      setUpdateStatus(st);
      if (st.available) {
        hasTriggeredForcedUpdateRef.current = true;
        void triggerForcedSelfUpdate(st);
      }
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const { words, chars } = useMemo(
    () => countWordsAndChars(transcript),
    [transcript]
  );

  return (
    <div className="app-shell">
      {/* Hidden HTML5 Audio Element */}
      <audio
        ref={audioRef}
        loop={loopEnabled}
        crossOrigin="anonymous"
        onTimeUpdate={(e) => {
          const t = e.currentTarget.currentTime;
          setCurrentTime(t);
        }}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
        }}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={() => {
          if (!loopEnabled) setIsPlaying(false);
        }}
      />

      {/* Top Bar with Polished M0SH Brand Identity */}
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-crest" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect
                x="2"
                y="5"
                width="2.2"
                height="6"
                rx="1.1"
                fill="var(--accent-primary)"
              />
              <rect
                x="5.3"
                y="2.5"
                width="2.2"
                height="11"
                rx="1.1"
                fill="var(--accent-primary)"
              />
              <rect
                x="8.6"
                y="4"
                width="2.2"
                height="8"
                rx="1.1"
                fill="var(--accent-slash)"
              />
              <rect
                x="11.9"
                y="6"
                width="2.2"
                height="4"
                rx="1.1"
                fill="var(--accent-primary)"
              />
            </svg>
          </div>
          <div className="brand-wordmark">
            <span>M</span>
            <span className="brand-zero">
              0<span className="brand-zero-slash" />
            </span>
            <span>SH</span>
          </div>
          <span className="brand-badge">TIMESTRETCH 3</span>
        </div>

        <div className="topbar-right">
          {updateStatus.available && (
            <button
              type="button"
              className="update-pill"
              onClick={() => setAboutModalOpen(true)}
            >
              Update v{updateStatus.latestVersion} Available
            </button>
          )}
          <span className="status-pill">
            {activePage === "player"
              ? "Player & Transcribe"
              : "Live WAV Recorder"}
          </span>
          <button
            type="button"
            className="topbar-btn"
            onClick={() => setSettingsModalOpen(true)}
          >
            Shortcuts
          </button>
          <button
            type="button"
            className="topbar-btn"
            onClick={() => setAboutModalOpen(true)}
          >
            About
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* Left Compact Icon Navigation Rail (52px) */}
        <aside className="nav-rail">
          <div className="rail-group">
            <button
              type="button"
              className={`rail-btn ${activePage === "player" ? "active" : ""}`}
              title="Player & Transcribe Studio"
              onClick={() => setActivePage("player")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            </button>
            <button
              type="button"
              className={`rail-btn ${activePage === "recorder" ? "active" : ""}`}
              title="Live WAV Recording Studio"
              onClick={() => setActivePage("recorder")}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
          </div>

          <div className="rail-group">
            <button
              type="button"
              className="rail-btn"
              title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Theme`}
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="5" />
                  <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
            <button
              type="button"
              className="rail-btn"
              title="Keyboard Shortcuts & Settings"
              onClick={() => setSettingsModalOpen(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <button
              type="button"
              className="rail-btn"
              title="About & Updates"
              onClick={() => setAboutModalOpen(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            </button>
          </div>
        </aside>

        {/* Main Workspace Content */}
        {activePage === "player" ? (
          <main className="workspace-grid">
            {/* A. Sound Controls Sidebar (305px) */}
            <section className="sound-sidebar">
              {/* 1. Playback Speed Card */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">Playback Speed</span>
                  <span className="value-badge">{dsp.speed.toFixed(2)}×</span>
                </div>
                <input
                  type="range"
                  className="unipolar-slider"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={dsp.speed}
                  style={unipolarFillVars(dsp.speed, 0.5, 2.0)}
                  onChange={(e) =>
                    setDsp((prev) => ({
                      ...prev,
                      speed: parseFloat(e.target.value),
                    }))
                  }
                />
                <div className="preset-grid-4">
                  {[0.75, 1.0, 1.25, 1.5].map((spd) => (
                    <button
                      key={spd}
                      type="button"
                      className={`preset-pill ${Math.abs(dsp.speed - spd) < 0.01 ? "active" : ""
                        }`}
                      onClick={() =>
                        setDsp((prev) => ({ ...prev, speed: spd }))
                      }
                    >
                      {spd}×
                    </button>
                  ))}
                </div>
              </div>

              {/* 2. Pitch Shift Card */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">Pitch Shift</span>
                  <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                    <span className="value-badge">
                      {dsp.pitchSemitones > 0
                        ? `+${dsp.pitchSemitones} st`
                        : `${dsp.pitchSemitones} st`}
                    </span>
                    <button
                      type="button"
                      className="mini-reset-btn"
                      onClick={() =>
                        setDsp((prev) => ({ ...prev, pitchSemitones: 0 }))
                      }
                    >
                      0 st
                    </button>
                  </div>
                </div>
                <input
                  type="range"
                  className="bipolar-slider"
                  min={-12}
                  max={12}
                  step={1}
                  value={dsp.pitchSemitones}
                  style={bipolarFillVars(dsp.pitchSemitones, -12, 12)}
                  onChange={(e) =>
                    setDsp((prev) => ({
                      ...prev,
                      pitchSemitones: parseInt(e.target.value, 10),
                    }))
                  }
                />
                <div className="preset-grid-7">
                  {[-4, -2, -1, 0, 1, 2, 4].map((st) => (
                    <button
                      key={st}
                      type="button"
                      className={`preset-pill ${dsp.pitchSemitones === st ? "active" : ""
                        }`}
                      onClick={() =>
                        setDsp((prev) => ({ ...prev, pitchSemitones: st }))
                      }
                    >
                      {st > 0 ? `+${st}` : `${st}`}
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. Volume Control Card */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">Volume Control</span>
                  <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                    <span className="value-badge">
                      {dsp.muted ? "Muted" : `${dsp.volume}%`}
                    </span>
                    <button
                      type="button"
                      className="mini-reset-btn"
                      onClick={() =>
                        setDsp((prev) => ({ ...prev, muted: !prev.muted }))
                      }
                    >
                      {dsp.muted ? "Unmute" : "Mute"}
                    </button>
                    <button
                      type="button"
                      className="mini-reset-btn"
                      onClick={() =>
                        setDsp((prev) => ({
                          ...prev,
                          muted: false,
                          volume: 100,
                        }))
                      }
                    >
                      100%
                    </button>
                  </div>
                </div>

                <input
                  type="range"
                  className="unipolar-slider"
                  min={0}
                  max={100}
                  step={1}
                  value={dsp.muted ? 0 : dsp.volume}
                  style={unipolarFillVars(dsp.muted ? 0 : dsp.volume, 0, 100)}
                  onChange={(e) =>
                    setDsp((prev) => ({
                      ...prev,
                      muted: false,
                      volume: parseInt(e.target.value, 10),
                    }))
                  }
                />
              </div>

              {/* 4. 3-Band Equalizer Card */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">3-Band Equalizer</span>
                  <button
                    type="button"
                    className="mini-reset-btn"
                    onClick={() =>
                      setDsp((prev) => ({
                        ...prev,
                        eqLow: 0,
                        eqMid: 0,
                        eqHigh: 0,
                      }))
                    }
                  >
                    EQ Flat
                  </button>
                </div>

                <div className="eq-row">
                  <span className="eq-label">Low 120Hz</span>
                  <input
                    type="range"
                    className="bipolar-slider"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={dsp.eqLow}
                    style={bipolarFillVars(dsp.eqLow, -12, 12)}
                    onChange={(e) =>
                      setDsp((prev) => ({
                        ...prev,
                        eqLow: parseFloat(e.target.value),
                      }))
                    }
                  />
                  <span className="eq-db-badge">
                    {dsp.eqLow > 0 ? `+${dsp.eqLow}` : dsp.eqLow} dB
                  </span>
                </div>

                <div className="eq-row">
                  <span className="eq-label">Mid 1.1kHz</span>
                  <input
                    type="range"
                    className="bipolar-slider"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={dsp.eqMid}
                    style={bipolarFillVars(dsp.eqMid, -12, 12)}
                    onChange={(e) =>
                      setDsp((prev) => ({
                        ...prev,
                        eqMid: parseFloat(e.target.value),
                      }))
                    }
                  />
                  <span className="eq-db-badge">
                    {dsp.eqMid > 0 ? `+${dsp.eqMid}` : dsp.eqMid} dB
                  </span>
                </div>

                <div className="eq-row">
                  <span className="eq-label">High 5.5kHz</span>
                  <input
                    type="range"
                    className="bipolar-slider"
                    min={-12}
                    max={12}
                    step={0.5}
                    value={dsp.eqHigh}
                    style={bipolarFillVars(dsp.eqHigh, -12, 12)}
                    onChange={(e) =>
                      setDsp((prev) => ({
                        ...prev,
                        eqHigh: parseFloat(e.target.value),
                      }))
                    }
                  />
                  <span className="eq-db-badge">
                    {dsp.eqHigh > 0 ? `+${dsp.eqHigh}` : dsp.eqHigh} dB
                  </span>
                </div>
              </div>

              {/* 4. Speech Enhancement Card */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">Speech Enhancement</span>
                  <button
                    type="button"
                    className="mini-reset-btn"
                    onClick={() => setDsp({ ...DEFAULT_DSP_SETTINGS })}
                  >
                    Reset All DSP
                  </button>
                </div>
                <div className="enhance-grid">
                  <button
                    type="button"
                    className={`enhance-toggle ${dsp.voiceClarity ? "active" : ""
                      }`}
                    onClick={() =>
                      setDsp((prev) => ({
                        ...prev,
                        voiceClarity: !prev.voiceClarity,
                      }))
                    }
                  >
                    <span className="enhance-name">Voice Clarity</span>
                    <span className="enhance-sub">Speech boost</span>
                  </button>
                  <button
                    type="button"
                    className={`enhance-toggle ${dsp.noiseReduction ? "active" : ""
                      }`}
                    onClick={() =>
                      setDsp((prev) => ({
                        ...prev,
                        noiseReduction: !prev.noiseReduction,
                      }))
                    }
                  >
                    <span className="enhance-name">Noise Reduction</span>
                    <span className="enhance-sub">Rumble & hiss cut</span>
                  </button>
                </div>
              </div>

              {/* 5. Output Level Meter */}
              <div className="dsp-card">
                <div className="card-header">
                  <span className="card-title">Output Level</span>
                  <span ref={outputMeterReadoutRef} className="meter-readout">
                    RMS {outputLevels.rmsDb.toFixed(1)} dB · Peak{" "}
                    {outputLevels.peakDb.toFixed(1)} dB
                  </span>
                </div>
                <div className="meter-bar-track">
                  <div
                    ref={outputMeterFillRef}
                    className="meter-bar-fill"
                    style={{ width: `${outputLevels.percent.toFixed(1)}%` }}
                  />
                </div>
              </div>
            </section>

            {/* Right Workstation: Player Deck + Bilingual Transcription Workspace */}
            <section className="right-workstation">
              {/* B. Compact Player Deck */}
              <div
                className={`player-deck ${isDragOver ? "drag-over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={async (e) => {
                  e.preventDefault();
                  setIsDragOver(false);
                  const file = e.dataTransfer.files?.[0];
                  if (!file) return;
                  const url = URL.createObjectURL(file);
                  await loadAudioFileInfo(
                    {
                      name: file.name,
                      path: file.name,
                      size: file.size,
                      mtimeMs: file.lastModified,
                      streamUrl: url,
                    },
                    0
                  );
                }}
              >
                {/* 1. File Identity & Actions Bar */}
                <div className="deck-header">
                  <div className="track-meta">
                    <span className="track-name">
                      {currentTrack
                        ? currentTrack.name
                        : "Drop .mp3 / .wav here or click Open Audio"}
                    </span>
                    {currentTrack && (
                      <span className="meta-pill">
                        {formatBytes(currentTrack.size)}
                      </span>
                    )}
                    <span className="meta-pill">
                      {dsp.speed.toFixed(2)}× ·{" "}
                      {dsp.pitchSemitones > 0
                        ? `+${dsp.pitchSemitones}`
                        : dsp.pitchSemitones}{" "}
                      st
                    </span>
                  </div>

                  <div className="deck-actions">
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleOpenAudioClick}
                    >
                      Open Audio
                    </button>
                    {currentTrack && (
                      <button
                        type="button"
                        className="flat-transport-btn"
                        onClick={handleUnloadAudio}
                      >
                        Unload
                      </button>
                    )}
                  </div>
                </div>

                {/* 2. Waveform Stage (92px height) */}
                <div
                  className="waveform-stage"
                  onPointerDown={(e) => {
                    isScrubbingWaveformRef.current = true;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const ratio = (e.clientX - rect.left) / rect.width;
                    handleSeekToRatio(ratio);
                  }}
                  onPointerMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const relX = Math.max(
                      0,
                      Math.min(rect.width, e.clientX - rect.left)
                    );
                    const ratio = relX / Math.max(1, rect.width);
                    setHoverTime({
                      x: relX,
                      time: ratio * (duration || 0),
                    });
                    if (isScrubbingWaveformRef.current) {
                      handleSeekToRatio(ratio);
                    }
                  }}
                  onPointerUp={() => {
                    if (isScrubbingWaveformRef.current) {
                      isScrubbingWaveformRef.current = false;
                      if (audioRef.current) {
                        void savePlaybackPosition(audioRef.current.currentTime);
                      }
                    }
                  }}
                  onPointerLeave={() => {
                    isScrubbingWaveformRef.current = false;
                    setHoverTime(null);
                  }}
                >
                  <canvas ref={waveformCanvasRef} className="waveform-canvas" />
                  {hoverTime && duration > 0 && (
                    <div
                      className="waveform-hover-tip"
                      style={{ left: `${hoverTime.x}px` }}
                    >
                      {formatTime(hoverTime.time, true)}
                    </div>
                  )}
                  {waveformLoadingProgress !== null && (
                    <div className="waveform-progress-banner">
                      Streaming Waveform Analysis:{" "}
                      {Math.round(waveformLoadingProgress * 100)}%
                    </div>
                  )}
                </div>

                {/* 3. Strictly Flat Transport Controls Bar */}
                <div className="transport-bar">
                  <div className="time-readout">
                    {formatTime(currentTime)} <span>/ {formatTime(duration)}</span>
                  </div>

                  <div className="transport-center">
                    <button
                      type="button"
                      className="flat-transport-btn"
                      title="Seek Backward 3 seconds"
                      onClick={() => handleSeekRelative(-3)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                      -3s
                    </button>

                    <button
                      type="button"
                      className="flat-play-btn"
                      title="Play / Pause"
                      onClick={handleTogglePlay}
                    >
                      {isPlaying ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                          <rect x="6" y="4" width="4" height="16" rx="1" />
                          <rect x="14" y="4" width="4" height="16" rx="1" />
                        </svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                          <polygon points="6 4 20 12 6 20 6 4" />
                        </svg>
                      )}
                    </button>

                    <button
                      type="button"
                      className="flat-transport-btn"
                      title="Stop & Reset to 0:00"
                      onClick={handleStopPlayback}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="5" y="5" width="14" height="14" rx="1.5" />
                      </svg>
                      Stop
                    </button>

                    <button
                      type="button"
                      className="flat-transport-btn"
                      title="Seek Forward 3 seconds"
                      onClick={() => handleSeekRelative(3)}
                    >
                      +3s
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
                        <path d="M21 3v5h-5" />
                      </svg>
                    </button>

                    <button
                      type="button"
                      className={`flat-transport-btn ${loopEnabled ? "active" : ""
                        }`}
                      title="Toggle Loop"
                      onClick={() => setLoopEnabled((v) => !v)}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <polyline points="17 1 21 5 17 9" />
                        <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                        <polyline points="7 23 3 19 7 15" />
                        <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                      </svg>
                      Loop
                    </button>
                  </div>

                  <div>
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={() => {
                        const exactTime = audioRef.current?.currentTime ?? currentTime;
                        const t = Number(exactTime.toFixed(1));
                        setBookmarks((prev) =>
                          prev.some((b) => Math.abs(b - t) < 0.3)
                            ? prev
                            : [...prev, t].sort((a, b) => a - b)
                        );
                      }}
                    >
                      + Bookmark
                    </button>
                  </div>
                </div>

                {/* 4. Structured DAW-Style Bookmarks Strip */}
                {bookmarks.length > 0 && (
                  <div className="bookmarks-strip">
                    <div className="bookmarks-label">
                      <span>Bookmarks</span>
                      <span className="bookmarks-count">{bookmarks.length}</span>
                    </div>
                    <div className="bookmarks-track">
                      {bookmarks.map((bm) => (
                        <div key={bm} className="bookmark-pill">
                          <button
                            type="button"
                            className="bookmark-jump-btn"
                            onClick={() => {
                              if (audioRef.current) {
                                audioRef.current.currentTime = bm;
                                setCurrentTime(bm);
                              }
                            }}
                          >
                            {formatTime(bm, true)}
                          </button>
                          <button
                            type="button"
                            className="bookmark-del-btn"
                            onClick={() =>
                              setBookmarks((prev) =>
                                prev.filter((item) => item !== bm)
                              )
                            }
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="mini-reset-btn"
                      onClick={() => setBookmarks([])}
                    >
                      Clear all
                    </button>
                  </div>
                )}
              </div>

              {/* C. Bilingual Transcription Workspace */}
              <div className="transcription-card">
                <div className="editor-toolbar">
                  <div className="toolbar-group">
                    <button
                      type="button"
                      className={`lang-pill ${langMode === "en" ? "active" : ""}`}
                      onClick={() => {
                        setLangMode("en");
                        if (currentTrack) {
                          localStorage.setItem(`m0sh-lang:${currentFileKey}`, "en");
                        }
                      }}
                    >
                      English
                    </button>
                    <button
                      type="button"
                      className={`lang-pill ${langMode === "dv" ? "active" : ""}`}
                      onClick={() => {
                        setLangMode("dv");
                        if (currentTrack) {
                          localStorage.setItem(`m0sh-lang:${currentFileKey}`, "dv");
                        }
                      }}
                    >
                      ދިވެހި (Thaana)
                    </button>
                  </div>

                  <div className="toolbar-group">
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={() => setFontSize((s) => Math.max(13, s - 1))}
                    >
                      A−
                    </button>
                    <span
                      className="value-badge"
                      style={{
                        height: "32px",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      {fontSize}px
                    </span>
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={() => setFontSize((s) => Math.min(28, s + 1))}
                    >
                      A+
                    </button>

                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleInsertTimestamp}
                    >
                      Insert [{formatTime(currentTime)}]
                    </button>
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleCopyTranscript}
                    >
                      {copiedBanner ? "✓ Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleSaveTranscriptTxt}
                    >
                      Save .txt
                    </button>
                    <button
                      type="button"
                      className="flat-transport-btn"
                      disabled={!transcript.trim()}
                      onClick={() => {
                        if (!transcript.trim()) return;
                        setClearTranscriptModalOpen(true);
                      }}
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <textarea
                  ref={editorRef}
                  className={`transcript-textarea ${langMode === "dv" ? "lang-dv" : "lang-en"
                    }`}
                  style={{ fontSize: `${fontSize}px` }}
                  placeholder={
                    langMode === "dv"
                      ? "ދިވެހި ތާނަ ޓްރާންސްކްރިޕްޝަން މިތާ ލިޔުއްވާ..."
                      : "Type your transcription here while controlling playback speed, pitch, and bookmarks..."
                  }
                  value={transcript}
                  onChange={(e) => {
                    setTranscript(e.target.value);
                    selectionRef.current = {
                      start: e.target.selectionStart,
                      end: e.target.selectionEnd,
                      direction:
                        (e.target.selectionDirection as
                          | "forward"
                          | "backward"
                          | "none") || "none",
                    };
                  }}
                  onKeyDown={handleEditorKeyDown}
                  onSelect={(e) => {
                    const el = e.currentTarget;
                    selectionRef.current = {
                      start: el.selectionStart,
                      end: el.selectionEnd,
                      direction:
                        (el.selectionDirection as
                          | "forward"
                          | "backward"
                          | "none") || "none",
                    };
                  }}
                />

                <div className="editor-statusbar">
                  <span>
                    {words} words · {chars} characters ·{" "}
                    {langMode === "dv"
                      ? "Dhivehi Phonetic Thaana (RTL)"
                      : "English (LTR)"}
                  </span>
                  <span>{statusMessage}</span>
                </div>
              </div>
            </section>
          </main>
        ) : (
          /* 4. Live WAV Recording Studio (recorder Page) */
          <main className="recorder-view">
            <div className="recorder-card">
              <div className="deck-header">
                <div className="track-meta">
                  <span className="track-name">Live Mono 16-bit PCM WAV Studio</span>
                  <span className="meta-pill">
                    Status: {recorderStatus.toUpperCase()}
                  </span>
                  <span className="meta-pill">
                    Elapsed: {formatTime(recorderElapsed, true)}
                  </span>
                </div>
                <span className="meter-readout">
                  RMS {recorderDb.rmsDb.toFixed(1)} dB · Peak{" "}
                  {recorderDb.peakDb.toFixed(1)} dB
                </span>
              </div>

              <div className="recorder-meter-bars">
                {recorderMeterBars.map((val, i) => (
                  <div
                    key={i}
                    className="recorder-bar"
                    style={{ height: `${val}%` }}
                  />
                ))}
              </div>

              {/* Microphone Level Indicator & Input Gain Slider Panel */}
              <div className="dsp-card" style={{ gap: "10px" }}>
                <div className="card-header">
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span className="card-title">Mic Level Indicator</span>
                    <span
                      className="value-badge"
                      style={{
                        color: recorderClipping
                          ? "var(--accent-danger)"
                          : recorderLevelPercent > 25
                          ? "var(--accent-primary)"
                          : "var(--text-secondary)",
                        borderColor: recorderClipping
                          ? "var(--accent-danger)"
                          : undefined,
                      }}
                    >
                      {recorderClipping
                        ? "Peak / Soft-Limited"
                        : recorderLevelPercent > 25
                        ? "Optimal Input"
                        : recorderLevelPercent > 3
                        ? "Low Signal"
                        : "Listening..."}
                    </span>
                  </div>
                  <span className="meter-readout">
                    Level {Math.round(recorderLevelPercent)}% · RMS{" "}
                    {recorderDb.rmsDb.toFixed(1)} dB · Peak{" "}
                    {recorderDb.peakDb.toFixed(1)} dB
                  </span>
                </div>

                {/* Horizontal Live Mic Level Bar with Peak Marker */}
                <div
                  className="meter-bar-track"
                  style={{ position: "relative", height: "12px" }}
                >
                  <div
                    className="meter-bar-fill"
                    style={{
                      width: `${recorderLevelPercent.toFixed(1)}%`,
                      background: recorderClipping
                        ? "var(--accent-danger)"
                        : recorderLevelPercent > 82
                        ? "#f59e0b"
                        : "var(--accent-primary)",
                    }}
                  />
                  {recorderPeakPercent > 2 && (
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `calc(${Math.min(99.5, recorderPeakPercent).toFixed(1)}% - 1px)`,
                        width: "2px",
                        background: "var(--text-primary)",
                        opacity: 0.9,
                      }}
                    />
                  )}
                </div>

                {/* Mic Input Level (Gain Boost) Slider */}
                <div className="card-header" style={{ marginTop: "2px" }}>
                  <span className="card-title">Mic Input Level (Pre-Amp Boost)</span>
                  <div style={{ display: "flex", gap: "5px", alignItems: "center" }}>
                    <span className="value-badge">
                      {micGainPercent}% (
                      {micGainPercent === 100
                        ? "0.0 dB"
                        : `${(20 * Math.log10(micGainPercent / 100) >= 0 ? "+" : "") + (20 * Math.log10(micGainPercent / 100)).toFixed(1)} dB`}
                      )
                    </span>
                    <button
                      type="button"
                      className="mini-reset-btn"
                      onClick={() => setMicGainPercent(150)}
                    >
                      Reset (150%)
                    </button>
                  </div>
                </div>

                <input
                  type="range"
                  className="unipolar-slider"
                  min={25}
                  max={400}
                  step={5}
                  value={micGainPercent}
                  style={unipolarFillVars(micGainPercent, 25, 400)}
                  onChange={(e) =>
                    setMicGainPercent(parseInt(e.target.value, 10))
                  }
                />

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
                    gap: "5px",
                  }}
                >
                  {[100, 150, 200, 300, 400].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className={`preset-pill ${
                        micGainPercent === pct ? "active" : ""
                      }`}
                      onClick={() => setMicGainPercent(pct)}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              <div className="transport-center">
                {recorderStatus === "ready" || recorderStatus === "stopped" ? (
                  <button
                    type="button"
                    className="flat-transport-btn active"
                    onClick={handleStartRecordingClick}
                  >
                    ● Start Recording
                  </button>
                ) : (
                  <>
                    {recorderStatus === "recording" ? (
                      <button
                        type="button"
                        className="flat-transport-btn"
                        onClick={() => {
                          recorderRef.current?.pause();
                          setRecorderStatus("paused");
                        }}
                      >
                        Pause
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="flat-transport-btn active"
                        onClick={() => {
                          recorderRef.current?.resume();
                          setRecorderStatus("recording");
                        }}
                      >
                        Resume
                      </button>
                    )}
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleStopRecordingClick}
                    >
                      ■ Stop Recording
                    </button>
                  </>
                )}
              </div>

              {completedRecording && (
                <div
                  className="dsp-card"
                  style={{ marginTop: "6px", gap: "10px" }}
                >
                  <div className="card-header">
                    <span className="card-title">
                      Recorded Take ({formatTime(completedRecording.durationSeconds, true)} ·{" "}
                      {formatBytes(completedRecording.wavBlob.size)})
                    </span>
                    <span className="value-badge">
                      {isRecordingSaved ? "Saved to Disk" : "Unsaved Take"}
                    </span>
                  </div>

                  <audio
                    controls
                    src={completedRecording.objectUrl}
                    style={{ width: "100%", height: "36px" }}
                  />

                  <div
                    style={{
                      display: "flex",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <input
                      type="text"
                      value={recordingFilename}
                      onChange={(e) => setRecordingFilename(e.target.value)}
                      style={{
                        flex: 1,
                        height: "32px",
                        padding: "0 10px",
                        borderRadius: "6px",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--bg-input)",
                      }}
                    />
                    <button
                      type="button"
                      className="flat-transport-btn"
                      onClick={handleSaveCompletedWav}
                    >
                      ⬇ Save WAV
                    </button>
                    <button
                      type="button"
                      className="flat-transport-btn active"
                      onClick={handleOpenRecordingInPlayer}
                    >
                      Open in Player & Transcribe
                    </button>
                  </div>
                </div>
              )}
            </div>
          </main>
        )}
      </div>

      {/* Clear Transcript Confirmation Modal */}
      {clearTranscriptModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setClearTranscriptModalOpen(false)}
        >
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-header">
              <span className="track-name">Clear Transcription Text?</span>
            </div>
            <p style={{ color: "var(--text-secondary)" }}>
              You have {words} {words === 1 ? "word" : "words"} ({chars}{" "}
              {chars === 1 ? "character" : "characters"}) in the transcription
              editor. Clearing will permanently erase the current transcript
              unless you save it first.
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => setClearTranscriptModalOpen(false)}
              >
                Keep Transcript
              </button>
              <button
                type="button"
                className="flat-transport-btn active"
                onClick={async () => {
                  const baseTrack = currentTrack
                    ? currentTrack.name.replace(/\.[^.]+$/, "")
                    : "m0sh";
                  const suggested = `${baseTrack}-transcript.txt`;
                  const result = await saveTranscriptFile(suggested, transcript);
                  if (result.saved) {
                    selectionRef.current = { start: 0, end: 0, direction: "none" };
                    setTranscript("");
                    setClearTranscriptModalOpen(false);
                    if (result.path) {
                      setStatusMessage(
                        `Saved & cleared transcript (${result.path})`
                      );
                    }
                  }
                }}
              >
                Save .txt & Clear
              </button>
              <button
                type="button"
                className="flat-transport-btn"
                style={{
                  borderColor: "var(--accent-danger)",
                  color: "var(--accent-danger)",
                }}
                onClick={() => {
                  selectionRef.current = { start: 0, end: 0, direction: "none" };
                  setTranscript("");
                  setClearTranscriptModalOpen(false);
                  setStatusMessage("Transcript cleared");
                }}
              >
                Clear Without Saving
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Replace Current Recording Confirmation Modal */}
      {replaceModalOpen && (
        <div className="modal-backdrop">
          <div className="modal-panel">
            <div className="card-header">
              <span className="track-name">Replace Current Recording?</span>
            </div>
            <p style={{ color: "var(--text-secondary)" }}>
              You have an unsaved recording take. Starting a new recording will
              replace the current take unless you save it first.
            </p>
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => setReplaceModalOpen(false)}
              >
                Keep Current Recording
              </button>
              <button
                type="button"
                className="flat-transport-btn active"
                onClick={handleSaveAndStartNewRecording}
              >
                ⬇ Save WAV & Start New
              </button>
              <button
                type="button"
                className="flat-transport-btn"
                style={{ borderColor: "var(--accent-danger)", color: "var(--accent-danger)" }}
                onClick={startNewRecordingSession}
              >
                Discard & Start Recording
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5.1 Keyboard Shortcuts & Settings Modal */}
      {settingsModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => {
            setCapturingShortcutKey(null);
            setSettingsModalOpen(false);
          }}
        >
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-header">
              <span className="track-name">Keyboard Shortcuts & Settings</span>
              <button
                type="button"
                className="mini-reset-btn"
                onClick={() => setShortcuts({ ...DEFAULT_SHORTCUTS })}
              >
                Reset to Defaults
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {(Object.keys(SHORTCUT_LABELS) as (keyof ShortcutMap)[]).map(
                (keyName) => {
                  const isCapturing = capturingShortcutKey === keyName;
                  return (
                    <div key={keyName} className="shortcut-row">
                      <span>{SHORTCUT_LABELS[keyName]}</span>
                      <button
                        type="button"
                        className="shortcut-capture-btn"
                        onClick={() => setCapturingShortcutKey(keyName)}
                        onKeyDown={(e) => {
                          if (!isCapturing) return;
                          e.preventDefault();
                          e.stopPropagation();
                          if (e.key === "Escape") {
                            setCapturingShortcutKey(null);
                            return;
                          }
                          const combo = formatKeyEventCombo(e);
                          if (
                            combo &&
                            !["Ctrl", "Alt", "Shift"].includes(combo)
                          ) {
                            setShortcuts((prev) => ({
                              ...prev,
                              [keyName]: combo,
                            }));
                            setCapturingShortcutKey(null);
                          }
                        }}
                      >
                        {isCapturing
                          ? "Press keys..."
                          : shortcuts[keyName]}
                      </button>
                    </div>
                  );
                }
              )}
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => {
                  setCapturingShortcutKey(null);
                  setSettingsModalOpen(false);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5.2 About & Self-Update Modal */}
      {aboutModalOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setAboutModalOpen(false)}
        >
          <div
            className="modal-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="brand-lockup">
              <div className="brand-crest">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="5" width="2.2" height="6" rx="1.1" fill="var(--accent-primary)" />
                  <rect x="5.3" y="2.5" width="2.2" height="11" rx="1.1" fill="var(--accent-primary)" />
                  <rect x="8.6" y="4" width="2.2" height="8" rx="1.1" fill="var(--accent-slash)" />
                  <rect x="11.9" y="6" width="2.2" height="4" rx="1.1" fill="var(--accent-primary)" />
                </svg>
              </div>
              <div className="brand-wordmark">
                <span>M</span>
                <span className="brand-zero">
                  0<span className="brand-zero-slash" />
                </span>
                <span>SH</span>
              </div>
              <span className="brand-badge">
                TIMESTRETCH 3 v{updateStatus.currentVersion}
              </span>
            </div>

            <p style={{ color: "var(--text-secondary)" }}>
              Local-first desktop audio time-stretch & pitch-shift player, live
              WAV recorder, and bilingual English / Dhivehi (ދިވެހި — Thaana)
              transcription studio.
            </p>

            <div className="dsp-card">
              <div className="card-header">
                <span className="card-title">Author & Repository</span>
                <button
                  type="button"
                  onClick={() =>
                    void openExternalUrl("https://github.com/MoshRadix/TimsStretch-3")
                  }
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--accent-primary)",
                    fontWeight: 700,
                    cursor: "pointer",
                    fontSize: "inherit",
                  }}
                >
                  M0sh (github.com/MoshRadix) ↗
                </button>
              </div>
              <div className="card-header">
                <span className="card-title">Update Status</span>
                <span className="value-badge">{updateStatus.message}</span>
              </div>
              <div style={{ display: "flex", gap: "8px", marginTop: "4px" }}>
                <button
                  type="button"
                  className="flat-transport-btn"
                  disabled={isCheckingUpdate}
                  onClick={handleCheckForUpdates}
                >
                  {isCheckingUpdate ? "Checking..." : "Check for Updates"}
                </button>
                {updateStatus.available && (
                  <button
                    type="button"
                    className="flat-transport-btn active"
                    disabled={isInstallingUpdate}
                    onClick={() => {
                      void triggerForcedSelfUpdate(updateStatus);
                    }}
                  >
                    {isInstallingUpdate ? "Updating..." : "Install & Restart"}
                  </button>
                )}
                <button
                  type="button"
                  className="flat-transport-btn"
                  onClick={() => {
                    setAboutModalOpen(false);
                    setReleaseNotesOpen(true);
                  }}
                >
                  Release Notes
                </button>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => setAboutModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5.3 Release Notes Page Modal */}
      {releaseNotesOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setReleaseNotesOpen(false)}
        >
          <div
            className="modal-panel"
            style={{ maxWidth: "680px", maxHeight: "82vh" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-header">
              <span className="track-name">
                M0SH TimeStretch 3 — Release Notes
              </span>
              <button
                type="button"
                className="mini-reset-btn"
                onClick={() =>
                  void openExternalUrl(
                    updateStatus.releaseUrl ||
                      "https://github.com/MoshRadix/TimsStretch-3/releases/latest"
                  )
                }
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                }}
              >
                View on GitHub ↗
              </button>
            </div>

            <div className="release-notes-container">
              <FormattedReleaseNotes
                markdown={
                  updateStatus.releaseNotes
                    ? `${updateStatus.releaseNotes}\n\n---\n\n${releaseNotesMarkdown}`
                    : releaseNotesMarkdown
                }
              />
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => {
                  setReleaseNotesOpen(false);
                  setAboutModalOpen(true);
                }}
              >
                ← Back to About
              </button>
              <button
                type="button"
                className="flat-transport-btn"
                onClick={() => setReleaseNotesOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 5.4 Mandatory Forced Self-Update Modal (Blocks UI when a newer release is found) */}
      {updateStatus.available && (
        <div
          className="modal-backdrop"
          style={{ zIndex: 9999 }}
        >
          <div
            className="modal-panel"
            style={{ maxWidth: "520px" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-header">
              <div className="brand-lockup">
                <span className="track-name">
                  Mandatory Update Required
                </span>
              </div>
              <span className="value-badge">
                v{updateStatus.currentVersion} → v{updateStatus.latestVersion}
              </span>
            </div>

            <p style={{ color: "var(--text-secondary)", lineHeight: 1.55 }}>
              A newer release of <strong>M0SH TimeStretch 3</strong> (v
              {updateStatus.latestVersion}) is available. Your current playback
              position and transcription text have been automatically saved.
              The application is updating now and will restart automatically.
            </p>

            <div className="dsp-card" style={{ gap: "8px" }}>
              <div className="card-header">
                <span className="card-title">
                  {updateProgressMessage || updateStatus.message}
                </span>
                <span className="meter-readout">
                  {Math.round(updateProgressPercent)}%
                </span>
              </div>
              <div className="meter-bar-track" style={{ height: "10px" }}>
                <div
                  className="meter-bar-fill"
                  style={{
                    width: `${Math.max(5, Math.min(100, updateProgressPercent))}%`,
                    transition: "width 180ms ease",
                  }}
                />
              </div>
            </div>

            {updateStatus.releaseNotes && (
              <div
                className="release-notes-container"
                style={{ maxHeight: "160px", padding: "10px 12px" }}
              >
                <FormattedReleaseNotes markdown={updateStatus.releaseNotes} />
              </div>
            )}

            {updateInstallError && (
              <div
                style={{
                  padding: "8px 10px",
                  borderRadius: "6px",
                  border: "1px solid var(--accent-danger)",
                  color: "var(--accent-danger)",
                  fontSize: "12px",
                }}
              >
                Update installation encountered an issue: {updateInstallError}
              </div>
            )}

            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: "8px",
                alignItems: "center",
              }}
            >
              {updateInstallError && (
                <button
                  type="button"
                  className="flat-transport-btn"
                  onClick={() =>
                    void openExternalUrl(
                      updateStatus.installerUrl || updateStatus.releaseUrl
                    )
                  }
                >
                  Download Installer ↗
                </button>
              )}
              <button
                type="button"
                className="flat-transport-btn active"
                disabled={isInstallingUpdate}
                onClick={() => void triggerForcedSelfUpdate(updateStatus)}
              >
                {isInstallingUpdate
                  ? "Downloading & Installing..."
                  : "Retry Update Now"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
