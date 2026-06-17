// audio/voices.js
// Six wav-backed granular voices. Scheduler-facing API remains unchanged:
// buildVoiceBus, setVoiceLevel, triggerVoice, shapeVoiceForMotion.

import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm';

const GRANULAR_WAV_FILES = [
  'trimmed/NHU05079160-trim.wav',
  'trimmed/NHU05093004-trim.wav',
  'trimmed/07070189-trim.wav',
  'trimmed/07070190-trim.wav',
  'trimmed/07070191-trim.wav',
  'trimmed/07074118-trim.wav',
];
const requestedAudioPerf = new URLSearchParams(window.location.search).get('audioPerf');
const AUDIO_PERF_MODE = (requestedAudioPerf === 'high' || requestedAudioPerf === 'balanced')
  ? requestedAudioPerf
  : 'safe';
const requestedAudioRich = new URLSearchParams(window.location.search).get('audioRich');
const AUDIO_RICH_MODE = requestedAudioRich === 'pitchDelay' ? 'pitchDelay' : 'delay';
const USE_PERSISTENT_SAFE_GRAINS = AUDIO_PERF_MODE === 'safe';
const USE_SAFE_PITCH_DELAY = USE_PERSISTENT_SAFE_GRAINS && AUDIO_RICH_MODE === 'pitchDelay';

const VOICE_TRIM_DB = [-2, -4, -5, -4, -8, -3];
const VOICE_OCTAVE_OFFSET = [-1, 0, 1, 0, 0, 1];
const VOICE_BASE_MIDI = [43, 50, 62, 55, 67, 72];
const VOICE_FILTER_TYPE = ['lowpass', 'bandpass', 'highpass', 'lowpass', 'highpass', 'bandpass'];
const VOICE_FILTER_Q = [0.8, 1.3, 0.7, 1.1, 1.7, 1.0];
const VOICE_SCAN_CENTER = [0.12, 0.26, 0.42, 0.58, 0.74, 0.86];
const VOICE_SCAN_WIDTH = [0.0065, 0.0075, 0.0085, 0.0070, 0.0080, 0.0068];
const VOICE_PAN_CENTER = [-0.28, -0.16, -0.08, 0.08, 0.16, 0.28];
const VOICE_PAN_SPREAD_SCALE = [0.72, 0.82, 0.92, 0.92, 0.82, 0.72];
const VOICE_RATE_BIAS = [0.90, 0.98, 1.08, 0.94, 1.16, 1.04];
const VOICE_RATE_JITTER = [0.026, 0.032, 0.040, 0.030, 0.046, 0.038];
const VOICE_RATE_WARP_DEPTH = [0.08, 0.11, 0.15, 0.10, 0.18, 0.14];
const VOICE_COLOR_AMP = [1.12, 1.06, 1.08, 1.04, 0.98, 1.02];
const VOICE_PITCH_RATIO = [8.0, 8.0, 8.0, 8.0, 8.0, 8.0];
const VOICE_ENV_ATTACK_SCALE = [1.85, 0.82, 0.46, 2.35, 0.28, 1.18];
const VOICE_ENV_SUSTAIN_SCALE = [1.12, 0.84, 0.58, 1.42, 0.42, 0.76];
const VOICE_ENV_RELEASE_SCALE = [1.48, 0.78, 0.52, 1.90, 0.34, 1.16];
const VOICE_ENV_GAIN_HOLD = [0.96, 0.86, 0.76, 1.05, 0.70, 0.82];
const VOICE_ENV_RANDOMNESS = [0.16, 0.22, 0.28, 0.12, 0.34, 0.24];
const VOICE_GRAIN_SIZE_LFO_RATE = [0.031, 0.047, 0.069, 0.023, 0.083, 0.057];
const VOICE_GRAIN_SIZE_LFO_DEPTH = [0.22, 0.30, 0.26, 0.18, 0.34, 0.28];
const VOICE_START_LFO_RATE = [0.013, 0.019, 0.029, 0.011, 0.037, 0.025];
const VOICE_START_LFO_DEPTH = [0.34, 0.42, 0.48, 0.30, 0.56, 0.44];
const MAX_ACTIVE_GRAINS = 16;
const MAX_GRAINS_PER_NOTE = 1;
const MAX_ACTIVE_CLOUDS_PER_VOICE = 3;
const SAFE_ACTIVE_GRAINS_PER_VOICE = 1;
const TWO_PI = Math.PI * 2;

let sampleCache = null;
let sampleLoadPromise = null;
let activeGrainCount = 0;
let currentVoiceCount = 0;
let currentGrainModState = [];
let currentEffectState = {
  delayTime: 0.19,
  feedback: 0.28,
  wet: 0.18,
  pitch: 0,
  followColor: null,
};
const globalCloudQueue = [];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function slowDroneAmount(motionNorm) {
  const slow = clamp((0.58 - motionNorm) / 0.58, 0, 1);
  return Math.pow(slow, 1.35);
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function setToneParam(param, value, seconds = 0.18) {
  if (!param || !Number.isFinite(value)) return;
  try {
    if (typeof param.rampTo === 'function') {
      param.rampTo(value, seconds);
      return;
    }
    const now = Tone.now();
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(now);
    if (typeof param.setValueAtTime === 'function') {
      const current = Number.isFinite(param.value) ? param.value : value;
      param.setValueAtTime(current, now);
    }
    if (typeof param.linearRampToValueAtTime === 'function') {
      param.linearRampToValueAtTime(value, now + seconds);
    } else if ('value' in param) {
      param.value = value;
    }
  } catch (e) {
    try {
      if ('value' in param) param.value = value;
    } catch (ignored) {}
  }
}

function triBlend(values, t) {
  const x = clamp(t, 0, 1);
  if (x <= 0.5) return lerp(values[0], values[1], x * 2);
  return lerp(values[1], values[2], (x - 0.5) * 2);
}

function applyPatch(node, patch) {
  if (!node || !patch) return;
  try {
    node.set(patch);
  } catch (e) {
    // Best effort patching is fine when dynamic params are missing.
  }
}

function unregisterGlobalCloud(cloud) {
  const idx = globalCloudQueue.indexOf(cloud);
  if (idx >= 0) globalCloudQueue.splice(idx, 1);
}

function blendObjectMorph(source, t) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return source;
  }
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value) && value.length === 3) out[key] = triBlend(value, t);
    else if (value && typeof value === 'object') out[key] = blendObjectMorph(value, t);
    else out[key] = value;
  }
  return out;
}

