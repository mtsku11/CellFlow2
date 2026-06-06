// audio/scheduler.js
// Per-color state machine and per-organism attraction.
//
// Two modes per color:
//   - free:   color schedules its own notes; tempo follows that color's avg velocity
//   - synced: color keeps its own wandering clock, while organism velocity softly
//             attracts tempo and density. Colors converge without hard lockstep.

import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm';
import { triggerVoice, setVoiceLevel, shapeVoiceForMotion } from './voices.js?v=20260606c';

const requestedAudioPerf = new URLSearchParams(window.location.search).get('audioPerf');
const AUDIO_PERF_MODE = (requestedAudioPerf === 'high' || requestedAudioPerf === 'balanced')
  ? requestedAudioPerf
  : 'safe';
const BPM_MIN = 30;
const BPM_MAX = AUDIO_PERF_MODE === 'safe' ? 118 : AUDIO_PERF_MODE === 'balanced' ? 168 : 190;
const SUBDIV = AUDIO_PERF_MODE === 'safe' ? 2 : 4;
const MIN_CLOCK_INTERVAL_MS = AUDIO_PERF_MODE === 'safe' ? 170 : AUDIO_PERF_MODE === 'balanced' ? 118 : 96;
const NOTE_RATE_WINDOW_MS = 1000;
const GLOBAL_NOTES_PER_WINDOW = AUDIO_PERF_MODE === 'safe' ? 14 : AUDIO_PERF_MODE === 'balanced' ? 24 : 34;
const PER_COLOR_MIN_TRIGGER_MS = AUDIO_PERF_MODE === 'safe' ? 150 : AUDIO_PERF_MODE === 'balanced' ? 92 : 70;
const DEFAULT_MIN_SPEED = 1.2;
const DEFAULT_MAX_SPEED = 14.0;
const MIN_FREQ_HZ = 0.45;
const LOW_SPEED_HOLD = 0.015;
const TEMPO_CURVE_EXP = 0.72;
const BPM_REST_SNAP = 4;
const IDLE_RECHECK_MS = 220;
const COLOR_MEMBERSHIP_THRESHOLD = 0.30;
const ENTER_THRESHOLD = 0.34;
const EXIT_THRESHOLD = 0.20;
const ENTER_CONFIRM_TICKS = 2;
const SWITCH_CONFIRM_TICKS = 2;
const EXIT_CONFIRM_TICKS = 3;
const ORG_REST_FALLBACK_TICKS = 2;
const ORG_ENTER_MIN_FREE_BPM_RATIO = 0.44;
const ORG_STAY_MIN_FREE_BPM_RATIO = 0.30;
const COLOR_DURATION = [0.30, 0.40, 0.18, 0.80, 0.10, 0.35];
const COLOR_RHYTHMS = [
  { pattern: [1, 0, 1, 0, 0, 1, 0, 0], accent: [1.16, 0.80, 0.96, 0.70, 0.72, 1.05, 0.70, 0.76], dur: [1.08, 0.70, 0.88, 0.68, 0.78, 1.12, 0.64, 0.82], fill: 0.24, thin: 0.18 },
  { pattern: [1, 0, 0, 1, 0, 1, 0], accent: [1.05, 0.70, 0.74, 1.18, 0.72, 0.92, 0.76], dur: [0.92, 0.74, 0.68, 1.18, 0.70, 0.84, 0.78], fill: 0.28, thin: 0.14 },
  { pattern: [1, 1, 0, 1, 0, 0, 1, 0, 1], accent: [0.96, 0.82, 0.68, 1.10, 0.70, 0.66, 0.90, 0.72, 1.18], dur: [0.62, 0.54, 0.48, 0.70, 0.50, 0.46, 0.58, 0.52, 0.66], fill: 0.34, thin: 0.22 },
  { pattern: [1, 0, 0, 0, 1, 0], accent: [1.22, 0.66, 0.70, 0.66, 0.94, 0.72], dur: [1.42, 0.82, 0.90, 0.78, 1.18, 0.86], fill: 0.18, thin: 0.10 },
  { pattern: [1, 0, 1, 1, 0, 1, 0, 1, 0, 0], accent: [0.86, 0.64, 1.10, 0.78, 0.62, 1.22, 0.64, 0.92, 0.66, 0.62], dur: [0.42, 0.34, 0.50, 0.38, 0.34, 0.54, 0.36, 0.46, 0.36, 0.34], fill: 0.40, thin: 0.30 },
  { pattern: [1, 0, 1, 0, 1, 0, 0, 1], accent: [0.98, 0.70, 1.14, 0.68, 0.82, 0.70, 0.64, 1.06], dur: [0.78, 0.56, 0.96, 0.58, 0.70, 0.62, 0.54, 0.88], fill: 0.30, thin: 0.18 },
];
const COLOR_BPM_SMOOTHING = 0.22;
const ORG_BPM_SMOOTHING = 0.28;
const ORG_ATTRACTION_MAX = AUDIO_PERF_MODE === 'safe' ? 0.38 : AUDIO_PERF_MODE === 'balanced' ? 0.52 : 0.66;
const SYNC_ATTRACTION_SMOOTHING = 0.16;
const FREE_CLOCK_JITTER = AUDIO_PERF_MODE === 'safe' ? 0.22 : 0.16;
const SYNC_CLOCK_JITTER = 0.18;
const DRIFT_STEP = 0.035;
const DRIFT_MIN = 0.84;
const DRIFT_MAX = 1.20;
const FREE_EXTRA_REST_PROB = AUDIO_PERF_MODE === 'safe' ? 0.12 : 0.10;
const SYNC_EXTRA_REST_PROB = AUDIO_PERF_MODE === 'safe' ? 0.05 : 0.07;
const AUDIO_DIAG_LOGS = new URLSearchParams(window.location.search).get('audioDiag') === '1';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function bpmToHz(bpm) {
  if (bpm <= 0.01) return 0;
  return Math.max(MIN_FREQ_HZ, (bpm / 60) * SUBDIV);
}

