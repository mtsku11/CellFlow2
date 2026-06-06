// audio/index.js
// Public API for the audio engine. Imported once from main.js.

import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm';
import { buildVoiceBus, loadGranularSamples, getGranularRuntimeStats, shapeSharedEffect } from './voices.js?v=20260606f';
import { MarkovMelody } from './markov.js?v=20260507g';
import { Scheduler } from './scheduler.js?v=20260606i';
import { detectOrganisms, resetOrganismState } from './organisms.js?v=20260606f';
import { pickRandomKey, pickNextRegenKey } from './scales.js?v=20260507g';

let started = false;
let bus = null;          // { voices, reverb, masterGain, limiter }
let markovs = [];
let scheduler = null;
let currentKey = null;
let numColors = 0;
let regenCount = 0;
let granularSamples = null;
let latestOrganisms = [];
let latestPerColorStats = null;
const debugState = {
  started: false,
  numColors: 0,
  feedCount: 0,
  lastFeedAt: 0,
  audioContextState: 'unknown',
  diagnosticToneCount: 0,
  lastDiagnosticToneAt: 0,
  granular: {
    activeGrains: 0,
    maxActiveGrains: 0,
    maxGrainsPerNote: 0,
  },
  speedRange: {
    minAvgSpeed: Infinity,
    maxAvgSpeed: 0,
    perColorMin: [],
    perColorMax: [],
  },
  scheduler: null,
  currentKey: null,
  regenCount: 0,
  perf: {
    densitySource: 'cpu_spatial',
    samples: 0,
    lastReadbackMs: 0,
    avgReadbackMs: 0,
    lastDensityMs: 0,
    avgDensityMs: 0,
    lastFeedMs: 0,
    avgFeedMs: 0,
  },
};
const SPEED_CAP = 30;
const MIN_SPEED_SAMPLES_FOR_STABLE = 24;
const SPEED_SPIKE_MULT = 2.8;
const SPEED_SPIKE_FLOOR = 1.1;
const SPEED_HISTORY_BIAS = 0.9;
const SPEED_ATTACK_ALPHA = 0.68;
const SPEED_RELEASE_ALPHA = 0.64;
const SPEED_INACTIVE_DECAY = 0.56;
const SPEED_LEAD_ATTACK = 0.44;
const SPEED_LEAD_RELEASE = 0.18;
const SPEED_LEAD_MAX = 5.5;
const SPEED_REST_SNAP = 0.045;
const NOMINAL_AUDIO_DELTA_T = 1.0;
let perColorSpeedEma = [];
let perColorLastStableSpeed = [];

function resetDebugState(colors) {
  debugState.numColors = colors;
  debugState.feedCount = 0;
  debugState.lastFeedAt = 0;
  debugState.audioContextState = Tone.context?.state || 'unknown';
  debugState.granular = getGranularRuntimeStats();
  debugState.speedRange.minAvgSpeed = Infinity;
  debugState.speedRange.maxAvgSpeed = 0;
  debugState.speedRange.perColorMin = new Array(colors).fill(Infinity);
  debugState.speedRange.perColorMax = new Array(colors).fill(0);
  debugState.scheduler = null;
  debugState.currentKey = currentKey;
  debugState.regenCount = regenCount;
  debugState.perf.samples = 0;
  debugState.perf.lastReadbackMs = 0;
  debugState.perf.avgReadbackMs = 0;
  debugState.perf.lastDensityMs = 0;
  debugState.perf.avgDensityMs = 0;
  debugState.perf.lastFeedMs = 0;
  debugState.perf.avgFeedMs = 0;
  perColorSpeedEma = new Array(colors).fill(0);
  perColorLastStableSpeed = new Array(colors).fill(0);
  latestOrganisms = [];
  latestPerColorStats = null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimateSpatialDensityByColor(
  particleFloats,
  particleUints,
  particleCount,
  numColors,
  neighborRadius,
  canvasW,
  canvasH
) {
  const sums = new Float32Array(numColors);
  if (particleCount === 0) return sums;

  const cellSize = Math.max(14, neighborRadius * 0.8);
  const cols = Math.max(1, Math.ceil(canvasW / cellSize));
  const rows = Math.max(1, Math.ceil(canvasH / cellSize));
  const cellCount = cols * rows;
  const grid = new Uint16Array(cellCount);
  const particleCell = new Uint32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const fb = i * 8;
    const x = particleFloats[fb + 0];
    const y = particleFloats[fb + 1];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    const key = cy * cols + cx;
    particleCell[i] = key;
    grid[key] += 1;
  }

  const baselineLocalMass = Math.max(1, (particleCount / cellCount) * 9);
  for (let i = 0; i < particleCount; i++) {
    const key = particleCell[i];
    const cx = key % cols;
    const cy = Math.floor(key / cols);
    let localMass = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const ny = (cy + oy + rows) % rows;
      for (let ox = -1; ox <= 1; ox++) {
        const nx = (cx + ox + cols) % cols;
        localMass += grid[ny * cols + nx];
      }
    }
    const densityRaw = localMass / baselineLocalMass;
    const densityNorm = clamp((densityRaw - 0.7) / 2.6, 0, 1.6);
    const ptype = particleUints[i * 8 + 6];
    if (ptype < numColors) sums[ptype] += densityNorm;
  }
  return sums;
}

