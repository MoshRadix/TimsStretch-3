# M0SH TimeStretch 3

<p align="center">
  <strong>Local-First Desktop Audio Workstation · Real-Time Time-Stretch & Pitch-Shift Player · Live WAV Recorder · Bilingual English & Dhivehi (ދިވެހި — Thaana) Transcription Studio</strong>
</p>

<p align="center">
  <a href="https://github.com/MoshRadix/mosh-timestretch-3/releases/latest">
    <img src="https://img.shields.io/github/v/release/MoshRadix/mosh-timestretch-3?style=flat-square&color=22d3ee&label=Latest%20Release" alt="Latest Release" />
  </a>
  <img src="https://img.shields.io/badge/Tauri-v2-22d3ee?style=flat-square&logo=tauri" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/Rust-1.80%2B-ff5722?style=flat-square&logo=rust" alt="Rust" />
  <img src="https://img.shields.io/badge/React-18-0ea5e9?style=flat-square&logo=react" alt="React 18" />
  <img src="https://img.shields.io/badge/Privacy-100%25%20Local%20On--Device-10b981?style=flat-square" alt="100% Local" />
</p>

---

**M0SH TimeStretch 3** (`TimeStretch 3`) is a lightweight, native desktop audio player, DSP workstation, live microphone recorder, and bilingual transcription environment built with **Tauri v2**, **Rust**, **React 18**, **TypeScript**, and **Web Audio API**.

Every feature—audio decoding, waveform generation, time-stretching, pitch-shifting, speech filtering, WAV recording, and transcript autosaving—runs **100% locally on your machine** with zero cloud uploads or external telemetry.

---

## ✨ Key Features (For Users)

### 1. Real-Time Time-Stretch & Pitch-Shift Engine
- **Independent Playback Speed (`0.50×` to `2.00×`)**: Slow down rapid speech for transcription or speed up long lectures without distorting vocal pitch (`preservesPitch = true`), with one-click presets (`0.75×`, `1.0×`, `1.25×`, `1.5×`).
- **Real-Time Semitone Pitch Shift (`-12 st` to `+12 st`)**: Powered by `@soundtouchjs/audio-worklet` with a center-zero bipolar slider and instant semitone pills (`-4`, `-2`, `-1`, `0`, `+1`, `+2`, `+4`).
- **3-Band Studio Equalizer (`-12 dB` to `+12 dB`)**:
  - **Low (`120 Hz` Lowshelf)**: Control low-end rumble or warmth.
  - **Mid (`1.1 kHz` Peaking, `Q = 0.9`)**: Shape vocal body and nasal frequencies.
  - **High (`5.5 kHz` Highshelf)**: Adjust consonant crispness or high-frequency hiss.
- **Speech Enhancement Filters (True Unity-Gain Bypass)**:
  - **Voice Clarity**: `130 Hz` high-pass + `2400 Hz` (`+4.5 dB`) vocal presence boost + gentle `2.5:1` dynamic compression + makeup gain.
  - **Noise Reduction**: `105 Hz` rumble cut + `50 Hz` mains hum notch (`Q = 10`) + `6800 Hz` hiss roll-off + makeup gain.
  - Parallel dry/wet routing guarantees **zero volume drop** when toggling filters on or off.

### 2. Instant Large-File Waveform & Zero-Copy Seeking
- **Handles `65 MB` to `300 MB+` Recordings Effortlessly**:
  - Multi-threaded Rust waveform engine (`symphonia` + `rayon`) streams audio packets in bounded memory without loading full files into RAM.
  - Ultra-fast seek-strided WAV reader renders 300 MB `.wav` waveforms in `< 50 ms`.
  - Progressive live waveform bar (`waveform://progress`) for long `.mp3` files.
  - Persistent SHA-256 binary cache (`<app_cache_dir>/waveforms/`) reloads previously analyzed files in `< 2 ms`.
- **Interactive 60fps HiDPI Waveform Stage**:
  - Click or drag anywhere on the 512-bin waveform to scrub instantaneously, with hover timestamp tooltips (`MM:SS.d`) and visual bookmark pins.

### 3. Bilingual Transcription Workspace (`English` & `ދިވެހި — Thaana`)
- **Uninterrupted Typing Flow**:
  - Clicking transport controls (`Play/Pause`, `-3s`, `+3s`, `Loop`), adjusting speed/pitch/EQ sliders, or jumping to bookmarks **never steals keyboard focus** from the transcription editor—your cursor position and text selection stay active so you can keep typing continuously.
- **Built-in Phonetic Dhivehi (`ދިވެހި`) Thaana Keyboard**:
  - Switch between **English (LTR)** and **ދިވެހި Thaana (RTL)** with a single click.
  - Uses the bundled **Faruma** font with automatic QWERTY-to-Phonetic-Thaana transliteration (no OS keyboard layout switching required).