// Smoothly adapts the mapping window to the live sim so velocity->tempo stays expressive.
function adaptSpeedFloor(frameMin) {
  return Math.max(0.2, frameMin * 0.55);
}

function adaptSpeedCeil(frameMax, floor) {
  return Math.max(floor + 1.5, frameMax * 2.2);
}

let _lastDiagAt = 0;
function maybeLogDiag(snapshot) {
  if (!AUDIO_DIAG_LOGS) return;
  const now = performance.now();
  if (now - _lastDiagAt < 1500) return;
  _lastDiagAt = now;
  console.log(
    `[audio diag] avg=${snapshot.globalAvgSpeed.toFixed(2)} ` +
    `window=[${snapshot.speedFloor.toFixed(2)}, ${snapshot.speedCeil.toFixed(2)}] ` +
    `bpm=${Math.round(snapshot.globalBpm)}`
  );
}

export class Scheduler {
  constructor({ voices, markovs, getKey }) {
    this.voices = voices;
    this.markovs = markovs;
    this.getKey = getKey;
    this.numColors = voices.length;
    this.colorState = [];
    this.organisms = new Map();
    this.tickCounter = 0;
    this.recentTriggerTimes = [];
    this._destroyed = false;

    this.speedFloor = DEFAULT_MIN_SPEED;
    this.speedCeil = DEFAULT_MAX_SPEED;
    this.observedMinSpeed = Infinity;
    this.observedMaxSpeed = 0;

    this.debugSnapshot = {
      tick: 0,
      globalAvgSpeed: 0,
      globalBpm: BPM_MIN,
      speedFloor: this.speedFloor,
      speedCeil: this.speedCeil,
      observedMinSpeed: this.observedMinSpeed,
      observedMaxSpeed: this.observedMaxSpeed,
      activeColors: 0,
      colors: [],
      organisms: [],
    };

    for (let i = 0; i < this.numColors; i++) {
      this.colorState.push({
        mode: 'free',
        orgId: null,
        count: 0,
        vel: 0,
        density: 0,
        active: false,
        timerId: null,
        targetBpm: BPM_MIN,
        smoothedBpm: BPM_MIN,
        lastIntervalMs: 1000 / bpmToHz(BPM_MIN),
        notesTriggered: 0,
        candidateOrgId: null,
        candidateTicks: 0,
        exitTicks: 0,
        restFallbackTicks: 0,
        lastMembershipScore: 0,
        syncStrength: 0,
        clockDrift: 0.94 + Math.random() * 0.14,
        driftTicks: 0,
        rhythmStep: Math.floor(Math.random() * 8),
        lastTriggerAtMs: -Infinity,
        skippedByLoad: 0,
        skippedByRhythm: 0,
        lastRhythmAccent: 1,
      });
    }
  }

