import soundtouchWorkletUrl from "@soundtouchjs/audio-worklet?url";

export interface OutputLevels {
  rmsDb: number;
  peakDb: number;
  percent: number;
}

export interface DspSettings {
  speed: number;
  pitchSemitones: number;
  volume: number;
  muted: boolean;
  eqLow: number;
  eqMid: number;
  eqHigh: number;
  noiseReduction: boolean;
  voiceClarity: boolean;
}

export const DEFAULT_DSP_SETTINGS: DspSettings = {
  speed: 1.0,
  pitchSemitones: 0,
  volume: 100,
  muted: false,
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  noiseReduction: false,
  voiceClarity: false,
};

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export class MoshAudioEngine {
  private audioElement: HTMLAudioElement;
  private audioContext: AudioContext | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;

  // Pitch shifting AudioWorklet node + parallel dry/wet bypass
  private pitchWorkletNode: AudioWorkletNode | null = null;
  private pitchDryGain: GainNode | null = null;
  private pitchWetGain: GainNode | null = null;
  private postPitchSum: GainNode | null = null;

  // 3-Band Equalizer
  private eqLowNode: BiquadFilterNode | null = null;
  private eqMidNode: BiquadFilterNode | null = null;
  private eqHighNode: BiquadFilterNode | null = null;

  // Stage 1: Noise Reduction parallel Dry/Wet (Unity 1.0 when OFF)
  private nrDryGain: GainNode | null = null;
  private nrWetGain: GainNode | null = null;
  private nrHighPass: BiquadFilterNode | null = null;
  private nrHumNotch: BiquadFilterNode | null = null;
  private nrLowPass: BiquadFilterNode | null = null;
  private nrMakeupGain: GainNode | null = null;
  private nrOutSum: GainNode | null = null;

  // Stage 2: Voice Clarity parallel Dry/Wet (Unity 1.0 when OFF)
  private vcDryGain: GainNode | null = null;
  private vcWetGain: GainNode | null = null;
  private vcHighPass: BiquadFilterNode | null = null;
  private vcPresencePeak: BiquadFilterNode | null = null;
  private vcCompressor: DynamicsCompressorNode | null = null;
  private vcMakeupGain: GainNode | null = null;
  private vcOutSum: GainNode | null = null;

  // Master Volume + Real-time Analyser
  private masterGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private timeDomainBuf: Float32Array<ArrayBuffer> = new Float32Array(new ArrayBuffer(512 * 4));
  private smoothedPercent = 0;

  private settings: DspSettings = { ...DEFAULT_DSP_SETTINGS };
  private isGraphReady = false;
  private initPromise: Promise<void> | null = null;

  constructor(audioElement: HTMLAudioElement) {
    this.audioElement = audioElement;
    this.enablePitchPreservation();
  }

  private enablePitchPreservation(): void {
    const el = this.audioElement as HTMLAudioElement & {
      preservesPitch?: boolean;
      mozPreservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    el.preservesPitch = true;
    el.mozPreservesPitch = true;
    el.webkitPreservesPitch = true;
  }

  public async ensureInitialized(): Promise<void> {
    if (this.isGraphReady && this.audioContext) {
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    this.initPromise = this.buildGraph();
    await this.initPromise;
  }

  private async buildGraph(): Promise<void> {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    this.audioContext = ctx;

    this.mediaSource = ctx.createMediaElementSource(this.audioElement);

    // Pitch Shift parallel routing
    this.pitchDryGain = ctx.createGain();
    this.pitchWetGain = ctx.createGain();
    this.postPitchSum = ctx.createGain();

    this.mediaSource.connect(this.pitchDryGain);
    this.pitchDryGain.connect(this.postPitchSum);

    // Load @soundtouchjs/audio-worklet processor
    try {
      await ctx.audioWorklet.addModule(soundtouchWorkletUrl);
      this.pitchWorkletNode = new AudioWorkletNode(ctx, "soundtouch-processor");
      this.mediaSource.connect(this.pitchWorkletNode);
      this.pitchWorkletNode.connect(this.pitchWetGain);
      this.pitchWetGain.connect(this.postPitchSum);
    } catch {
      this.pitchWorkletNode = null;
    }

    // 3-Band Equalizer
    this.eqLowNode = ctx.createBiquadFilter();
    this.eqLowNode.type = "lowshelf";
    this.eqLowNode.frequency.value = 120;
    this.eqLowNode.gain.value = this.settings.eqLow;

    this.eqMidNode = ctx.createBiquadFilter();
    this.eqMidNode.type = "peaking";
    this.eqMidNode.frequency.value = 1100;
    this.eqMidNode.Q.value = 0.9;
    this.eqMidNode.gain.value = this.settings.eqMid;

    this.eqHighNode = ctx.createBiquadFilter();
    this.eqHighNode.type = "highshelf";
    this.eqHighNode.frequency.value = 5500;
    this.eqHighNode.gain.value = this.settings.eqHigh;

    this.postPitchSum.connect(this.eqLowNode);
    this.eqLowNode.connect(this.eqMidNode);
    this.eqMidNode.connect(this.eqHighNode);

    // Stage 1: Noise Reduction (True Unity-Gain Parallel Dry/Wet Bypass)
    this.nrDryGain = ctx.createGain();
    this.nrWetGain = ctx.createGain();
    this.nrOutSum = ctx.createGain();

    this.nrHighPass = ctx.createBiquadFilter();
    this.nrHighPass.type = "highpass";
    this.nrHighPass.frequency.value = 105;
    this.nrHighPass.Q.value = 0.707;

    this.nrHumNotch = ctx.createBiquadFilter();
    this.nrHumNotch.type = "notch";
    this.nrHumNotch.frequency.value = 50;
    this.nrHumNotch.Q.value = 10;

    this.nrLowPass = ctx.createBiquadFilter();
    this.nrLowPass.type = "lowpass";
    this.nrLowPass.frequency.value = 6800;
    this.nrLowPass.Q.value = 0.707;

    this.nrMakeupGain = ctx.createGain();
    this.nrMakeupGain.gain.value = dbToLinear(1.5); // +1.5 dB makeup gain

    // Dry path
    this.eqHighNode.connect(this.nrDryGain);
    this.nrDryGain.connect(this.nrOutSum);

    // Wet path
    this.eqHighNode.connect(this.nrHighPass);
    this.nrHighPass.connect(this.nrHumNotch);
    this.nrHumNotch.connect(this.nrLowPass);
    this.nrLowPass.connect(this.nrMakeupGain);
    this.nrMakeupGain.connect(this.nrWetGain);
    this.nrWetGain.connect(this.nrOutSum);

    // Stage 2: Voice Clarity (True Unity-Gain Parallel Dry/Wet Bypass)
    this.vcDryGain = ctx.createGain();
    this.vcWetGain = ctx.createGain();
    this.vcOutSum = ctx.createGain();

    this.vcHighPass = ctx.createBiquadFilter();
    this.vcHighPass.type = "highpass";
    this.vcHighPass.frequency.value = 130;
    this.vcHighPass.Q.value = 0.707;

    this.vcPresencePeak = ctx.createBiquadFilter();
    this.vcPresencePeak.type = "peaking";
    this.vcPresencePeak.frequency.value = 2400;
    this.vcPresencePeak.Q.value = 1.1;
    this.vcPresencePeak.gain.value = 4.5;

    this.vcCompressor = ctx.createDynamicsCompressor();
    this.vcCompressor.threshold.value = -22;
    this.vcCompressor.knee.value = 12;
    this.vcCompressor.ratio.value = 2.5;
    this.vcCompressor.attack.value = 0.008;
    this.vcCompressor.release.value = 0.16;

    this.vcMakeupGain = ctx.createGain();
    this.vcMakeupGain.gain.value = 1.22;

    // Dry path
    this.nrOutSum.connect(this.vcDryGain);
    this.vcDryGain.connect(this.vcOutSum);

    // Wet path
    this.nrOutSum.connect(this.vcHighPass);
    this.vcHighPass.connect(this.vcPresencePeak);
    this.vcPresencePeak.connect(this.vcCompressor);
    this.vcCompressor.connect(this.vcMakeupGain);
    this.vcMakeupGain.connect(this.vcWetGain);
    this.vcWetGain.connect(this.vcOutSum);

    // Master Volume -> Analyser -> Destination
    this.masterGain = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.25;
    this.timeDomainBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4));

    this.vcOutSum.connect(this.masterGain);
    this.masterGain.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.isGraphReady = true;
    this.applyAllSettings(this.settings);
  }

  public applyAllSettings(next: DspSettings): void {
    this.settings = { ...next };
    this.setSpeed(next.speed);
    this.setPitchSemitones(next.pitchSemitones);
    this.setVolume(next.volume, next.muted);
    this.setEq(next.eqLow, next.eqMid, next.eqHigh);
    this.setNoiseReduction(next.noiseReduction);
    this.setVoiceClarity(next.voiceClarity);
  }

  public setSpeed(rate: number): void {
    const clamped = Math.max(0.5, Math.min(2.0, Number(rate.toFixed(2))));
    this.settings.speed = clamped;
    this.enablePitchPreservation();
    this.audioElement.playbackRate = clamped;
    this.audioElement.defaultPlaybackRate = clamped;
  }

  public setPitchSemitones(semitones: number): void {
    const clamped = Math.max(-12, Math.min(12, Math.round(semitones)));
    this.settings.pitchSemitones = clamped;

    if (!this.pitchDryGain || !this.pitchWetGain) return;

    if (clamped === 0 || !this.pitchWorkletNode) {
      this.pitchDryGain.gain.value = 1.0;
      this.pitchWetGain.gain.value = 0.0;
    } else {
      const param = this.pitchWorkletNode.parameters.get("pitchSemitones");
      if (param) {
        param.value = clamped;
      }
      this.pitchDryGain.gain.value = 0.0;
      this.pitchWetGain.gain.value = 1.0;
    }
  }

  public setVolume(volumePercent: number, muted: boolean): void {
    const clamped = Math.max(0, Math.min(100, volumePercent));
    this.settings.volume = clamped;
    this.settings.muted = muted;

    const linear = muted ? 0.0 : clamped / 100.0;
    if (this.masterGain) {
      this.masterGain.gain.value = linear;
    } else {
      this.audioElement.volume = linear;
    }
  }

  public setEq(lowDb: number, midDb: number, highDb: number): void {
    this.settings.eqLow = Math.max(-12, Math.min(12, lowDb));
    this.settings.eqMid = Math.max(-12, Math.min(12, midDb));
    this.settings.eqHigh = Math.max(-12, Math.min(12, highDb));

    if (this.eqLowNode) this.eqLowNode.gain.value = this.settings.eqLow;
    if (this.eqMidNode) this.eqMidNode.gain.value = this.settings.eqMid;
    if (this.eqHighNode) this.eqHighNode.gain.value = this.settings.eqHigh;
  }

  public setNoiseReduction(enabled: boolean): void {
    this.settings.noiseReduction = enabled;
    if (this.nrDryGain && this.nrWetGain) {
      this.nrDryGain.gain.value = enabled ? 0.0 : 1.0;
      this.nrWetGain.gain.value = enabled ? 1.0 : 0.0;
    }
  }

  public setVoiceClarity(enabled: boolean): void {
    this.settings.voiceClarity = enabled;
    if (this.vcDryGain && this.vcWetGain) {
      this.vcDryGain.gain.value = enabled ? 0.0 : 1.0;
      this.vcWetGain.gain.value = enabled ? 1.0 : 0.0;
    }
  }

  public getOutputLevels(): OutputLevels {
    if (!this.analyser || this.audioElement.paused) {
      this.smoothedPercent = 0;
      return { rmsDb: -60, peakDb: -60, percent: 0 };
    }

    this.analyser.getFloatTimeDomainData(this.timeDomainBuf);
    let sumSq = 0;
    let peak = 0;
    const len = this.timeDomainBuf.length;

    for (let i = 0; i < len; i++) {
      const s = this.timeDomainBuf[i];
      const abs = Math.abs(s);
      sumSq += s * s;
      if (abs > peak) peak = abs;
    }

    const rms = Math.sqrt(sumSq / len);
    const rmsDb = rms > 1e-5 ? Math.max(-60, Math.min(0, 20 * Math.log10(rms))) : -60;
    const peakDb = peak > 1e-5 ? Math.max(-60, Math.min(0, 20 * Math.log10(peak))) : -60;

    // Responsive studio meter curve (-52 dB floor to 0 dB ceiling, weighted with peak)
    const rmsNorm = Math.max(0, Math.min(100, ((rmsDb + 52) / 52) * 100));
    const peakNorm = Math.max(0, Math.min(100, ((peakDb + 52) / 52) * 100));
    const targetPercent = Math.min(100, rmsNorm * 0.65 + peakNorm * 0.35);

    // Instant attack on transients, smooth ballistic release decay
    if (targetPercent >= this.smoothedPercent) {
      this.smoothedPercent = targetPercent;
    } else {
      this.smoothedPercent = Math.max(targetPercent, this.smoothedPercent * 0.84);
      if (this.smoothedPercent < 0.4) this.smoothedPercent = 0;
    }

    return { rmsDb, peakDb, percent: this.smoothedPercent };
  }
}