function estimateGpuNeighborDensityByColor(
  particleUints,
  neighborCounts,
  particleCount,
  numColors,
  neighborRadius,
  canvasW,
  canvasH
) {
  const sums = new Float32Array(numColors);
  if (!neighborCounts || particleCount === 0) return sums;

  const simArea = Math.max(1, canvasW * canvasH);
  const queryArea = Math.PI * Math.max(6, neighborRadius) * Math.max(6, neighborRadius);
  const expectedNeighbors = Math.max(1, (particleCount * queryArea) / simArea);

  for (let i = 0; i < particleCount; i++) {
    const ptype = particleUints[i * 8 + 6];
    if (ptype >= numColors) continue;
    const raw = neighborCounts[i] / expectedNeighbors;
    const norm = clamp((raw - 0.30) / 2.1, 0, 1.6);
    sums[ptype] += norm;
  }
  return sums;
}

function updatePerfAverages(perf, sample) {
  perf.samples += 1;
  const n = perf.samples;
  perf.lastReadbackMs = sample.readbackMs;
  perf.lastDensityMs = sample.densityMs;
  perf.lastFeedMs = sample.feedMs;
  perf.avgReadbackMs += (sample.readbackMs - perf.avgReadbackMs) / n;
  perf.avgDensityMs += (sample.densityMs - perf.avgDensityMs) / n;
  perf.avgFeedMs += (sample.feedMs - perf.avgFeedMs) / n;
}