  start() {
    this.startAllFree(2.0);
  }

  startAllFree(initialSpeed = 2.0) {
    for (let c = 0; c < this.numColors; c++) {
      const cs = this.colorState[c];
      cs.mode = 'free';
      cs.orgId = null;
      cs.active = true;
      cs.vel = initialSpeed;
      cs.density = 1.0;
      cs.targetBpm = this._speedToBpm(cs.vel);
      cs.smoothedBpm = cs.targetBpm;
      cs.syncStrength = 0;
      cs.clockDrift = 0.94 + Math.random() * 0.14;
      cs.rhythmStep = Math.floor(Math.random() * 8);
      cs.lastTriggerAtMs = -Infinity;
      cs.skippedByLoad = 0;
      cs.skippedByRhythm = 0;
      if (!cs.timerId) this._scheduleFree(c, 120 + Math.random() * 780);
    }
  }

  stop() {
    for (const cs of this.colorState) {
      if (cs.timerId) {
        clearTimeout(cs.timerId);
        cs.timerId = null;
      }
    }
    for (const o of this.organisms.values()) {
      if (o.timerId) {
        clearTimeout(o.timerId);
        o.timerId = null;
      }
    }
    this.organisms.clear();
  }

  onKeyChange() {
    for (const m of this.markovs) m.rekey();
  }

  getDebugSnapshot() {
    return this.debugSnapshot;
  }

  _speedToBpm(speed) {
    const den = Math.max(0.5, this.speedCeil - this.speedFloor);
    const norm = clamp((speed - this.speedFloor) / den, 0, 1);
    // Only the extreme near-zero band is silent. Slow active colors should still
    // produce an audible clock instead of collapsing to rest.
    if (norm <= LOW_SPEED_HOLD) return 0;
    const mapped = Math.pow((norm - LOW_SPEED_HOLD) / (1 - LOW_SPEED_HOLD), TEMPO_CURVE_EXP);
    return BPM_MIN + mapped * (BPM_MAX - BPM_MIN);
  }

  _updateSpeedWindow(perColorStats) {
    let frameMin = Infinity;
    let frameMax = 0;
    let sum = 0;
    let active = 0;
    for (const stats of perColorStats) {
      if (stats.count <= 0) continue;
      frameMin = Math.min(frameMin, stats.avgSpeed);
      frameMax = Math.max(frameMax, stats.avgSpeed);
      sum += stats.avgSpeed;
      active++;
    }

    if (active === 0) {
      return { globalAvgSpeed: 0, globalBpm: BPM_MIN, activeColors: 0 };
    }

    this.observedMinSpeed = Math.min(this.observedMinSpeed, frameMin);
    this.observedMaxSpeed = Math.max(this.observedMaxSpeed, frameMax);

    const targetFloor = adaptSpeedFloor(frameMin);
    const targetCeil = adaptSpeedCeil(frameMax, targetFloor);
    this.speedFloor = this.speedFloor * 0.93 + targetFloor * 0.07;
    this.speedCeil = this.speedCeil * 0.93 + targetCeil * 0.07;
    this.speedFloor = clamp(this.speedFloor, 0.2, 40);
    this.speedCeil = clamp(this.speedCeil, this.speedFloor + 1.5, 80);

    const globalAvgSpeed = sum / active;
    return {
      globalAvgSpeed,
      globalBpm: this._speedToBpm(globalAvgSpeed),
      activeColors: active,
    };
  }