// Keep existing duration/velocity shaping so scheduler behavior remains intact.
const VOICE_MORPH = [
  {
    dur: [1.45, 1.04, 0.64],
    vel: [0.82, 1.00, 1.14],
    grain: {
      grainSize: [0.120, 0.088, 0.060],
      grainSizeJitter: [0.18, 0.26, 0.34],
      overlap: [0.088, 0.066, 0.044],
      cloudSize: [4, 6, 8],
      grainDensity: [0.85, 1.20, 1.70],
      grainSpacing: [0.018, 0.010, 0.0055],
      grainSpacingJitter: [0.009, 0.007, 0.004],
      posJitter: [0.08, 0.15, 0.26],
      detuneJitter: [10, 22, 42],
      panSpread: [0.18, 0.32, 0.58],
      reverseProb: [0.08, 0.16, 0.26],
      offsetDrift: [0.020, 0.045, 0.085],
      scanLfoRate: [0.018, 0.050, 0.120],
      scanLfoDepth: [0.08, 0.16, 0.24],
      intraNoteScan: [0.018, 0.040, 0.080],
      brightnessHz: [1800, 3200, 5200],
      grainDurScale: [1.16, 0.92, 0.62],
      cloudAmp: [0.90, 1.00, 1.08],
    },
    tremolo: { frequency: [0.18, 0.72, 3.8], depth: [0.12, 0.34, 0.78], wet: [0.18, 0.48, 0.92] },
    vibrato: { frequency: [0.08, 0.24, 1.4], depth: [0.01, 0.03, 0.08], wet: [0.10, 0.18, 0.34] },
  },
  {
    dur: [1.34, 1.00, 0.76],
    vel: [0.86, 1.00, 1.12],
    grain: {
      grainSize: [0.108, 0.078, 0.052], grainSizeJitter: [0.20, 0.28, 0.36], overlap: [0.080, 0.058, 0.038], cloudSize: [4, 6, 9],
      grainDensity: [0.90, 1.28, 1.80], grainSpacing: [0.017, 0.0095, 0.0052], grainSpacingJitter: [0.008, 0.006, 0.004],
      posJitter: [0.09, 0.17, 0.30], detuneJitter: [12, 24, 44], panSpread: [0.16, 0.30, 0.60],
      reverseProb: [0.06, 0.14, 0.24], offsetDrift: [0.022, 0.050, 0.090], scanLfoRate: [0.020, 0.055, 0.130],
      scanLfoDepth: [0.09, 0.17, 0.25], intraNoteScan: [0.020, 0.045, 0.085],
      brightnessHz: [2100, 3600, 6500], grainDurScale: [1.10, 0.88, 0.60], cloudAmp: [0.92, 1.00, 1.10],
    },
    tremolo: { frequency: [0.10, 1.10, 6.40], depth: [0.08, 0.42, 0.90], wet: [0.10, 0.55, 0.96] },
    vibrato: { frequency: [0.16, 1.60, 8.80], depth: [0.02, 0.10, 0.34], wet: [0.18, 0.46, 0.92] },
  },
  {
    dur: [1.24, 0.98, 0.78],
    vel: [0.84, 1.00, 1.16],
    grain: {
      grainSize: [0.096, 0.070, 0.048], grainSizeJitter: [0.22, 0.30, 0.38], overlap: [0.074, 0.052, 0.034], cloudSize: [5, 7, 10],
      grainDensity: [0.96, 1.36, 1.94], grainSpacing: [0.016, 0.009, 0.0048], grainSpacingJitter: [0.008, 0.006, 0.004],
      posJitter: [0.10, 0.18, 0.32], detuneJitter: [14, 28, 52], panSpread: [0.20, 0.35, 0.66],
      reverseProb: [0.08, 0.16, 0.28], offsetDrift: [0.025, 0.055, 0.100], scanLfoRate: [0.024, 0.065, 0.150],
      scanLfoDepth: [0.10, 0.18, 0.28], intraNoteScan: [0.024, 0.048, 0.090],
      brightnessHz: [2800, 4800, 8400], grainDurScale: [1.02, 0.84, 0.56], cloudAmp: [0.90, 1.00, 1.12],
    },
    tremolo: { frequency: [0.22, 2.40, 9.50], depth: [0.18, 0.56, 0.96], wet: [0.12, 0.62, 1.00] },
    vibrato: { frequency: [0.35, 2.10, 11.50], depth: [0.03, 0.12, 0.40], wet: [0.12, 0.50, 0.98] },
  },
  {
    dur: [1.72, 1.06, 0.62],
    vel: [0.82, 1.00, 1.08],
    grain: {
      grainSize: [0.135, 0.096, 0.064], grainSizeJitter: [0.16, 0.24, 0.32], overlap: [0.098, 0.072, 0.048], cloudSize: [4, 5, 7],
      grainDensity: [0.78, 1.08, 1.50], grainSpacing: [0.020, 0.011, 0.0060], grainSpacingJitter: [0.010, 0.007, 0.005],
      posJitter: [0.06, 0.13, 0.24], detuneJitter: [9, 18, 34], panSpread: [0.14, 0.26, 0.50],
      reverseProb: [0.05, 0.10, 0.18], offsetDrift: [0.018, 0.038, 0.070], scanLfoRate: [0.014, 0.040, 0.100],
      scanLfoDepth: [0.07, 0.14, 0.22], intraNoteScan: [0.016, 0.036, 0.072],
      brightnessHz: [1600, 2800, 4200], grainDurScale: [1.18, 0.94, 0.66], cloudAmp: [0.95, 1.00, 1.06],
    },
    tremolo: { frequency: [0.06, 0.44, 2.80], depth: [0.20, 0.40, 0.72], wet: [0.16, 0.42, 0.78] },
    vibrato: { frequency: [0.04, 0.18, 1.60], depth: [0.03, 0.07, 0.18], wet: [0.22, 0.34, 0.60] },
  },
  {
    dur: [1.06, 0.90, 0.68],
    vel: [0.90, 1.00, 1.12],
    grain: {
      grainSize: [0.084, 0.060, 0.042], grainSizeJitter: [0.24, 0.34, 0.44], overlap: [0.064, 0.044, 0.028], cloudSize: [6, 8, 12],
      grainDensity: [1.08, 1.56, 2.10], grainSpacing: [0.014, 0.008, 0.0044], grainSpacingJitter: [0.007, 0.005, 0.003],
      posJitter: [0.12, 0.22, 0.38], detuneJitter: [18, 36, 60], panSpread: [0.24, 0.42, 0.74],
      reverseProb: [0.12, 0.20, 0.34], offsetDrift: [0.030, 0.072, 0.120], scanLfoRate: [0.028, 0.075, 0.180],
      scanLfoDepth: [0.12, 0.22, 0.32], intraNoteScan: [0.026, 0.054, 0.100],
      brightnessHz: [3200, 6200, 9800], grainDurScale: [0.96, 0.78, 0.50], cloudAmp: [0.88, 1.00, 1.16],
    },
    tremolo: { frequency: [0.40, 5.20, 14.00], depth: [0.08, 0.64, 1.00], wet: [0.10, 0.68, 1.00] },
    vibrato: { frequency: [0.24, 3.80, 12.80], depth: [0.01, 0.14, 0.46], wet: [0.08, 0.56, 1.00] },
  },
  {
    dur: [1.42, 1.00, 0.72],
    vel: [0.84, 1.00, 1.14],
    grain: {
      grainSize: [0.102, 0.074, 0.050], grainSizeJitter: [0.22, 0.30, 0.38], overlap: [0.076, 0.054, 0.036], cloudSize: [5, 7, 10],
      grainDensity: [0.92, 1.32, 1.88], grainSpacing: [0.016, 0.009, 0.0048], grainSpacingJitter: [0.008, 0.006, 0.004],
      posJitter: [0.10, 0.18, 0.34], detuneJitter: [14, 28, 50], panSpread: [0.20, 0.36, 0.66],
      reverseProb: [0.08, 0.16, 0.28], offsetDrift: [0.024, 0.056, 0.098], scanLfoRate: [0.022, 0.060, 0.145],
      scanLfoDepth: [0.10, 0.18, 0.28], intraNoteScan: [0.022, 0.046, 0.090],
      brightnessHz: [2400, 4500, 7600], grainDurScale: [1.06, 0.86, 0.56], cloudAmp: [0.90, 1.00, 1.12],
    },
    tremolo: { frequency: [0.14, 1.80, 7.60], depth: [0.10, 0.48, 0.94], wet: [0.12, 0.58, 0.98] },
    vibrato: { frequency: [0.10, 1.20, 9.00], depth: [0.04, 0.16, 0.50], wet: [0.18, 0.54, 1.00] },
  },
];

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function deriveScanHotspots(buffer, fallbackCenter) {
  try {
    let channel = null;
    if (typeof buffer?.toArray === 'function') {
      const arrayData = buffer.toArray();
      if (Array.isArray(arrayData)) channel = arrayData[0];
      else channel = arrayData;
    } else if (typeof buffer?.getChannelData === 'function') {
      channel = buffer.getChannelData(0);
    }
    if (!channel || !channel.length) return [fallbackCenter];

    const windowSize = Math.max(512, Math.floor(channel.length / 192));
    const windows = [];
    for (let start = 0; start < channel.length; start += windowSize) {
      const end = Math.min(channel.length, start + windowSize);
      let sum = 0;
      for (let i = start; i < end; i++) sum += Math.abs(channel[i]);
      const meanAbs = sum / Math.max(1, end - start);
      windows.push({ start, end, meanAbs });
    }

    windows.sort((a, b) => b.meanAbs - a.meanAbs);
    const selected = [];
    const minGap = windowSize * 5;
    for (const entry of windows) {
      const center = (entry.start + entry.end) * 0.5;
      if (selected.some((picked) => Math.abs(picked - center) < minGap)) continue;
      if (entry.meanAbs < 0.01 && selected.length > 0) continue;
      selected.push(center);
      if (selected.length >= 6) break;
    }

    if (!selected.length) return [fallbackCenter];
    return selected
      .map((center) => clamp(center / channel.length, 0.02, 0.98))
      .sort((a, b) => a - b);
  } catch (error) {
    return [fallbackCenter];
  }
}

