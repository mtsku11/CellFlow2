// audio/scheduler.js
// Per-color state machine and per-organism scheduling.
//
// Two modes per color:
//   - free:   color schedules its own notes; tempo follows that color's avg velocity
//   - synced: color shares an organism's clock; tempo follows that organism's
//             avg velocity. All colors in the same organism therefore lock together.

import * as Tone from 'https://cdn.jsdelivr.net/npm/tone@14.8.49/+esm';
import { triggerVoice, setVoiceLevel, shapeVoiceForMotion } from './voices.js?v=20260507o';

const BPM_MIN = 30;
const BPM_MAX = 220;
const SUBDIV = 4; // 16th-note subdivisions per beat
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
const ORG_ENTER_MIN_FREE_BPM_RATIO = 0.72;
const ORG_STAY_MIN_FREE_BPM_RATIO = 0.58;
const COLOR_DURATION = [0.30, 0.40, 0.18, 0.80, 0.10, 0.35];
const COLOR_BPM_SMOOTHING = 0.22;
const ORG_BPM_SMOOTHING = 0.28;

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
      if (!cs.timerId) this._scheduleFree(c);
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

  _scheduleFree(c) {
    if (this._destroyed) return;
    const cs = this.colorState[c];
    if (cs.mode !== 'free' || !cs.active) {
      cs.timerId = null;
      return;
    }
    const hz = bpmToHz(cs.smoothedBpm);
    if (hz <= 0) {
      cs.lastIntervalMs = Infinity;
      cs.timerId = setTimeout(() => {
        cs.timerId = null;
        this._scheduleFree(c);
      }, IDLE_RECHECK_MS);
      return;
    }
    const intervalMs = 1000 / hz;
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
    const hz = bpmToHz(entry.bpm);
    if (hz <= 0) {
      entry.lastIntervalMs = Infinity;
      entry.timerId = setTimeout(() => {
        const cur = this.organisms.get(id);
        if (!cur) return;
        cur.timerId = null;
        this._scheduleOrg(id);
      }, IDLE_RECHECK_MS);
      return;
    }
    const intervalMs = 1000 / hz;
    entry.lastIntervalMs = intervalMs;
    entry.timerId = setTimeout(() => {
      const cur = this.organisms.get(id);
      if (!cur) return;
      cur.timerId = null;
      for (const c of cur.colors) this._tick(c);
      this._scheduleOrg(id);
    }, intervalMs);
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
      if (cs.active && (!wasActive || !cs.timerId) && cs.mode === 'free') {
        this._scheduleFree(c);
      }
      if (!cs.active) {
        cs.candidateOrgId = null;
        cs.candidateTicks = 0;
        cs.exitTicks = 0;
        cs.restFallbackTicks = 0;
        cs.lastMembershipScore = 0;
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
        this._scheduleOrg(org.id);
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
              if (cs.timerId) {
                clearTimeout(cs.timerId);
                cs.timerId = null;
              }
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
        effectiveBpm: cs.orgId != null ? (this.organisms.get(cs.orgId)?.bpm ?? cs.smoothedBpm) : cs.smoothedBpm,
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

  _tick(c) {
    const cs = this.colorState[c];
    if (!cs.active) return;
    const note = this.markovs[c].next(this.getKey());
    if (note.isRest) return;
    const den = Math.max(0.5, this.speedCeil - this.speedFloor);
    const rawNorm = clamp((cs.vel - this.speedFloor) / den, 0, 1);
    const motionNorm = cs.targetBpm <= 0 ? 0 : rawNorm;
    const shaping = shapeVoiceForMotion(this.voices[c], c, motionNorm);
    const dur = COLOR_DURATION[c % COLOR_DURATION.length] * shaping.durScale;
    const velBase = 0.60 + Math.min(0.35, cs.density * 0.04);
    const vel = clamp(velBase * shaping.velocityScale, 0.2, 0.98);
    triggerVoice(this.voices[c], note.midi, dur, Tone.now() + 0.02, vel);
    cs.notesTriggered++;
  }

  destroy() {
    this._destroyed = true;
    this.stop();
    this.colorState = [];
  }
}