- **Timestamps, Autosave & Safe Export**:
  - Insert `[MM:SS]` playhead timestamps at the cursor.
  - Automatic debounced on-device autosave (`300 ms`) per audio file.
  - **Save `.txt` with UTF-8 BOM (`\uFEFF`)**: Exports clean text files that open with proper Dhivehi/Thaana rendering in Windows Notepad, Microsoft Word, and other editors.
  - **Data-Loss Protection**: Clicking **Clear** prompts a confirmation modal offering to **Save `.txt` & Clear**, **Keep Transcript**, or **Clear Without Saving**.

### 4. Live Mono 16-Bit PCM WAV Recording Studio
- **Raw Studio Capture**: Records mono microphone audio with browser DSP artifacts disabled (`echoCancellation: false`, `noiseSuppression: false`, `autoGainControl: false`).
- **Live 72-Bar Scrolling Level Meter**: Real-time RMS and Peak dB readout.
- **Accidental Overwrite Protection**: Starting a new recording when an unsaved take exists opens a confirmation dialog (**Keep Current Recording**, **⬇ Save WAV & Start New**, or **Discard & Start Recording**).
- **One-Click Hand-Off**: Load your recorded WAV directly into the **Player & Transcribe** deck with a single click.

### 5. Studio Themes, Bookmarks, Session Restore & Self-Updater
- **Dark & Light Studio Themes**: High-contrast dark cyan/slate studio theme and warm paper-light theme.
- **DAW-Style Bookmarks Strip**: Drop timestamp pins along the waveform, jump to any pin with one click, or clear all.
- **Automatic Session Restoration**: Reopens your last audio track, playhead position, per-file DSP settings, bookmarks, and transcript on launch.
- **Customizable Keyboard Shortcuts**: Configure global and in-app hotkeys from the **Shortcuts** modal.
- **Built-In GitHub Releases Updater**: Check for updates and install new releases directly from the **About** modal without interrupting active audio playback.

---

## ⌨️ Default Keyboard Shortcuts

All shortcuts can be customized in **Shortcuts & Settings** (`Alt+,`):

| Action | Default Shortcut |
| :--- | :--- |
| **Play / Pause** | `Ctrl+Space` |
| **Seek Backward (-3s)** | `Ctrl+Left` |
| **Seek Forward (+3s)** | `Ctrl+Right` |
| **Speed Up (+0.05×)** | `Ctrl+Up` |
| **Speed Down (-0.05×)** | `Ctrl+Down` |
| **Pitch Down (-1 st)** | `Ctrl+[` |
| **Pitch Up (+1 st)** | `Ctrl+]` |
| **Open Shortcuts & Settings** | `Alt+,` |

---

## 🔤 Phonetic Dhivehi (`ދިވެހި` — Thaana) Key Map

When **ދިވެހި (Thaana)** mode is active in the transcription editor, standard English QWERTY keys map to phonetic Thaana characters:

| Key | Thaana | Shift + Key | Thaana | Key | Thaana | Shift + Key | Thaana |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `q` | ް | `Q` | ޤ | `a` | ަ | `A` | ާ |
| `w` | އ | `W` | ޢ | `s` | ސ | `S` | ށ |
| `e` | ެ | `E` | ޭ | `d` | ދ | `D` | ޑ |
| `r` | ރ | `R` | ޜ | `f` | ފ | `F` | ﷲ |
| `t` | ތ | `T` | ޓ | `g` | ގ | `G` | ޣ |
| `y` | ޔ | `Y` | ޠ | `h` | ހ | `H` | ޙ |
| `u` | ު | `U` | ޫ | `j` | ޖ | `J` | ޛ |
| `i` | ި | `I` | ީ | `k` | ކ | `K` | ޚ |
| `o` | ޮ | `O` | ޯ | `l` | ލ | `L` | ޅ |
| `p` | ޕ | `P` | ÷ | `z` | ޒ | `Z` | ޡ |
| `x` | × | `X` | ޘ | `c` | ޗ | `C` | ޝ |
| `v` | ވ | `V` | ޥ | `b` | ބ | `B` | ޞ |
| `n` | ނ | `N` | ޏ | `m` | މ | `M` | `>` |
| `,` | ، | `;` | ؛ | `?` | ؟ | | |

---

## 📥 Installation (End Users)