class GranularSynth {
  constructor({ buffer, output, colorIndex }) {
    this.buffer = buffer;
    this.output = output;
    this.colorIndex = colorIndex;
    this.baseMidi = VOICE_BASE_MIDI[colorIndex % VOICE_BASE_MIDI.length];
    this.scanCenter = VOICE_SCAN_CENTER[colorIndex % VOICE_SCAN_CENTER.length];
    this.scanWidth = VOICE_SCAN_WIDTH[colorIndex % VOICE_SCAN_WIDTH.length];
    this.panCenter = VOICE_PAN_CENTER[colorIndex % VOICE_PAN_CENTER.length];
    this.panSpreadScale = VOICE_PAN_SPREAD_SCALE[colorIndex % VOICE_PAN_SPREAD_SCALE.length];
    this.rateBias = VOICE_RATE_BIAS[colorIndex % VOICE_RATE_BIAS.length];
    this.rateJitter = VOICE_RATE_JITTER[colorIndex % VOICE_RATE_JITTER.length];
    this.rateWarpDepth = VOICE_RATE_WARP_DEPTH[colorIndex % VOICE_RATE_WARP_DEPTH.length];
    this.colorAmp = VOICE_COLOR_AMP[colorIndex % VOICE_COLOR_AMP.length];
    this.pitchRatio = VOICE_PITCH_RATIO[colorIndex % VOICE_PITCH_RATIO.length];
    this.envAttackScale = VOICE_ENV_ATTACK_SCALE[colorIndex % VOICE_ENV_ATTACK_SCALE.length];
    this.envSustainScale = VOICE_ENV_SUSTAIN_SCALE[colorIndex % VOICE_ENV_SUSTAIN_SCALE.length];
    this.envReleaseScale = VOICE_ENV_RELEASE_SCALE[colorIndex % VOICE_ENV_RELEASE_SCALE.length];
    this.envGainHold = VOICE_ENV_GAIN_HOLD[colorIndex % VOICE_ENV_GAIN_HOLD.length];
    this.envRandomness = VOICE_ENV_RANDOMNESS[colorIndex % VOICE_ENV_RANDOMNESS.length];
    this.grainSizeLfoRate = VOICE_GRAIN_SIZE_LFO_RATE[colorIndex % VOICE_GRAIN_SIZE_LFO_RATE.length];
    this.grainSizeLfoDepth = VOICE_GRAIN_SIZE_LFO_DEPTH[colorIndex % VOICE_GRAIN_SIZE_LFO_DEPTH.length];
    this.startLfoRate = VOICE_START_LFO_RATE[colorIndex % VOICE_START_LFO_RATE.length];
    this.startLfoDepth = VOICE_START_LFO_DEPTH[colorIndex % VOICE_START_LFO_DEPTH.length];
    this.hotspots = deriveScanHotspots(buffer, this.scanCenter);
    this.motion = {
      grainSize: 0.074,
      grainSizeJitter: 0.30,
      overlap: 0.054,
      cloudSize: 4,
      grainDensity: 1.02,
      grainSpacing: 0.007,
      grainSpacingJitter: 0.006,
      posJitter: 0.08,
      detuneJitter: 40,
      panSpread: 0.32,
      reverseProb: 0.24,
      offsetDrift: 0.07,
      scanLfoRate: 0.05,
      scanLfoDepth: 0.16,
      intraNoteScan: 0.05,
      brightnessHz: 4200,
      grainDurScale: 0.68,
      cloudAmp: 1.0,
    };
    this._seed = ((colorIndex + 1) * 2654435761) >>> 0;
    this._activeClouds = new Set();
    this._cloudQueue = [];
    this._hotspotIndex = clampInt(this.hotspots.length * this._rand(), 0, Math.max(0, this.hotspots.length - 1));
    this._scanPosNorm = this.hotspots[this._hotspotIndex] ?? this.scanCenter;
    this._scanPhaseA = this._rand() * Math.PI * 2;
    this._scanPhaseB = this._rand() * Math.PI * 2;
    this._grainSizePhase = this._rand() * TWO_PI;
    this._startLfoPhase = this._rand() * TWO_PI;
    this._scanDriftDir = this._rand() < 0.5 ? -1 : 1;
    this._lastGrainSize = 0;
    this._lastLoopStart = 0;
    this._safePlayer = null;
    this._safeFilter = null;
    this._safePanner = null;
    this._safeGain = null;
    this._safeStarted = false;
    this.disposed = false;
  }

