# M0SH TimeStretch 3 — Release Notes

## v1.0.0 (2026-11-14) — Initial Release of M0SH TimeStretch 3

**M0SH TimeStretch 3** is a ground-up desktop architecture upgrade built on **Tauri v2**, **Rust**, **React 18**, **TypeScript**, and **Web Audio API**. All audio playback, DSP processing, waveform analysis, live recording, and bilingual transcription run **100% locally on-device**.

### Highlights & New Features

#### 1. Multi-Threaded Rust Audio & Waveform Engine (`src-tauri/`)
- **Streaming Large-File Waveform Decoder (`symphonia` + `rayon`)**:
  - Decodes `.mp3` and `.wav` files of any size (`65 MB` to `300 MB+`) in bounded memory packets without loading full decoded PCM buffers into RAM.
  - Ultra-fast seek-strided WAV reader renders 300 MB `.wav` waveforms in `< 50 ms`.
  - Progressive live waveform analysis events (`waveform://progress`) for long-form `.mp3` tracks.
  - 99th-percentile normalization across `512` bins prevents isolated clicks/pops from flattening the waveform.
  - Persistent SHA-256 binary cache (`<app_cache_dir>/waveforms/`) reloads previously analyzed waveforms in `< 2 ms`.
- **Zero-Copy HTTP 206 Byte-Range Streaming**:
  - Local range server (`Accept-Ranges: bytes` / `206 Partial Content`) + `moshstream://` protocol backed by `tokio::fs::File` + `SeekFrom::Start` for instantaneous scrubbing across multi-hundred-megabyte files.

#### 2. Web Audio DSP Graph & True Unity-Gain Speech Filters (`src/audio/`)
- **Independent Time-Stretch & Pitch-Shift**:
  - Tempo control from `0.50×` to `2.00×` (`preservesPitch = true`) with quick presets (`0.75×`, `1.0×`, `1.25×`, `1.5×`).
  - Semitone pitch shifting from `-12 st` to `+12 st` powered by `@soundtouchjs/audio-worklet` with a center-zero bipolar slider and single-row preset pills.
- **3-Band Equalizer**:
  - `Low 120 Hz` lowshelf, `Mid 1.1 kHz` peaking (`Q = 0.9`), and `High 5.5 kHz` highshelf (`-12 dB` to `+12 dB`).
- **True Unity-Gain (`1.0`) Parallel Dry/Wet Speech Enhancement**:
  - **Voice Clarity**: `130 Hz` high-pass + `2400 Hz` (`+4.5 dB`) presence boost + `2.5:1` dynamic compression + makeup gain.
  - **Noise Reduction**: `105 Hz` rumble cut + `50 Hz` hum notch (`Q = 10`) + `6800 Hz` hiss cut + makeup gain.
  - Parallel dry/wet bypass ensures zero volume drop when toggling filters off.

#### 3. Bilingual Dhivehi (`ދިވެހި` — Thaana) & English Transcription Studio
- **Default Dhivehi (`ދިވެހި`) Startup with Per-File Language Persistence**:
  - Starts in **ދިވެހި (Thaana)** RTL mode by default with the bundled **Faruma** font and built-in QWERTY Phonetic Thaana transliteration.
  - Automatically remembers and restores your chosen language mode (`ދިވެހި` or `English`) for each individual audio file.
- **Continuous Editor Focus**:
  - Transport buttons, DSP sliders, and bookmark jumps automatically preserve your transcription `<textarea>` focus and cursor selection so typing is never interrupted.
- **UTF-8 BOM Export & Accidental Clear Protection**:
  - Native `.txt` save dialog prepends a UTF-8 BOM (`\uFEFF`) so Dhivehi text opens cleanly in Windows Notepad and Microsoft Word.
  - Confirmation modal before clearing non-empty transcripts (**Keep Transcript**, **Save `.txt` & Clear**, or **Clear Without Saving**).

#### 4. Live Mono 16-Bit PCM WAV Recording Studio
- Captures raw mono microphone audio with a 72-bar scrolling RMS/Peak dB meter.
- Encodes standard 16-bit PCM RIFF WAVE files via Rust `hound` and includes an accidental overwrite confirmation modal.

#### 5. Studio Themes, Bookmarks, Shortcuts & Self-Updater
- **Dark & Light Studio Themes** with cached 60fps canvas waveform colors.
- **Structured DAW-Style Bookmarks Strip** with waveform pin markers.
- **Customizable OS & In-App Keyboard Shortcuts** (`Ctrl+Space`, `Ctrl+Left/Right`, `Ctrl+Up/Down`, `Ctrl+[/]`, `Alt+,`).
- **Signed Windows Authenticode Installers & GitHub Releases Self-Updater**.