function finalizePerColorStats(perColorStats) {
  const activeRaw = perColorStats.filter(s => s.count > 0);
  let globalRawAvgSpeed = 0;
  if (activeRaw.length > 0) {
    let total = 0;
    let weights = 0;
    for (const s of activeRaw) {
      total += (s.sumSpeed / s.count) * s.count;
      weights += s.count;
    }
    globalRawAvgSpeed = weights > 0 ? (total / weights) : 0;
  }

  for (let c = 0; c < perColorStats.length; c++) {
    const s = perColorStats[c];
    const rawAvgSpeed = s.count > 0 ? s.sumSpeed / s.count : 0;
    if (s.count <= 0) {
      perColorSpeedEma[c] *= SPEED_INACTIVE_DECAY;
      perColorLastStableSpeed[c] = 0;
      if (perColorSpeedEma[c] < SPEED_REST_SNAP) perColorSpeedEma[c] = 0;
      s.avgSpeed = perColorSpeedEma[c];
      s.avgDensity = 0;
      continue;
    }
    const lowCountMix = clamp(
      (MIN_SPEED_SAMPLES_FOR_STABLE - s.count) / MIN_SPEED_SAMPLES_FOR_STABLE,
      0,
      0.92
    );
    const lowCountStabilized = rawAvgSpeed * (1 - lowCountMix) + globalRawAvgSpeed * lowCountMix;
    const globalCap = Math.max(SPEED_SPIKE_FLOOR, globalRawAvgSpeed * SPEED_SPIKE_MULT);
    const historyCap = Math.max(
      SPEED_SPIKE_FLOOR,
      perColorSpeedEma[c] * SPEED_SPIKE_MULT + SPEED_HISTORY_BIAS
    );
    const clampedSpeed = Math.min(lowCountStabilized, Math.max(globalCap, historyCap));
    const previousStable = perColorLastStableSpeed[c] || perColorSpeedEma[c] || 0;
    const stableDelta = clampedSpeed - previousStable;
    const leadAmount = clamp(
      stableDelta * (stableDelta >= 0 ? SPEED_LEAD_ATTACK : SPEED_LEAD_RELEASE),
      -SPEED_LEAD_MAX,
      SPEED_LEAD_MAX
    );
    const ledSpeed = clampedSpeed <= SPEED_REST_SNAP
      ? 0
      : clamp(clampedSpeed + leadAmount, 0, SPEED_CAP);
    const alpha = ledSpeed >= perColorSpeedEma[c] ? SPEED_ATTACK_ALPHA : SPEED_RELEASE_ALPHA;
    perColorSpeedEma[c] += (ledSpeed - perColorSpeedEma[c]) * alpha;
    if (ledSpeed <= SPEED_REST_SNAP && perColorSpeedEma[c] < SPEED_REST_SNAP) perColorSpeedEma[c] = 0;
    perColorLastStableSpeed[c] = clampedSpeed;
    s.avgSpeed = perColorSpeedEma[c];
    s.rawSpeed = rawAvgSpeed;
    s.audioSpeedTarget = ledSpeed;
    s.avgDensity = s.count > 0 ? s.sumDensity / s.count : 0;
  }

  const active = perColorStats.filter(s => s.count > 0);
  if (active.length > 0) {
    const avg = active.reduce((acc, s) => acc + s.avgSpeed, 0) / active.length;
    debugState.speedRange.minAvgSpeed = Math.min(debugState.speedRange.minAvgSpeed, avg);
    debugState.speedRange.maxAvgSpeed = Math.max(debugState.speedRange.maxAvgSpeed, avg);
  }
  for (let c = 0; c < perColorStats.length; c++) {
    const speed = perColorStats[c].avgSpeed;
    debugState.speedRange.perColorMin[c] = Math.min(debugState.speedRange.perColorMin[c], speed);
    debugState.speedRange.perColorMax[c] = Math.max(debugState.speedRange.perColorMax[c], speed);
  }
}

function velocityToVisibleStepSpeed(vx, vy, deltaT = NOMINAL_AUDIO_DELTA_T) {
  const rawSpeed = Math.sqrt(vx * vx + vy * vy);
  const motionScale = clamp(Math.abs(deltaT), 0, 1);
  return Math.min(SPEED_CAP, rawSpeed * motionScale);
}

function applyOrganismCoverage(perColorStats, organisms) {
  const organismCoverage = new Float32Array(numColors);
  for (const org of organisms) {
    const confidenceGain = 0.6 + 0.4 * (org.confidence ?? 1.0);
    for (const [ptype, count] of org._colorCounts) {
      if (ptype >= numColors) continue;
      const totalForColor = Math.max(1, perColorStats[ptype].count);
      organismCoverage[ptype] += (count / totalForColor) * confidenceGain;
    }
  }
  for (let c = 0; c < perColorStats.length; c++) {
    const spatial = perColorStats[c].avgDensity;
    const coverage = clamp(organismCoverage[c], 0, 1.6);
    perColorStats[c].avgDensity = spatial * 0.7 + coverage * 0.3;
  }
}

function annotateOrganismsWithColorCounts(organisms, particleUints) {
  for (const org of organisms) {
    const cmap = new Map();
    for (const i of org.indices) {
      const ptype = particleUints[i * 8 + 6];
      cmap.set(ptype, (cmap.get(ptype) || 0) + 1);
    }
    org._colorCounts = cmap;
  }
}

function commitSchedulerState(perColorStats, organisms, perfSample = null, densitySource = 'cpu_spatial') {
  latestPerColorStats = perColorStats;
  latestOrganisms = organisms;
  scheduler.update(perColorStats, organisms);
  debugState.feedCount++;
  debugState.lastFeedAt = performance.now();
  debugState.scheduler = scheduler.getDebugSnapshot();
  shapeSharedEffect(bus, debugState.scheduler);
  debugState.perf.densitySource = densitySource;
  if (perfSample) {
    updatePerfAverages(debugState.perf, perfSample);
  }
  debugState.granular = getGranularRuntimeStats();
}