  set(patch) {
    if (!patch) return this;
    this.motion = { ...this.motion, ...patch };
    return this;
  }

  triggerAttackRelease(freq, durSeconds, time, velocity = 0.7) {
    if (this.disposed || !this.buffer) return;
    const hz = Number(freq);
    if (!Number.isFinite(hz) || hz <= 0) return;
    if (USE_PERSISTENT_SAFE_GRAINS) {
      this._triggerPersistentSafeGrain(hz, durSeconds, time, velocity);
      return;
    }

    const now = Tone.now();
    const startAt = Number.isFinite(time) ? Math.max(time, now) : now;
    const noteDur = Math.max(0.05, durSeconds || 0.25);
    const vel = clamp(velocity, 0.05, 1);
    const midi = Tone.Frequency(hz).toMidi();
    const semitones = midi - this.baseMidi;
    const rateFromPitch = Math.pow(2, semitones / 12);

    const cloudFloor = clampInt(this.motion.cloudSize, 1, 10);
    const grainDensity = clamp((this.motion.grainDensity ?? 1) * 1.02, 0.6, 2.6);
    const motionNorm = clamp((grainDensity - 0.7) / 1.9, 0, 1);
    const grainSizeBase = clamp(this.motion.grainSize * 0.82, 0.032, 0.120);
    const grainSize = clamp(
      grainSizeBase * (1 + this._grainSizeLfoValue(startAt) * this.grainSizeLfoDepth),
      0.030,
      0.135
    );
    const grainSizeJitter = clamp(this.motion.grainSizeJitter ?? 0, 0, 0.8);
    const overlap = clamp(this.motion.overlap * 0.82, 0.012, grainSize * 0.82);
    const posJitter = clamp(this.motion.posJitter * 0.10, 0, 0.02);
    const detuneJitter = clamp(this.motion.detuneJitter * 1.8, 0, 160);
    const panSpread = clamp(this.motion.panSpread, 0, 1.0);
    const reverseProb = clamp(this.motion.reverseProb + 0.10, 0, 0.78);
    const drift = clamp(this.motion.offsetDrift, 0, 0.24);
    const scanLfoRate = clamp(this.motion.scanLfoRate ?? 0.05, 0.002, 0.18);
    const scanLfoDepth = clamp((this.motion.scanLfoDepth ?? 0.14) * 0.72, 0, 0.28);
    const intraNoteScan = clamp((this.motion.intraNoteScan ?? 0.05) * 0.28, 0, 0.04);
    const brightnessHz = clamp(this.motion.brightnessHz, 400, 12000);
    const noteWindow = Math.max(grainSize * 12, noteDur * this.motion.grainDurScale * 1.05);
    const targetGrainCount = clampInt(1 + cloudFloor * 0.12 + grainDensity * 0.24, 1, MAX_GRAINS_PER_NOTE);
    this._ensureVoiceCapacity(targetGrainCount, startAt);
    this._ensureGlobalCapacity(targetGrainCount, startAt);
    const availableGrains = Math.max(0, MAX_ACTIVE_GRAINS - activeGrainCount);
    const grainCount = Math.max(0, Math.min(targetGrainCount, availableGrains));
    if (grainCount === 0) return;

    if (this.hotspots.length > 1 && this._rand() < 0.18) {
      this._hotspotIndex = (this._hotspotIndex + 1 + Math.floor(this._rand() * 2)) % this.hotspots.length;
    }
    const hotspotCenter = this.hotspots[this._hotspotIndex] ?? this.scanCenter;
    const minCenter = Math.max(0.02, hotspotCenter - this.scanWidth);
    const maxCenter = Math.min(0.98, hotspotCenter + this.scanWidth);
    if (this._scanPosNorm < minCenter || this._scanPosNorm > maxCenter) {
      this._scanPosNorm = hotspotCenter;
    }
    const driftStep = clamp(drift * 0.022 + scanLfoRate * 0.005, 0.00015, 0.0016);
    let drifted = this._scanPosNorm + this._scanDriftDir * driftStep;
    if (drifted <= minCenter || drifted >= maxCenter) {
      this._scanDriftDir *= -1;
      drifted = clamp(this._scanPosNorm + this._scanDriftDir * driftStep, minCenter, maxCenter);
    }
    this._scanPosNorm = clamp(drifted, minCenter, maxCenter);

    for (let i = 0; i < grainCount; i++) {
      const progress = grainCount <= 1 ? 0 : i / (grainCount - 1);
      const grainOffsetSecs = i * Math.min(0.018, grainSize * 1.4) + this._randSigned() * 0.004;
      const grainStart = startAt + Math.max(0, grainOffsetSecs);
      const sizeScale = 1 + this._randSigned() * grainSizeJitter;
      const grainPlayDur = clamp(grainSize * sizeScale, 0.030, 0.145);
      const grainOverlap = clamp(Math.min(overlap, grainPlayDur * 0.92), 0.002, 0.12);
      const maxOffset = Math.max(0.001, this.buffer.duration - grainPlayDur - 0.01);
      const scanPhase = grainStart * scanLfoRate * TWO_PI;
      const startLfo = this._startLfoValue(grainStart);
      const lfoOffset =
        Math.sin(this._scanPhaseA + scanPhase + progress * TWO_PI * intraNoteScan) * this.scanWidth * scanLfoDepth * 0.34 +
        Math.sin(this._scanPhaseB + scanPhase * 0.18) * this.scanWidth * scanLfoDepth * 0.18 +
        startLfo * this.scanWidth * this.startLfoDepth * 0.40;
      const sweep = (progress - 0.5) * intraNoteScan * this.scanWidth * 0.10;
      const loopCenterNorm = clamp(this._scanPosNorm + lfoOffset + sweep, 0, 1);
      const loopWidthNorm = clamp(this.scanWidth * 0.58 + grainPlayDur / Math.max(this.buffer.duration, 0.001) * 0.52, 0.0040, 0.0200);
      const loopStartNorm = clamp(loopCenterNorm - loopWidthNorm * 0.5, 0, 1);
      const loopEndNorm = clamp(loopStartNorm + loopWidthNorm, loopStartNorm + 0.0008, 1);
      const loopStart = loopStartNorm * maxOffset;
      const loopEnd = Math.min(maxOffset, loopEndNorm * maxOffset);
      const loopSpan = Math.max(grainPlayDur * 1.4, loopEnd - loopStart);
      const offset = clamp(
        loopStart + loopSpan * (0.5 + this._randSigned() * 0.05 + this._randSigned() * posJitter),
        loopStart,
        Math.max(loopStart, loopEnd - 0.0005)
      );
      const detune = this._randSigned() * detuneJitter;
      const rateWarp =
        1 +
        Math.sin(this._scanPhaseA * 0.73 + scanPhase * 1.2 + progress * Math.PI * 2) * this.rateWarpDepth * 0.75 +
        Math.sin(this._scanPhaseB * 1.11 + scanPhase * 0.41) * this.rateWarpDepth * 0.28;
      const playbackRate = clamp(
        rateFromPitch * this.pitchRatio * this.rateBias * rateWarp * (1 + this._randSigned() * this.rateJitter),
        0.18,
        10.0
      );
      const reverse = this._rand() < reverseProb;

      const player = new Tone.GrainPlayer(this.buffer);
      const filter = new Tone.Filter({
        type: VOICE_FILTER_TYPE[this.colorIndex % VOICE_FILTER_TYPE.length],
        frequency: brightnessHz,
        Q: VOICE_FILTER_Q[this.colorIndex % VOICE_FILTER_Q.length],
      });
      const panSpreadScaled = panSpread * this.panSpreadScale;
      const panner = new Tone.Panner(clamp(this.panCenter + this._randSigned() * panSpreadScaled, -1, 1));
      const gain = new Tone.Gain(0);

      player.grainSize = grainPlayDur;
      player.overlap = grainOverlap;
      player.playbackRate = playbackRate;
      player.detune = detune;
      player.reverse = reverse;
      player.loop = true;
      player.loopStart = loopStart;
      player.loopEnd = Math.max(loopStart + 0.001, loopEnd);
      this._lastGrainSize = grainPlayDur;
      this._lastLoopStart = loopStart;
      currentGrainModState[this.colorIndex] = {
        grainSize: grainPlayDur,
        loopStart,
        grainLfoRate: this.grainSizeLfoRate,
        startLfoRate: this.startLfoRate,
      };

      player.connect(filter);
      filter.connect(panner);
      panner.connect(gain);
      gain.connect(this.output);

      const grainVelocity = clamp((vel * this.motion.cloudAmp * this.colorAmp) / Math.max(1, 0.56 + grainCount * 0.66), 0.12, 1.35);
      const drone = slowDroneAmount(motionNorm);
      const loopMax = lerp(
        (0.42 - motionNorm * 0.32) * clamp(this.envSustainScale, 0.45, 1.45),
        1.05 * clamp(this.envSustainScale, 0.45, 1.35),
        drone
      );
      const loopRunDur = clamp(
        noteWindow * (1.04 - motionNorm * 0.78 + progress * 0.02) * this.envSustainScale * lerp(1, 2.15, drone),
        grainPlayDur * (16 - motionNorm * 10),
        loopMax
      );
      const envJitter = 1 + this._randSigned() * this.envRandomness;
      const attack = clamp(
        grainPlayDur * 0.8 * this.envAttackScale * envJitter * lerp(1, 1.55, drone),
        0.003,
        lerp(0.075, 0.180, drone)
      );
      const releaseMax = lerp(1.45, 2.10, drone);
      const releaseTail = clamp(
        (noteDur * (1.25 - motionNorm * 1.05) + grainPlayDur * (18 - motionNorm * 12)) *
          this.envReleaseScale * (1 + this._randSigned() * this.envRandomness * 0.7) * lerp(1, 1.95, drone),
        0.035,
        releaseMax
      );
      const holdLevel = clamp(grainVelocity * this.envGainHold, 0.0001, 1.35);

      gain.gain.setValueAtTime(0, grainStart);
      gain.gain.linearRampToValueAtTime(grainVelocity, grainStart + attack);
      gain.gain.linearRampToValueAtTime(holdLevel, Math.max(grainStart + attack, grainStart + loopRunDur));
      gain.gain.linearRampToValueAtTime(0.0001, grainStart + loopRunDur + releaseTail);

      player.start(grainStart, offset, loopRunDur + releaseTail + grainOverlap);
      player.stop(grainStart + loopRunDur + releaseTail + grainOverlap + 0.01);

      const cloud = { player, filter, panner, gain, timer: null, owner: this };
      this._activeClouds.add(cloud);
      this._cloudQueue.push(cloud);
      globalCloudQueue.push(cloud);
      activeGrainCount += 1;
      const disposeInMs = Math.max(40, Math.ceil((grainStart + loopRunDur + releaseTail + grainOverlap + 0.08 - Tone.now()) * 1000));
      cloud.timer = setTimeout(() => this._disposeCloud(cloud), disposeInMs);
    }
  }