  _effectiveColorBpm(cs) {
    if (cs.orgId == null) return cs.smoothedBpm;
    const orgBpm = this.organisms.get(cs.orgId)?.bpm ?? 0;
    if (orgBpm < BPM_REST_SNAP) return cs.smoothedBpm;
    const attract = clamp(cs.syncStrength, 0, ORG_ATTRACTION_MAX);
    return cs.smoothedBpm * (1 - attract) + orgBpm * attract;
  }

  _nextClockIntervalMs(cs) {
    const bpm = this._effectiveColorBpm(cs);
    const hz = bpmToHz(bpm);
    if (hz <= 0) return Infinity;

    cs.driftTicks++;
    if (cs.driftTicks > 5 + Math.floor(Math.random() * 8)) {
      cs.clockDrift = clamp(
        cs.clockDrift + (Math.random() * 2 - 1) * DRIFT_STEP,
        DRIFT_MIN,
        DRIFT_MAX
      );
      cs.driftTicks = 0;
    }

    const jitter = FREE_CLOCK_JITTER + cs.syncStrength * SYNC_CLOCK_JITTER;
    const jitterMul = clamp(1 + (Math.random() * 2 - 1) * jitter, 0.46, 1.78);
    return Math.max(MIN_CLOCK_INTERVAL_MS, (1000 / hz) * cs.clockDrift * jitterMul);
  }

  _scheduleFree(c, initialDelayMs = null) {
    if (this._destroyed) return;
    const cs = this.colorState[c];
    if (!cs.active) {
      cs.timerId = null;
      return;
    }
    const intervalMs = initialDelayMs == null ? this._nextClockIntervalMs(cs) : initialDelayMs;
    if (!Number.isFinite(intervalMs)) {
      cs.lastIntervalMs = Infinity;
      cs.timerId = setTimeout(() => {
        cs.timerId = null;
        this._scheduleFree(c);
      }, IDLE_RECHECK_MS);
      return;
    }
    cs.lastIntervalMs = intervalMs;
    cs.timerId = setTimeout(() => {
      cs.timerId = null;
      this._tick(c);
      this._scheduleFree(c);
    }, intervalMs);
  }

  _scheduleOrg(id) {
    if (this._destroyed) return;
    const entry = this.organisms.get(id);
    if (!entry) return;
    entry.lastIntervalMs = 1000 / Math.max(0.0001, bpmToHz(entry.bpm));
  }

  _orgBpmCanLeadColor(cs, orgBpm, staySynced = false) {
    if (!Number.isFinite(orgBpm) || orgBpm < BPM_REST_SNAP) return false;
    const freeBpm = Number.isFinite(cs.smoothedBpm) ? cs.smoothedBpm : 0;
    if (freeBpm <= BPM_REST_SNAP) return true;
    const ratio = staySynced ? ORG_STAY_MIN_FREE_BPM_RATIO : ORG_ENTER_MIN_FREE_BPM_RATIO;
    return orgBpm >= freeBpm * ratio;
  }