export function benchmarkDensityEstimators(
  particleFloats,
  particleUints,
  particleCount,
  numTypes,
  neighborRadius,
  canvasW,
  canvasH,
  neighborCounts = null
) {
  const out = { cpuSpatialMs: 0, gpuNeighborMs: null, numTypes };
  const spatialStarted = performance.now();
  estimateSpatialDensityByColor(
    particleFloats,
    particleUints,
    particleCount,
    numTypes,
    neighborRadius,
    canvasW,
    canvasH
  );
  out.cpuSpatialMs = performance.now() - spatialStarted;
  if (neighborCounts) {
    const neighborU32 = neighborCounts instanceof Uint32Array
      ? neighborCounts
      : new Uint32Array(neighborCounts);
    const gpuStarted = performance.now();
    estimateGpuNeighborDensityByColor(
      particleUints,
      neighborU32,
      particleCount,
      numTypes,
      neighborRadius,
      canvasW,
      canvasH
    );
    out.gpuNeighborMs = performance.now() - gpuStarted;
  }
  return out;
}

// Called once on user-gesture click of the "Audio On" button.
export async function start(initialNumColors) {
  if (started) return;
  await Tone.start(); // unlock browser audio
  console.log('[audio] Tone started, context state:', Tone.context.state);
  debugState.audioContextState = Tone.context?.state || 'unknown';
  if (!granularSamples) {
    granularSamples = await loadGranularSamples();
  }
  numColors = initialNumColors;
  currentKey = pickRandomKey();
  regenCount = 0;
  bus = buildVoiceBus(numColors, { sampleBuffers: granularSamples });
  markovs = bus.voices.map((v, i) => new MarkovMelody(i, v.octaveOffset));
  scheduler = new Scheduler({
    voices: bus.voices,
    markovs,
    getKey: () => currentKey,
  });
  scheduler.start();
  resetDebugState(numColors);
  // Prime all voices so the "six colors -> six lines" mapping is immediately audible.
  for (const voice of bus.voices) {
    voice.volume.gain.value = 0.20;
  }
  // Guaranteed audible path: bypasses the granular engine and verifies output.
  try {
    await playDiagnosticTone({ frequency: 523.25, seconds: 0.45, amplitude: 0.30 });
  } catch (e) {
    console.warn('[audio] startup diagnostic tone failed', e);
  }
  started = true;
  debugState.started = true;
  debugState.currentKey = currentKey;
  debugState.regenCount = regenCount;
  console.log(`[audio] started with ${numColors} voices, key:`, currentKey);
}

export function stop() {
  if (!started) return;
  scheduler?.destroy();
  // Dispose voice graph
  for (const v of bus.voices) {
    try { v.synth.dispose(); } catch (e) {}
    try { v.synthOutput?.dispose(); } catch (e) {}
    try { v.trimGain?.dispose(); } catch (e) {}
    try { v.vibrato?.dispose(); } catch (e) {}
    try { v.tremolo?.dispose(); } catch (e) {}
    try { v.volume.dispose(); } catch (e) {}
  }
  try { bus.reverb.dispose(); bus.effectSend?.dispose(); bus.masterGain.dispose(); bus.limiter.dispose(); } catch (e) {}
  scheduler = null;
  bus = null;
  markovs = [];
  resetOrganismState();
  currentKey = null;
  regenCount = 0;
  started = false;
  debugState.started = false;
  debugState.scheduler = null;
  debugState.audioContextState = Tone.context?.state || 'unknown';
  debugState.currentKey = null;
  debugState.regenCount = 0;
  debugState.granular = getGranularRuntimeStats();
}

export function isStarted() { return started; }

// Triggered when the simulation regenerates (Space key or preset change).
// Picks a new key and re-anchors all Markov chains. Currently sounding notes
// finish naturally; from the next note onwards, the new key is heard.
export function onRegen() {
  if (!started) return;
  regenCount++;
  currentKey = pickNextRegenKey(currentKey, regenCount);
  scheduler.onKeyChange();
  debugState.currentKey = currentKey;
  debugState.regenCount = regenCount;
  console.log('[audio] new key:', currentKey);
}