  _grainSizeLfoValue(time) {
    return Math.sin(this._grainSizePhase + time * this.grainSizeLfoRate * TWO_PI);
  }

  _startLfoValue(time) {
    return Math.sin(this._startLfoPhase + time * this.startLfoRate * TWO_PI);
  }

  _ensurePersistentSafeChain() {
    if (this._safePlayer) return true;
    try {
      const player = new Tone.GrainPlayer(this.buffer);
      const filter = new Tone.Filter({
        type: VOICE_FILTER_TYPE[this.colorIndex % VOICE_FILTER_TYPE.length],
        frequency: this.motion.brightnessHz,
        Q: VOICE_FILTER_Q[this.colorIndex % VOICE_FILTER_Q.length],
      });
      const panner = new Tone.Panner(this.panCenter);
      const gain = new Tone.Gain(0);

      player.loop = true;
      const initialGrainSize = clamp(this.motion.grainSize * 1.02, 0.045, 0.135);
      player.grainSize = initialGrainSize;
      player.overlap = clamp(this.motion.overlap * 0.82, 0.014, initialGrainSize * 0.78);
      player.connect(filter);
      filter.connect(panner);
      panner.connect(gain);
      gain.connect(this.output);

      this._safePlayer = player;
      this._safeFilter = filter;
      this._safePanner = panner;
      this._safeGain = gain;
      activeGrainCount += SAFE_ACTIVE_GRAINS_PER_VOICE;
      return true;
    } catch (e) {
      console.warn('[audio] persistent grain setup failed', e);
      return false;
    }
  }