1. Visit the [**Latest Releases**](https://github.com/MoshRadix/mosh-timestretch-3/releases/latest) page.
2. Download the installer for your operating system:
   - **Windows**: `TimeStretch 3_x.x.x_x64-setup.exe` or `.msi`
   - **macOS**: `TimeStretch 3_x.x.x_universal.dmg`
   - **Linux**: `.AppImage` or `.deb`
3. Run the installer and launch **TimeStretch 3**.

---

## 🛠️ Developer Guide & Architecture

### Tech Stack
- **Desktop Core**: [Tauri v2](https://v2.tauri.app/) (`tauri`, `tauri-plugin-dialog`, `tauri-plugin-global-shortcut`, `tauri-plugin-updater`, `tauri-plugin-process`)
- **Rust Audio & Streaming Backend**:
  - `symphonia` (`mp3`, `wav`, `pcm`, `isomp4`) + `rayon` for multi-threaded bounded-memory waveform analysis.
  - `tokio` range-capable local HTTP streaming server (`206 Partial Content` / `Accept-Ranges: bytes`) + `moshstream://` custom URI protocol for zero-copy large-file seeking.
  - `hound` for native mono 16-bit PCM RIFF WAVE encoding.
  - `sha2` + `hex` for deterministic waveform disk cache keys.
- **Frontend UI & DSP**:
  - **React 18** + **TypeScript 5** + **Vite 6**
  - **Web Audio API** + `@soundtouchjs/audio-worklet` for real-time pitch shifting, 3-band Biquad EQ, and parallel unity-gain speech enhancement filters.

### Project Directory Structure
```text
TimeStretch-3/
├── .github/workflows/
│   └── release.yml              # Multi-OS CI/CD release pipeline (Windows, macOS, Linux)
├── scripts/
│   ├── release.mjs              # Semver bump & git tag helper script
│   └── tauri-cli.mjs            # Wrapper injecting Tauri updater signing keys
├── src/
│   ├── assets/fonts/            # Bundled Faruma Dhivehi/Thaana fonts
│   ├── audio/
│   │   ├── audio-engine.ts      # Web Audio API graph, 3-band EQ, parallel dry/wet filters
│   │   └── wav-recorder.ts      # Live microphone capture & 16-bit PCM WAV encoder
│   ├── bridge/
│   │   └── tauri-bridge.ts      # Typed IPC wrapper for Tauri commands & events
│   ├── utils/
│   │   └── thaana.ts            # Phonetic Thaana mapping & word/character counters
│   ├── App.tsx                  # Main workstation UI, 60fps canvas waveform, modals
│   ├── index.css                # 100% custom Dark & Light studio theme stylesheet
│   └── main.tsx                 # React 18 root entry
└── src-tauri/
    ├── capabilities/
    │   └── default.json         # Tauri v2 permissions capability manifest
    ├── icons/                   # Multi-platform app icons (.ico, .icns, .png)
    ├── src/
    │   ├── lib.rs               # Tauri commands, session persistence, updater, shortcuts
    │   ├── main.rs              # Native binary entry point
    │   ├── stream_server.rs     # Async HTTP 206 byte-range audio streaming server
    │   └── waveform.rs          # Symphonia + Rayon streaming waveform generator & cache
    ├── Cargo.toml               # Rust dependencies & crate metadata
    ├── sign.cmd                 # Windows SDK signtool.exe Authenticode signing wrapper
    └── tauri.conf.json          # App configuration, bundler settings & updater endpoints
```

---

### Prerequisites for Local Development
1. **Node.js** `v20+` and `npm`
2. **Rust Toolchain** (`rustup`, `cargo`, `rustc 1.80+`)
3. **Platform Build Tools**:
   - **Windows**: Microsoft Visual Studio C++ Build Tools, Windows 10/11 SDK (`signtool.exe`), and WebView2 Runtime.
   - **macOS**: Xcode Command Line Tools (`xcode-select --install`).
   - **Linux (Ubuntu/Debian)**:
     ```bash
     sudo apt-get update
     sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libasound2-dev
     ```

### Running in Development Mode
```bash
# 1. Install frontend dependencies
npm install

# 2. Start the Vite + Tauri desktop development window with hot-reload
npm run tauri dev
```

### Type-Checking & Verification
```bash
# Frontend TypeScript check
npx tsc --noEmit

# Frontend production bundle
npm run build

# Rust backend compilation check
cargo check --manifest-path src-tauri/Cargo.toml
```

### Building Signed Production Installers
```bash
# Builds optimized frontend + Rust binary, signs Windows binaries via src-tauri/sign.cmd,
# and generates signed Tauri updater artifacts (.sig)
npm run tauri build
```
Built installers are output to:
- `src-tauri/target/release/bundle/nsis/` (Windows NSIS `.exe` installer)
- `src-tauri/target/release/bundle/msi/` (Windows `.msi` installer)
- `src-tauri/target/release/bundle/dmg/` (macOS `.dmg`)
- `src-tauri/target/release/bundle/appimage/` & `deb/` (Linux)

### Releasing a New Version
Use the included release script to bump the version across `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`, create a git commit, and tag the release:
```bash
npm run release -- 1.0.1
git push && git push --tags
```
Pushing a `v*` tag triggers [`.github/workflows/release.yml`](.github/workflows/release.yml) to build multi-platform installers and publish `latest.json` to GitHub Releases.

---

## 👤 Author & License

- **Author**: **M0sh** ([@MoshRadix](https://github.com/MoshRadix))
- **Repository**: [github.com/MoshRadix/mosh-timestretch-3](https://github.com/MoshRadix/mosh-timestretch-3)