  update(perColorStats, organisms) {
    this.tickCounter++;
    const speedSnapshot = this._updateSpeedWindow(perColorStats);

    // 1) Update per-color stats, loudness, and tempo targets.
    for (let c = 0; c < this.numColors; c++) {
      const stats = perColorStats[c];
      const cs = this.colorState[c];
      const wasActive = cs.active;
      cs.vel = stats.avgSpeed;
      cs.count = stats.count;
      cs.density = stats.avgDensity;
      cs.active = stats.count > 0;
      cs.targetBpm = this._speedToBpm(cs.vel);
      cs.smoothedBpm += (cs.targetBpm - cs.smoothedBpm) * COLOR_BPM_SMOOTHING;
      if (cs.targetBpm <= 0.01 && cs.smoothedBpm < BPM_REST_SNAP) cs.smoothedBpm = 0;
      const presence = stats.count > 0 ? 0.40 : 0.0;
      const dboost = Math.min(0.55, stats.avgDensity * 0.16);
      setVoiceLevel(this.voices[c], presence + dboost, 0.25);
      if (cs.active && (!wasActive || !cs.timerId)) {
        this._scheduleFree(c);
      }
      if (!cs.active) {
        cs.candidateOrgId = null;
        cs.candidateTicks = 0;
        cs.exitTicks = 0;
        cs.restFallbackTicks = 0;
        cs.lastMembershipScore = 0;
        cs.syncStrength *= 0.82;
      }
    }

    // 2) Compute confidence-weighted membership scores per color.
    const bestOrgByColor = new Array(this.numColors).fill(null);
    const bestScoreByColor = new Array(this.numColors).fill(0);
    const currentScoreByColor = new Array(this.numColors).fill(0);
    for (let c = 0; c < this.numColors; c++) {
      const totalForColor = perColorStats[c].count;
      if (totalForColor === 0) continue;
      for (const org of organisms) {
        const cnt = (org._colorCounts && org._colorCounts.get(c)) || 0;
        const ratio = cnt / totalForColor;
        if (ratio < COLOR_MEMBERSHIP_THRESHOLD) continue;
        const confidence = org.confidence ?? 1.0;
        const weightedScore = ratio * (0.65 + 0.35 * confidence);
        if (weightedScore > bestScoreByColor[c]) {
          bestScoreByColor[c] = weightedScore;
          bestOrgByColor[c] = org;
        }
      }
      const cs = this.colorState[c];
      if (cs.orgId != null) {
        const cur = organisms.find(o => o.id === cs.orgId);
        if (cur) {
          const cntCur = (cur._colorCounts && cur._colorCounts.get(c)) || 0;
          const ratioCur = cntCur / totalForColor;
          const confCur = cur.confidence ?? 1.0;
          currentScoreByColor[c] = ratioCur * (0.65 + 0.35 * confCur);
        }
      }
      cs.lastMembershipScore = bestScoreByColor[c];
    }

    // 3) Update or create per-organism schedulers.
    const aliveOrgIds = new Set(organisms.map(o => o.id));
    for (const org of organisms) {
      const targetBpm = this._speedToBpm(org.avgVelocity);
      let entry = this.organisms.get(org.id);
      if (!entry) {
        entry = {
          bpm: targetBpm,
          colors: new Set(),
          lastSeen: this.tickCounter,
          timerId: null,
          lastIntervalMs: 1000 / bpmToHz(targetBpm),
        };
        this.organisms.set(org.id, entry);
      } else {
        entry.bpm += (targetBpm - entry.bpm) * ORG_BPM_SMOOTHING;
        if (targetBpm <= 0.01 && entry.bpm < BPM_REST_SNAP) entry.bpm = 0;
        entry.lastSeen = this.tickCounter;
      }
    }

    // 4) Apply membership with hysteresis.
    for (let c = 0; c < this.numColors; c++) {
      const cs = this.colorState[c];
      if (!cs.active) continue;
      const bestOrg = bestOrgByColor[c];
      const bestOrgId = bestOrg ? bestOrg.id : null;
      const bestScore = bestScoreByColor[c];
      const currentScore = currentScoreByColor[c];

      if (cs.orgId == null) {
        if (bestOrgId != null && bestScore >= ENTER_THRESHOLD) {
          if (cs.candidateOrgId === bestOrgId) cs.candidateTicks++;
          else {
            cs.candidateOrgId = bestOrgId;
            cs.candidateTicks = 1;
          }
          if (cs.candidateTicks >= ENTER_CONFIRM_TICKS) {
            const newOrg = this.organisms.get(bestOrgId);
            if (newOrg && this._orgBpmCanLeadColor(cs, newOrg.bpm, false)) {
              newOrg.colors.add(c);
              cs.mode = 'synced';
              cs.orgId = bestOrgId;
              cs.exitTicks = 0;
              cs.restFallbackTicks = 0;
              if (!cs.timerId) this._scheduleFree(c);
            }
            cs.candidateOrgId = null;
            cs.candidateTicks = 0;
          }
        } else {
          cs.candidateOrgId = null;
          cs.candidateTicks = 0;
        }
      } else {
        const currentOrgBpm = this.organisms.get(cs.orgId)?.bpm ?? 0;
        if (!this._orgBpmCanLeadColor(cs, currentOrgBpm, true)) {
          const oldOrg = this.organisms.get(cs.orgId);
          if (oldOrg) oldOrg.colors.delete(c);
          cs.mode = 'free';
          cs.orgId = null;
          cs.exitTicks = 0;
          cs.restFallbackTicks = 0;
          cs.candidateOrgId = null;
          cs.candidateTicks = 0;
          cs.syncStrength += (0 - cs.syncStrength) * SYNC_ATTRACTION_SMOOTHING;
          if (!cs.timerId) this._scheduleFree(c);
          continue;
        }
        if (currentOrgBpm < BPM_REST_SNAP && cs.smoothedBpm >= BPM_MIN * 0.35) {
          cs.restFallbackTicks++;
        } else {
          cs.restFallbackTicks = 0;
        }

        if (currentScore >= EXIT_THRESHOLD) {
          cs.exitTicks = 0;
        } else {
          cs.exitTicks++;
        }

        if (bestOrgId != null && bestOrgId !== cs.orgId && bestScore >= ENTER_THRESHOLD) {
          if (cs.candidateOrgId === bestOrgId) cs.candidateTicks++;
          else {
            cs.candidateOrgId = bestOrgId;
            cs.candidateTicks = 1;
          }
          if (cs.candidateTicks >= SWITCH_CONFIRM_TICKS) {
            const oldOrg = this.organisms.get(cs.orgId);
            if (oldOrg) oldOrg.colors.delete(c);
            const newOrg = this.organisms.get(bestOrgId);
            if (newOrg && this._orgBpmCanLeadColor(cs, newOrg.bpm, false)) {
              newOrg.colors.add(c);
              cs.orgId = bestOrgId;
              cs.mode = 'synced';
              cs.exitTicks = 0;
              cs.restFallbackTicks = 0;
            } else {
              cs.mode = 'free';
              cs.orgId = null;
              cs.exitTicks = 0;
              cs.restFallbackTicks = 0;
              if (!cs.timerId) this._scheduleFree(c);
            }
            cs.candidateOrgId = null;
            cs.candidateTicks = 0;
          }
        } else if (cs.candidateOrgId !== null && cs.candidateOrgId !== cs.orgId) {
          cs.candidateOrgId = null;
          cs.candidateTicks = 0;
        }

        if (cs.exitTicks >= EXIT_CONFIRM_TICKS) {
          const oldOrg = this.organisms.get(cs.orgId);
          if (oldOrg) oldOrg.colors.delete(c);
          cs.mode = 'free';
          cs.orgId = null;
          cs.exitTicks = 0;
          cs.restFallbackTicks = 0;
          cs.candidateOrgId = null;
          cs.candidateTicks = 0;
          if (!cs.timerId) this._scheduleFree(c);
        } else if (cs.restFallbackTicks >= ORG_REST_FALLBACK_TICKS) {
          const oldOrg = this.organisms.get(cs.orgId);
          if (oldOrg) oldOrg.colors.delete(c);
          cs.mode = 'free';
          cs.orgId = null;
          cs.exitTicks = 0;
          cs.restFallbackTicks = 0;
          cs.candidateOrgId = null;
          cs.candidateTicks = 0;
          if (!cs.timerId) this._scheduleFree(c);
        }
      }

      const attractionScore = cs.orgId == null ? 0 : Math.max(currentScore, bestScore);
      const targetStrength = cs.orgId == null
        ? 0
        : clamp((attractionScore - EXIT_THRESHOLD) / Math.max(0.01, 1 - EXIT_THRESHOLD), 0, 1) * ORG_ATTRACTION_MAX;
      cs.syncStrength += (targetStrength - cs.syncStrength) * SYNC_ATTRACTION_SMOOTHING;
    }

    // 5) Garbage-collect stale organisms.
    for (let c = 0; c < this.numColors; c++) {
      const cs = this.colorState[c];
      if (cs.orgId != null && !aliveOrgIds.has(cs.orgId)) {
        cs.orgId = null;
        cs.mode = 'free';
        cs.exitTicks = 0;
        cs.restFallbackTicks = 0;
        cs.candidateOrgId = null;
        cs.candidateTicks = 0;
        cs.syncStrength += (0 - cs.syncStrength) * SYNC_ATTRACTION_SMOOTHING;
        if (cs.active && !cs.timerId) this._scheduleFree(c);
      }
    }

    for (const [id, entry] of this.organisms) {
      if (!aliveOrgIds.has(id) && this.tickCounter - entry.lastSeen > 2) {
        if (entry.timerId) {
          clearTimeout(entry.timerId);
          entry.timerId = null;
        }
        for (const c of entry.colors) {
          const cs = this.colorState[c];
          if (cs.orgId === id) {
            cs.orgId = null;
            cs.mode = 'free';
            cs.syncStrength += (0 - cs.syncStrength) * SYNC_ATTRACTION_SMOOTHING;
            if (cs.active && !cs.timerId) this._scheduleFree(c);
          }
        }
        this.organisms.delete(id);
      }
    }

    // 6) Stop chains for inactive colors.
    for (let c = 0; c < this.numColors; c++) {
      const cs = this.colorState[c];
      if (!cs.active && cs.timerId) {
        clearTimeout(cs.timerId);
        cs.timerId = null;
      }
    }

    this.debugSnapshot = {
      tick: this.tickCounter,
      globalAvgSpeed: speedSnapshot.globalAvgSpeed,
      globalBpm: speedSnapshot.globalBpm,
      speedFloor: this.speedFloor,
      speedCeil: this.speedCeil,
      observedMinSpeed: this.observedMinSpeed,
      observedMaxSpeed: this.observedMaxSpeed,
      activeColors: speedSnapshot.activeColors,
      colors: this.colorState.map((cs, idx) => ({
        idx,
        mode: cs.mode,
        orgId: cs.orgId,
        active: cs.active,
        count: cs.count,
        vel: cs.vel,
        density: cs.density,
        targetBpm: cs.targetBpm,
        smoothedBpm: cs.smoothedBpm,
        freeBpm: cs.smoothedBpm,
        orgBpm: cs.orgId != null ? (this.organisms.get(cs.orgId)?.bpm ?? 0) : 0,
        effectiveBpm: this._effectiveColorBpm(cs),
        syncStrength: cs.syncStrength,
        clockDrift: cs.clockDrift,
        rhythmStep: cs.rhythmStep,
        skippedByLoad: cs.skippedByLoad,
        skippedByRhythm: cs.skippedByRhythm,
        notesTriggered: cs.notesTriggered,
        membershipScore: cs.lastMembershipScore,
        exitTicks: cs.exitTicks,
      })),
      organisms: Array.from(this.organisms.entries()).map(([id, o]) => ({
        id,
        bpm: o.bpm,
        colorCount: o.colors.size,
        intervalMs: o.lastIntervalMs,
      })),
    };
    maybeLogDiag(this.debugSnapshot);
  }