  _triggerPersistentSafeGrain(freq, durSeconds, time, velocity = 0.7) {
    if (!this._ensurePersistentSafeChain()) return;

    const now = Tone.now();
    const startAt = Number.isFinite(time) ? Math.max(time, now) : now;
    const noteDur = Math.max(0.05, durSeconds || 0.25);
    const vel = clamp(velocity, 0.05, 1);
    const midi = Tone.Frequency(freq).toMidi();
    const semitones = midi - this.baseMidi;
    const rateFromPitch = Math.pow(2, semitones / 12);
    const grainDensity = clamp((this.motion.grainDensity ?? 1) * 1.02, 0.6, 2.6);
    const motionNorm = clamp((grainDensity - 0.7) / 1.9, 0, 1);
    const grainSizeBase = clamp(this.motion.grainSize * 1.02, 0.045, 0.135);
    const grainSize = clamp(
      grainSizeBase * (1 + this._grainSizeLfoValue(startAt) * this.grainSizeLfoDepth),
      0.040,
      0.150
    );
    const grainOverlap = clamp(this.motion.overlap * 0.82, 0.014, grainSize * 0.78);
    const drift = clamp(this.motion.offsetDrift, 0, 0.24);
    const scanLfoRate = clamp(this.motion.scanLfoRate ?? 0.05, 0.002, 0.18);
    const scanLfoDepth = clamp((this.motion.scanLfoDepth ?? 0.14) * 0.45, 0, 0.18);
    const panSpread = clamp(this.motion.panSpread, 0, 1.0) * this.panSpreadScale * 0.55;
    const brightnessHz = clamp(this.motion.brightnessHz, 400, 12000);

    if (this.hotspots.length > 1 && this._rand() < 0.08) {
      this._hotspotIndex = (this._hotspotIndex + 1) % this.hotspots.length;
    }
    const hotspotCenter = this.hotspots[this._hotspotIndex] ?? this.scanCenter;
    const minCenter = Math.max(0.02, hotspotCenter - this.scanWidth);
    const maxCenter = Math.min(0.98, hotspotCenter + this.scanWidth);
    if (this._scanPosNorm < minCenter || this._scanPosNorm > maxCenter) {
      this._scanPosNorm = hotspotCenter;
    }
    const driftStep = clamp(drift * 0.012 + scanLfoRate * 0.0025, 0.00008, 0.0009);
    let drifted = this._scanPosNorm + this._scanDriftDir * driftStep;
    if (drifted <= minCenter || drifted >= maxCenter) {
      this._scanDriftDir *= -1;
      drifted = clamp(this._scanPosNorm + this._scanDriftDir * driftStep, minCenter, maxCenter);
    }
    this._scanPosNorm = clamp(drifted, minCenter, maxCenter);

    const maxOffset = Math.max(0.001, this.buffer.duration - grainSize - 0.01);
    const scanPhase = startAt * scanLfoRate * TWO_PI;
    const startLfo = this._startLfoValue(startAt);
    const lfoOffset =
      Math.sin(this._scanPhaseA + scanPhase) * this.scanWidth * scanLfoDepth * 0.30 +
      Math.sin(this._scanPhaseB + scanPhase * 0.21) * this.scanWidth * scanLfoDepth * 0.16 +
      startLfo * this.scanWidth * this.startLfoDepth * 0.55;
    const loopCenterNorm = clamp(this._scanPosNorm + lfoOffset, 0, 1);
    const loopWidthNorm = clamp(this.scanWidth * 0.62 + grainSize / Math.max(this.buffer.duration, 0.001) * 0.62, 0.0050, 0.0240);
    const loopStart = clamp((loopCenterNorm - loopWidthNorm * 0.5) * maxOffset, 0, maxOffset);
    const minLoopEnd = Math.min(maxOffset, loopStart + grainSize * 1.8);
    const loopEnd = Math.min(maxOffset, Math.max(minLoopEnd, loopStart + loopWidthNorm * maxOffset));
    const rateWarp =
      1 +
      Math.sin(this._scanPhaseA * 0.73 + scanPhase * 0.8) * this.rateWarpDepth * 0.46 +
      Math.sin(this._scanPhaseB * 1.11 + scanPhase * 0.31) * this.rateWarpDepth * 0.16;
    const playbackRate = clamp(
      rateFromPitch * this.pitchRatio * this.rateBias * rateWarp,
      0.18,
      10.0
    );
    const pan = clamp(this.panCenter + this._randSigned() * panSpread, -1, 1);
    const envJitter = 1 + this._randSigned() * this.envRandomness;
    const drone = slowDroneAmount(motionNorm);
    const sustainMax = lerp(0.42, 2.40, drone);
    const sustain = clamp(
      noteDur * (0.70 - motionNorm * 0.34) * this.envSustainScale * envJitter * lerp(1, 2.70, drone),
      0.045,
      sustainMax
    );
    const releaseMax = lerp(0.42, 3.20, drone);
    const release = clamp(
      (noteDur * (0.38 - motionNorm * 0.22) + grainSize * 4) *
        this.envReleaseScale * (1 + this._randSigned() * this.envRandomness * 0.7) * lerp(1, 3.30, drone),
      0.030,
      releaseMax
    );
    const attack = clamp(
      grainSize * 0.65 * this.envAttackScale * envJitter * lerp(1, 1.85, drone),
      0.0035,
      lerp(0.075, 0.220, drone)
    );
    const gainPeak = clamp(vel * this.motion.cloudAmp * this.colorAmp * 0.58, 0.08, 0.58);
    const holdPeak = clamp(gainPeak * this.envGainHold, 0.0001, 0.58);

    try {
      this._safePlayer.grainSize = grainSize;
      this._safePlayer.overlap = grainOverlap;
      this._safePlayer.playbackRate = playbackRate;
      this._safePlayer.detune = this._randSigned() * clamp(this.motion.detuneJitter * 0.7, 0, 90);
      this._safePlayer.reverse = this._rand() < clamp(this.motion.reverseProb * 0.55, 0, 0.42);
      this._safePlayer.loopStart = loopStart;
      this._safePlayer.loopEnd = Math.max(loopStart + 0.001, loopEnd);
      this._lastGrainSize = grainSize;
      this._lastLoopStart = loopStart;
      currentGrainModState[this.colorIndex] = {
        grainSize,
        loopStart,
        grainLfoRate: this.grainSizeLfoRate,
        startLfoRate: this.startLfoRate,
      };
      if (!this._safeStarted) {
        this._safePlayer.start(startAt, loopStart);
        this._safeStarted = true;
      }
      this._safeFilter.frequency.setValueAtTime(brightnessHz, startAt);
      this._safePanner.pan.setValueAtTime(pan, startAt);
      this._safeGain.gain.cancelScheduledValues(startAt);
      this._safeGain.gain.setValueAtTime(Math.max(0.0001, this._safeGain.gain.value || 0.0001), startAt);
      this._safeGain.gain.linearRampToValueAtTime(gainPeak, startAt + attack);
      this._safeGain.gain.linearRampToValueAtTime(holdPeak, startAt + attack + sustain);
      this._safeGain.gain.linearRampToValueAtTime(0.0001, startAt + attack + sustain + release);
    } catch (e) {
      console.warn('[audio] persistent grain trigger failed', e);
    }
  }

  _ensureGlobalCapacity(requiredCount, startAt) {
    let available = MAX_ACTIVE_GRAINS - activeGrainCount;
    if (available >= requiredCount) return;
    let guard = 0;
    while (available < requiredCount && globalCloudQueue.length > 0 && guard < MAX_ACTIVE_GRAINS * 2) {
      guard++;
      const oldest = globalCloudQueue.shift();
      if (!oldest || !oldest.owner) continue;
      oldest.owner._retireCloudEarly(oldest, startAt);
      available = MAX_ACTIVE_GRAINS - activeGrainCount;
    }
  }

  _ensureVoiceCapacity(requiredCount, startAt) {
    let available = MAX_ACTIVE_CLOUDS_PER_VOICE - this._activeClouds.size;
    if (available >= requiredCount) return;
    let guard = 0;
    while (available < requiredCount && this._cloudQueue.length > 0 && guard < MAX_ACTIVE_CLOUDS_PER_VOICE * 2) {
      guard++;
      const oldest = this._cloudQueue.shift();
      if (!oldest || !this._activeClouds.has(oldest)) continue;
      this._retireCloudEarly(oldest, startAt);
      available = MAX_ACTIVE_CLOUDS_PER_VOICE - this._activeClouds.size;
    }
  }