// Called when numTypes changes — we need to rebuild voices.
export async function rebuildVoices(newNumColors) {
  if (!started) return;
  if (newNumColors === numColors) return;
  // Tear down and rebuild. Keep current key for continuity.
  scheduler?.destroy();
  for (const v of bus.voices) {
    try { v.synth.dispose(); } catch (e) {}
    try { v.synthOutput?.dispose(); } catch (e) {}
    try { v.trimGain?.dispose(); } catch (e) {}
    try { v.vibrato?.dispose(); } catch (e) {}
    try { v.tremolo?.dispose(); } catch (e) {}
    try { v.volume.dispose(); } catch (e) {}
  }
  try { bus.reverb.dispose(); bus.effectSend?.dispose(); bus.masterGain.dispose(); bus.limiter.dispose(); } catch (e) {}
  numColors = newNumColors;
  if (!granularSamples) {
    granularSamples = await loadGranularSamples();
  }
  bus = buildVoiceBus(numColors, { sampleBuffers: granularSamples });
  markovs = bus.voices.map((v, i) => new MarkovMelody(i, v.octaveOffset));
  scheduler = new Scheduler({
    voices: bus.voices,
    markovs,
    getKey: () => currentKey,
  });
  scheduler.start();
  resetDebugState(numColors);
  resetOrganismState();
  debugState.currentKey = currentKey;
  debugState.regenCount = regenCount;
  console.log(`[audio] rebuilt with ${numColors} voices`);
}

export function refreshOrganisms(
  particleFloats,
  particleUints,
  particleCount,
  neighborRadius,
  canvasW,
  canvasH,
  options = {}
) {
  if (!started || !scheduler) return;
  const organisms = detectOrganisms(
    particleFloats,
    particleUints,
    particleCount,
    neighborRadius,
    canvasW,
    canvasH,
    options
  );
  annotateOrganismsWithColorCounts(organisms, particleUints);
  latestOrganisms = organisms;
  if (latestPerColorStats) {
    scheduler.update(latestPerColorStats, latestOrganisms);
    debugState.scheduler = scheduler.getDebugSnapshot();
  }
}

export function feedGpuSummary(
  summary,
  numTypes,
  neighborRadius,
  canvasW,
  canvasH,
  options = {}
) {
  if (!started || !scheduler || !summary) return;
  if (numTypes !== numColors) return;

  const feedStartedAt = performance.now();
  const counts = summary.counts instanceof Uint32Array ? summary.counts : new Uint32Array(summary.counts || 0);
  const speedSums = summary.speedSums instanceof Uint32Array ? summary.speedSums : new Uint32Array(summary.speedSums || 0);
  const neighborSums = summary.neighborSums instanceof Uint32Array ? summary.neighborSums : new Uint32Array(summary.neighborSums || 0);
  const speedScale = Math.max(1, summary.speedScale || 1024);
  const speedSumCap = SPEED_CAP * speedScale;
  const perColorStats = [];
  const simArea = Math.max(1, canvasW * canvasH);
  const queryArea = Math.PI * Math.max(6, neighborRadius) * Math.max(6, neighborRadius);
  const expectedNeighborsBase = Math.max(1, (Math.max(1, summary.totalParticles || 0) * queryArea) / simArea);

  for (let c = 0; c < numColors; c++) {
    const count = counts[c] || 0;
    const cappedSpeedSum = count > 0
      ? Math.min(speedSums[c] || 0, speedSumCap * count)
      : 0;
    const sumSpeed = cappedSpeedSum / speedScale;
    const avgNeighbors = count > 0 ? (neighborSums[c] || 0) / count : 0;
    const densityRaw = avgNeighbors / expectedNeighborsBase;
    const densityNorm = clamp((densityRaw - 0.30) / 2.1, 0, 1.6);
    perColorStats.push({
      count,
      sumSpeed,
      sumDensity: densityNorm * count,
      avgSpeed: 0,
      avgDensity: 0,
    });
  }

  finalizePerColorStats(perColorStats);
  applyOrganismCoverage(perColorStats, latestOrganisms);
  commitSchedulerState(
    perColorStats,
    latestOrganisms,
    {
      readbackMs: typeof summary.readbackMs === 'number' ? summary.readbackMs : 0,
      densityMs: 0,
      feedMs: performance.now() - feedStartedAt,
    },
    'gpu_summary'
  );
}