  _pruneTriggerWindow(nowMs) {
    const cutoff = nowMs - NOTE_RATE_WINDOW_MS;
    while (this.recentTriggerTimes.length && this.recentTriggerTimes[0] < cutoff) {
      this.recentTriggerTimes.shift();
    }
  }

  _canTriggerUnderLoad(c, nowMs) {
    const cs = this.colorState[c];
    this._pruneTriggerWindow(nowMs);
    if (this.recentTriggerTimes.length >= GLOBAL_NOTES_PER_WINDOW) return false;
    return nowMs - cs.lastTriggerAtMs >= PER_COLOR_MIN_TRIGGER_MS;
  }

  _commitTrigger(c, nowMs) {
    this.recentTriggerTimes.push(nowMs);
    this.colorState[c].lastTriggerAtMs = nowMs;
  }

  _rhythmDecision(c, motionNorm, densityNorm) {
    const cs = this.colorState[c];
    const profile = COLOR_RHYTHMS[c % COLOR_RHYTHMS.length];
    const idx = cs.rhythmStep % profile.pattern.length;
    cs.rhythmStep++;

    const baseHit = profile.pattern[idx] === 1;
    const highMotion = clamp((motionNorm - 0.34) / 0.66, 0, 1);
    const densityFill = clamp(densityNorm * 0.45, 0, 0.45);
    const fillProb = profile.fill * highMotion + densityFill * 0.35;
    const thinProb = profile.thin * (1 - densityNorm * 0.45) * (0.35 + cs.syncStrength * 0.45);
    let hit = baseHit;

    if (!hit && Math.random() < fillProb) hit = true;
    if (hit && Math.random() < thinProb) hit = false;

    if (!hit) {
      cs.skippedByRhythm++;
      return null;
    }

    const accent = clamp(
      profile.accent[idx % profile.accent.length] * (0.88 + densityNorm * 0.22 + Math.random() * 0.10),
      0.52,
      1.36
    );
    const durScale = clamp(
      profile.dur[idx % profile.dur.length] * (1.08 - highMotion * 0.34),
      0.34,
      1.55
    );
    const leadMs = 26 + Math.random() * (AUDIO_PERF_MODE === 'safe' ? 42 : 64);
    cs.lastRhythmAccent = accent;
    return { accent, durScale, leadMs };
  }