  _retireCloudEarly(cloud, when = Tone.now()) {
    if (!cloud || !this._activeClouds.has(cloud)) return;
    try { if (cloud.timer) clearTimeout(cloud.timer); } catch (e) {}
    cloud.timer = null;
    const t = Math.max(Tone.now(), when);
    try {
      cloud.gain.gain.cancelScheduledValues(t);
      const current = Math.max(0.0001, cloud.gain.gain.value || 0.0001);
      cloud.gain.gain.setValueAtTime(current, t);
      cloud.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.025);
    } catch (e) {}
    try {
      cloud.player.stop(t + 0.03);
    } catch (e) {}
    setTimeout(() => this._disposeCloud(cloud), 70);
  }

  _disposeCloud(cloud) {
    if (!cloud || !this._activeClouds.has(cloud)) return;
    this._activeClouds.delete(cloud);
    const localIdx = this._cloudQueue.indexOf(cloud);
    if (localIdx >= 0) this._cloudQueue.splice(localIdx, 1);
    unregisterGlobalCloud(cloud);
    activeGrainCount = Math.max(0, activeGrainCount - 1);
    try { if (cloud.timer) clearTimeout(cloud.timer); } catch (e) {}
    try { cloud.player.dispose(); } catch (e) {}
    try { cloud.filter.dispose(); } catch (e) {}
    try { cloud.panner.dispose(); } catch (e) {}
    try { cloud.gain.dispose(); } catch (e) {}
  }

  _rand() {
    this._seed = (1664525 * this._seed + 1013904223) >>> 0;
    return this._seed / 0x100000000;
  }

  _randSigned() {
    return this._rand() * 2 - 1;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cloud of this._activeClouds) this._disposeCloud(cloud);
    this._activeClouds.clear();
    if (this._safePlayer) {
      activeGrainCount = Math.max(0, activeGrainCount - SAFE_ACTIVE_GRAINS_PER_VOICE);
    }
    try { this._safePlayer?.stop(Tone.now()); } catch (e) {}
    try { this._safePlayer?.dispose(); } catch (e) {}
    try { this._safeFilter?.dispose(); } catch (e) {}
    try { this._safePanner?.dispose(); } catch (e) {}
    try { this._safeGain?.dispose(); } catch (e) {}
    this._safePlayer = null;
    this._safeFilter = null;
    this._safePanner = null;
    this._safeGain = null;
    try { this.output.dispose(); } catch (e) {}
  }
}

function sampleUrlFromFile(fileName) {
  return new URL(`../wav/${fileName}`, import.meta.url).href;
}

export async function loadGranularSamples() {
  if (sampleCache) return sampleCache;
  if (sampleLoadPromise) return sampleLoadPromise;

  sampleLoadPromise = Promise.all(
    GRANULAR_WAV_FILES.map(async (fileName) => {
      const url = sampleUrlFromFile(fileName);
      try {
        const buffer = await Tone.ToneAudioBuffer.fromUrl(url);
        if (!buffer || !buffer.loaded || buffer.duration <= 0) {
          throw new Error(`invalid buffer: ${fileName}`);
        }
        return buffer;
      } catch (error) {
        console.warn(`[audio] Failed loading wav source: ${fileName}`, error);
        return null;
      }
    })
  ).then((buffers) => {
    const valid = buffers.filter(Boolean);
    if (valid.length === 0) {
      throw new Error('No wav files could be loaded for granular voices.');
    }
    sampleCache = buffers.map((b, i) => b || valid[i % valid.length]);
    console.log(`[audio] loaded ${valid.length}/${GRANULAR_WAV_FILES.length} wav sources for granular voices`);
    return sampleCache;
  }).finally(() => {
    sampleLoadPromise = null;
  });

  return sampleLoadPromise;
}

// Per-color voice factory.
function buildVoice(colorIndex, sampleBuffers) {
  const sample = sampleBuffers[colorIndex % sampleBuffers.length];
  const octaveOffset = VOICE_OCTAVE_OFFSET[colorIndex % VOICE_OCTAVE_OFFSET.length];
  const synthOutput = new Tone.Gain(1);
  const synth = new GranularSynth({ buffer: sample, output: synthOutput, colorIndex });
  const volume = new Tone.Gain(0.0);
  const trimDb = VOICE_TRIM_DB[colorIndex % VOICE_TRIM_DB.length];
  const trimGain = new Tone.Gain(USE_PERSISTENT_SAFE_GRAINS ? dbToGain(trimDb) : 1);

  if (USE_PERSISTENT_SAFE_GRAINS) {
    synthOutput.connect(trimGain);
    trimGain.connect(volume);
    return { synth, synthOutput, trimGain, vibrato: null, tremolo: null, volume, octaveOffset };
  }

  const vibratoTypes = ['sine', 'triangle', 'triangle', 'sine', 'square', 'triangle'];
  const tremoloTypes = ['sine', 'triangle', 'square', 'sine', 'square', 'triangle'];
  const vibrato = new Tone.Vibrato({
    maxDelay: 0.02,
    frequency: 0.2,
    depth: 0.02,
    wet: 0.18,
    type: vibratoTypes[colorIndex % vibratoTypes.length],
  });
  const tremolo = new Tone.Tremolo({
    frequency: 0.6,
    depth: 0.24,
    spread: 0,
    wet: 0.22,
    type: tremoloTypes[colorIndex % tremoloTypes.length],
  }).start();

  synthOutput.connect(vibrato);
  vibrato.connect(tremolo);
  tremolo.connect(trimGain);
  trimGain.connect(volume);

  if (typeof tremolo.volume?.value === 'number') {
    tremolo.volume.value = trimDb;
  }

  return { synth, synthOutput, trimGain, vibrato, tremolo, volume, octaveOffset };
}

// Factory: build N voices and a shared output bus.
export function buildVoiceBus(numColors, options = {}) {
  const sampleBuffers = options.sampleBuffers || sampleCache;
  if (!sampleBuffers || sampleBuffers.length === 0) {
    throw new Error('Granular samples are not loaded. Call loadGranularSamples() before buildVoiceBus().');
  }
  currentVoiceCount = numColors;
  currentGrainModState = [];
  currentEffectState = {
    delayTime: USE_SAFE_PITCH_DELAY ? 0.16 : 0.19,
    feedback: USE_SAFE_PITCH_DELAY ? 0.18 : 0.28,
    wet: USE_SAFE_PITCH_DELAY ? 0.10 : 0.18,
    pitch: USE_SAFE_PITCH_DELAY ? 7 : 0,
    followColor: null,
  };

  const reverb = USE_PERSISTENT_SAFE_GRAINS
    ? (USE_SAFE_PITCH_DELAY
        ? new Tone.PitchShift({ pitch: 7, windowSize: 0.08, delayTime: 0.16, feedback: 0.18, wet: 1 })
        : new Tone.PingPongDelay({ delayTime: 0.19, feedback: 0.28, wet: 1 }))
    : new Tone.Reverb({ decay: 4, wet: 0.35, preDelay: 0.05 });
  const effectSend = new Tone.Gain(USE_PERSISTENT_SAFE_GRAINS ? (USE_SAFE_PITCH_DELAY ? 0.10 : 0.18) : 1);
  const limiter = new Tone.Limiter(-3);
  const masterGain = new Tone.Gain(1.1);

  effectSend.connect(reverb);
  reverb.connect(masterGain);
  masterGain.connect(limiter);
  limiter.toDestination();

  const voices = [];
  for (let i = 0; i < numColors; i++) {
    const v = buildVoice(i, sampleBuffers);
    v.volume.connect(masterGain);
    v.volume.connect(effectSend);
    voices.push(v);
  }

  if (!USE_PERSISTENT_SAFE_GRAINS) reverb.generate();
  return { voices, reverb, effectSend, masterGain, limiter };
}

