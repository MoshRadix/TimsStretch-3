export type RecorderStatus = "ready" | "recording" | "paused" | "stopped";

export interface RecorderMeterFrame {
  rmsDb: number;
  peakDb: number;
  percent: number;
  peakPercent: number;
  clipping: boolean;
  elapsedSeconds: number;
}

export interface CompletedRecording {
  pcmSamples: Float32Array;
  sampleRate: number;
  durationSeconds: number;
  wavBlob: Blob;
  objectUrl: string;
}

export function encodeMonoPcm16WavBlob(
  samples: Float32Array,
  sampleRate: number
): Blob {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    const int16 = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(offset, Math.round(int16), true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function applyGainWithSoftClip(sample: number, gain: number): number {
  const v = sample * gain;
  const abs = Math.abs(v);
  if (abs <= 0.85) {
    return v;
  }
  const sign = v < 0 ? -1 : 1;
  return sign * (0.85 + 0.15 * Math.tanh((abs - 0.85) / 0.15));
}

export class LiveWavRecorder {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  private chunks: Float32Array[] = [];
  private totalSamples = 0;
  private sampleRate = 44100;
  private status: RecorderStatus = "ready";
  private micGain = 1.5; // Default 150% (+3.5 dB) boost for low raw mic inputs
  private onMeterCallback?: (frame: RecorderMeterFrame) => void;

  public setMicGain(gain: number): void {
    this.micGain = Math.max(0.1, Math.min(5.0, gain));
  }

  public getMicGain(): number {
    return this.micGain;
  }

  private async ensureStreamAndGraph(): Promise<void> {
    if (this.stream && this.audioCtx && this.processorNode) {
      if (this.audioCtx.state === "suspended") {
        await this.audioCtx.resume();
      }
      return;
    }

    await this.cleanupStream();

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });

    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    this.audioCtx = new AudioCtx();
    this.sampleRate = this.audioCtx.sampleRate || 44100;

    this.sourceNode = this.audioCtx.createMediaStreamSource(this.stream);
    this.processorNode = this.audioCtx.createScriptProcessor(2048, 1, 1);
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;

    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const len = input.length;
      const gain = this.micGain;
      const isRecording = this.status === "recording";
      const copy = isRecording ? new Float32Array(len) : null;

      let sumSq = 0;
      let peak = 0;
      let clipped = false;

      for (let i = 0; i < len; i++) {
        const raw = input[i] * gain;
        if (Math.abs(raw) >= 0.99) {
          clipped = true;
        }
        const v = applyGainWithSoftClip(input[i], gain);
        if (copy) {
          copy[i] = v;
        }
        const a = Math.abs(v);
        sumSq += v * v;
        if (a > peak) peak = a;
      }

      if (copy && isRecording) {
        this.chunks.push(copy);
        this.totalSamples += len;
      }

      if (this.status === "paused") {
        return;
      }

      const rms = Math.sqrt(sumSq / len);
      const rmsDb =
        rms > 1e-5 ? Math.max(-60, Math.min(0, 20 * Math.log10(rms))) : -60;
      const peakDb =
        peak > 1e-5 ? Math.max(-60, Math.min(0, 20 * Math.log10(peak))) : -60;

      // Responsive studio meter curve (-52 dB floor to 0 dB ceiling, weighted with peak)
      const rmsNorm = Math.max(0, Math.min(100, ((rmsDb + 52) / 52) * 100));
      const peakNorm = Math.max(0, Math.min(100, ((peakDb + 52) / 52) * 100));
      const percent = Math.min(100, rmsNorm * 0.65 + peakNorm * 0.35);

      this.onMeterCallback?.({
        rmsDb,
        peakDb,
        percent,
        peakPercent: peakNorm,
        clipping: clipped,
        elapsedSeconds: this.totalSamples / this.sampleRate,
      });
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);
  }

  public async startMonitoring(
    onMeter: (frame: RecorderMeterFrame) => void
  ): Promise<void> {
    this.onMeterCallback = onMeter;
    if (this.status !== "recording" && this.status !== "paused") {
      this.status = "ready";
    }
    await this.ensureStreamAndGraph();
  }

  public async start(
    onMeter?: (frame: RecorderMeterFrame) => void
  ): Promise<void> {
    this.chunks = [];
    this.totalSamples = 0;
    if (onMeter) {
      this.onMeterCallback = onMeter;
    }
    await this.ensureStreamAndGraph();
    this.status = "recording";
  }

  public pause(): void {
    if (this.status === "recording") {
      this.status = "paused";
    }
  }

  public resume(): void {
    if (this.status === "paused") {
      this.status = "recording";
    }
  }

  public async stop(): Promise<CompletedRecording> {
    this.status = "stopped";
    const merged = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const sr = this.sampleRate;
    const durationSeconds = sr > 0 ? merged.length / sr : 0;
    const wavBlob = encodeMonoPcm16WavBlob(merged, sr);
    const objectUrl = URL.createObjectURL(wavBlob);

    return {
      pcmSamples: merged,
      sampleRate: sr,
      durationSeconds,
      wavBlob,
      objectUrl,
    };
  }

  public async cleanupStream(): Promise<void> {
    try {
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
      this.silentGain?.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    this.processorNode = null;
    this.sourceNode = null;
    this.silentGain = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
      this.stream = null;
    }

    if (this.audioCtx) {
      try {
        await this.audioCtx.close();
      } catch {
        // Ignore close errors
      }
      this.audioCtx = null;
    }
  }
}