  _tick(c) {
    const cs = this.colorState[c];
    if (!cs.active) return;
    const nowMs = performance.now();
    if (!this._canTriggerUnderLoad(c, nowMs)) {
      cs.skippedByLoad++;
      return;
    }
    const den = Math.max(0.5, this.speedCeil - this.speedFloor);
    const rawNorm = clamp((cs.vel - this.speedFloor) / den, 0, 1);
    const motionNorm = cs.targetBpm <= 0 ? 0 : rawNorm;
    const densityNorm = clamp(cs.density / 1.6, 0, 1);
    const extraRestProb = clamp(
      FREE_EXTRA_REST_PROB * (1 - motionNorm) * (1 - densityNorm * 0.35) +
      cs.syncStrength * SYNC_EXTRA_REST_PROB,
      0,
      0.36
    );
    if (Math.random() < extraRestProb) return;
    const rhythm = this._rhythmDecision(c, motionNorm, densityNorm);
    if (!rhythm) return;
    const note = this.markovs[c].next(this.getKey());
    if (note.isRest) return;
    const shaping = shapeVoiceForMotion(this.voices[c], c, motionNorm);
    const dur = COLOR_DURATION[c % COLOR_DURATION.length] * shaping.durScale * rhythm.durScale;
    const velBase = 0.60 + Math.min(0.35, cs.density * 0.04);
    const vel = clamp(velBase * shaping.velocityScale * rhythm.accent, 0.16, 0.98);
    triggerVoice(this.voices[c], note.midi, dur, Tone.now() + rhythm.leadMs / 1000, vel);
    cs.notesTriggered++;
    this._commitTrigger(c, nowMs);
  }

  destroy() {
    this._destroyed = true;
    this.stop();
    this.colorState = [];
  }
}