export function shapeSharedEffect(bus, schedulerSnapshot) {
  if (!bus || !schedulerSnapshot || !USE_PERSISTENT_SAFE_GRAINS) return;
  const colors = Array.isArray(schedulerSnapshot.colors)
    ? schedulerSnapshot.colors.filter(c => c && c.active)
    : [];
  if (!colors.length) return;

  let densitySum = 0;
  let syncSum = 0;
  let fastest = colors[0];
  for (const c of colors) {
    densitySum += Number.isFinite(c.density) ? c.density : 0;
    syncSum += Number.isFinite(c.syncStrength) ? c.syncStrength : 0;
    const cBpm = Number.isFinite(c.effectiveBpm) ? c.effectiveBpm : (Number.isFinite(c.freeBpm) ? c.freeBpm : 0);
    const fastBpm = Number.isFinite(fastest.effectiveBpm) ? fastest.effectiveBpm : (Number.isFinite(fastest.freeBpm) ? fastest.freeBpm : 0);
    if (cBpm > fastBpm) fastest = c;
  }

  const globalBpm = Number.isFinite(schedulerSnapshot.globalBpm) ? schedulerSnapshot.globalBpm : 0;
  const fastestBpm = Number.isFinite(fastest.effectiveBpm) ? fastest.effectiveBpm : (Number.isFinite(fastest.freeBpm) ? fastest.freeBpm : globalBpm);
  const motionNorm = clamp((globalBpm - 28) / 92, 0, 1);
  const fastNorm = clamp((fastestBpm - 30) / 100, 0, 1);
  const densityNorm = clamp((densitySum / colors.length) / 1.6, 0, 1);
  const syncNorm = clamp(syncSum / colors.length, 0, 1);
  const energy = clamp(motionNorm * 0.62 + fastNorm * 0.28 + densityNorm * 0.10, 0, 1);

  const targetDelay = USE_SAFE_PITCH_DELAY
    ? lerp(0.34, 0.075, energy) * (1 - syncNorm * 0.10)
    : lerp(0.42, 0.105, energy) * (1 - syncNorm * 0.12);
  const targetFeedback = clamp(0.16 + energy * 0.22 + densityNorm * 0.06 - syncNorm * 0.04, 0.12, 0.42);
  const targetWet = USE_SAFE_PITCH_DELAY
    ? clamp(0.06 + densityNorm * 0.08 + energy * 0.06, 0.05, 0.19)
    : clamp(0.10 + densityNorm * 0.12 + energy * 0.08, 0.09, 0.30);
  const colorPitch = [-12, -7, -5, 5, 7, 12][fastest.idx % 6] || 0;
  const targetPitch = USE_SAFE_PITCH_DELAY ? colorPitch * (0.38 + fastNorm * 0.62) : 0;

  setToneParam(bus.reverb?.delayTime, targetDelay, 0.24);
  setToneParam(bus.reverb?.feedback, targetFeedback, 0.24);
  setToneParam(bus.effectSend?.gain, targetWet, 0.24);
  if (USE_SAFE_PITCH_DELAY && bus.reverb) {
    try {
      bus.reverb.pitch = currentEffectState.pitch + (targetPitch - currentEffectState.pitch) * 0.28;
    } catch (e) {}
  }

  currentEffectState = {
    delayTime: targetDelay,
    feedback: targetFeedback,
    wet: targetWet,
    pitch: USE_SAFE_PITCH_DELAY ? (Number.isFinite(bus.reverb?.pitch) ? bus.reverb.pitch : targetPitch) : 0,
    followColor: Number.isFinite(fastest.idx) ? fastest.idx : null,
  };
}

export function setVoiceLevel(voice, target, seconds = 0.2) {
  const now = Tone.now();
  voice.volume.gain.cancelScheduledValues(now);
  voice.volume.gain.setValueAtTime(voice.volume.gain.value, now);
  voice.volume.gain.linearRampToValueAtTime(target, now + seconds);
}

export function triggerVoice(voice, midi, durSeconds, time, velocity = 0.7) {
  if (midi == null) return;
  const freq = Tone.Frequency(midi, 'midi').toFrequency();
  try {
    voice.synth.triggerAttackRelease(freq, durSeconds, time, velocity);
  } catch (e) {
    console.warn('[audio] granular trigger failed', { midi, durSeconds, time, velocity, error: e });
  }
}

export function shapeVoiceForMotion(voice, colorIndex, motionNorm) {
  const morph = VOICE_MORPH[colorIndex % VOICE_MORPH.length];
  if (!morph) return { durScale: 1, velocityScale: 1 };
  const t = clamp(motionNorm, 0, 1);
  const quantized = Math.round(t * 12) / 12;
  if (voice._lastMorphKey !== quantized) {
    applyPatch(voice.synth, blendObjectMorph(morph.grain, quantized));
    applyPatch(voice.tremolo, blendObjectMorph(morph.tremolo, quantized));
    applyPatch(voice.vibrato, blendObjectMorph(morph.vibrato, quantized));
    voice._lastMorphKey = quantized;
  }
  return {
    durScale: triBlend(morph.dur, t),
    velocityScale: triBlend(morph.vel, t),
  };
}

export function getGranularRuntimeStats() {
  const activeGrainMods = currentGrainModState.filter(Boolean);
  const grainSizes = activeGrainMods.map((state) => state.grainSize).filter(Number.isFinite);
  const avgGrainSize = grainSizes.length
    ? grainSizes.reduce((sum, value) => sum + value, 0) / grainSizes.length
    : 0;
  return {
    activeGrains: activeGrainCount,
    maxActiveGrains: MAX_ACTIVE_GRAINS,
    maxGrainsPerNote: MAX_GRAINS_PER_NOTE,
    engineMode: USE_PERSISTENT_SAFE_GRAINS ? 'persistent' : 'cloud',
    effectMode: USE_PERSISTENT_SAFE_GRAINS ? (USE_SAFE_PITCH_DELAY ? 'pitchDelay' : 'delay') : 'reverb',
    voiceCount: currentVoiceCount,
    effect: { ...currentEffectState },
    grain: {
      avgSize: avgGrainSize,
      minSize: grainSizes.length ? Math.min(...grainSizes) : 0,
      maxSize: grainSizes.length ? Math.max(...grainSizes) : 0,
      lfoRates: activeGrainMods.map((state) => ({
        grain: state.grainLfoRate,
        start: state.startLfoRate,
      })),
    },
  };
}