// The main per-readback feed.
//   particleFloats / particleUints: views into the 32-byte-stride particle buffer
//   particleCount: number of particles
//   numTypes: current numParticleTypes
//   neighborRadius: simulation radius
//   canvasW, canvasH: canvas dimensions
export function feed(
  particleFloats,
  particleUints,
  particleCount,
  numTypes,
  neighborRadius,
  canvasW,
  canvasH,
  options = {}
) {
  if (!started || !scheduler) return;
  if (numTypes !== numColors) {
    // Number of color types changed under us — defer; main.js should call rebuildVoices.
    return;
  }
  const feedStartedAt = performance.now();

  // Per-color stats.
  const perColorStats = [];
  for (let c = 0; c < numColors; c++) {
    perColorStats.push({ count: 0, sumSpeed: 0, sumDensity: 0, avgSpeed: 0, avgDensity: 0 });
  }
  for (let i = 0; i < particleCount; i++) {
    const fb = i * 8;
    const ub = i * 8;
    const ptype = particleUints[ub + 6];
    if (ptype >= numColors) continue;
    const vx = particleFloats[fb + 2];
    const vy = particleFloats[fb + 3];
    const speed = velocityToVisibleStepSpeed(vx, vy, options.deltaT);
    const stats = perColorStats[ptype];
    stats.count++;
    stats.sumSpeed += speed;
  }
  const wantsGpuNeighborDensity = options.densitySource === 'gpu_neighbor';
  let neighborCounts = null;
  if (wantsGpuNeighborDensity) {
    if (options.neighborCounts instanceof Uint32Array) neighborCounts = options.neighborCounts;
    else if (options.neighborCounts instanceof ArrayBuffer) neighborCounts = new Uint32Array(options.neighborCounts);
  }
  const densityStartedAt = performance.now();
  const densitySums = neighborCounts
    ? estimateGpuNeighborDensityByColor(
      particleUints,
      neighborCounts,
      particleCount,
      numColors,
      neighborRadius,
      canvasW,
      canvasH
    )
    : estimateSpatialDensityByColor(
      particleFloats,
      particleUints,
      particleCount,
      numColors,
      neighborRadius,
      canvasW,
      canvasH
    );
  const densityMs = performance.now() - densityStartedAt;
  for (let c = 0; c < perColorStats.length; c++) {
    perColorStats[c].sumDensity = densitySums[c];
  }
  finalizePerColorStats(perColorStats);

  // Detect organisms.
  const organisms = detectOrganisms(
    particleFloats, particleUints, particleCount,
    neighborRadius, canvasW, canvasH
  );
  annotateOrganismsWithColorCounts(organisms, particleUints);
  applyOrganismCoverage(perColorStats, organisms);
  commitSchedulerState(
    perColorStats,
    organisms,
    {
      readbackMs: typeof options.readbackMs === 'number' ? options.readbackMs : 0,
      densityMs,
      feedMs: performance.now() - feedStartedAt,
    },
    neighborCounts ? 'gpu_neighbor' : 'cpu_spatial'
  );
}

export async function playDiagnosticTone(options = {}) {
  const frequency = clamp(typeof options.frequency === 'number' ? options.frequency : 440, 80, 1600);
  const seconds = clamp(typeof options.seconds === 'number' ? options.seconds : 0.9, 0.15, 3.0);
  const amplitude = clamp(typeof options.amplitude === 'number' ? options.amplitude : 0.35, 0.05, 0.95);
  await Tone.start();
  debugState.audioContextState = Tone.context?.state || 'unknown';

  const now = Tone.now();
  const osc = new Tone.Oscillator({ frequency, type: 'triangle' });
  const filter = new Tone.Filter({ type: 'lowpass', frequency: 1800, Q: 0.4 });
  const gain = new Tone.Gain(0);

  osc.connect(filter);
  filter.connect(gain);
  gain.toDestination();

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.linearRampToValueAtTime(amplitude, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  osc.start(now);
  osc.stop(now + seconds + 0.03);

  const disposeMs = Math.max(120, Math.ceil((seconds + 0.2) * 1000));
  setTimeout(() => {
    try { osc.dispose(); } catch (e) {}
    try { filter.dispose(); } catch (e) {}
    try { gain.dispose(); } catch (e) {}
  }, disposeMs);

  debugState.diagnosticToneCount += 1;
  debugState.lastDiagnosticToneAt = performance.now();
}

export function getDebugState() {
  debugState.audioContextState = Tone.context?.state || 'unknown';
  debugState.granular = getGranularRuntimeStats();
  return debugState;
}
