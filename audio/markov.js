// audio/markov.js
// Per-color melodic Markov chain over scale degrees.
// Each color is given a different transition matrix so their melodies have
// distinguishable personalities even when the underlying scale is shared.

import { degreeToMidi } from './scales.js';

// Six personality archetypes. Indexed by color slot (0..5). If numParticleTypes
// is smaller than 6 we just use the first N. If it's larger we wrap.
// Each row of `bias` describes the relative weight of moving by that interval
// (in scale-degree steps) from the current degree:
//   index 0 = stay, 1 = +1, 2 = -1, 3 = +2, 4 = -2, 5 = +3, 6 = -3, 7 = +4, 8 = -4
const STEP_DELTAS = [0, 1, -1, 2, -2, 3, -3, 4, -4];

const PERSONALITIES = [
  // 0 red — bass-like: prefers staying or small steps, occasional leaps down
  { bias: [3, 2, 2, 1, 2, 0.5, 1, 0.2, 0.5], restProb: 0.15, restDurBeats: [1, 2] },
  // 1 orange — warm mid: balanced melodic motion
  { bias: [1, 3, 3, 2, 2, 1, 1, 0.5, 0.5], restProb: 0.10, restDurBeats: [0.5, 1] },
  // 2 yellow — bright pluck: skippy, restless, prefers ascending leaps
  { bias: [0.5, 2, 1, 2, 1, 2, 0.5, 1, 0.3], restProb: 0.05, restDurBeats: [0.25, 0.5] },
  // 3 green — pad-like: very stable, mostly stays or moves by step
  { bias: [5, 2, 2, 0.5, 0.5, 0.2, 0.2, 0.1, 0.1], restProb: 0.20, restDurBeats: [2, 4] },
  // 4 blue — percussive: stays a lot then jumps
  { bias: [4, 1, 1, 0.5, 0.5, 1.5, 1.5, 0.5, 0.5], restProb: 0.25, restDurBeats: [0.5, 1] },
  // 5 magenta — lead: melodic, ascending bias, fluid
  { bias: [1, 3, 2, 2.5, 1.5, 1.5, 0.8, 0.8, 0.4], restProb: 0.05, restDurBeats: [0.25, 0.5] },
];

function normalize(arr) {
  const sum = arr.reduce((a, b) => a + b, 0);
  return arr.map(v => v / sum);
}

function weightedPick(weights, rnd = Math.random) {
  const r = rnd();
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i];
    if (r < acc) return i;
  }
  return weights.length - 1;
}

export class MarkovMelody {
  constructor(colorIndex, octaveOffset = 0) {
    const p = PERSONALITIES[colorIndex % PERSONALITIES.length];
    this.weights = normalize(p.bias);
    this.restProb = p.restProb;
    this.restDurBeats = p.restDurBeats;
    this.octaveOffset = octaveOffset;
    this.degree = 0; // current scale degree (relative to root)
  }

  // Returns { midi, isRest, durationBeats } where durationBeats is only
  // a hint for rests — actual note duration is set by the scheduler.
  next(key) {
    if (Math.random() < this.restProb) {
      const [lo, hi] = this.restDurBeats;
      const dur = lo + Math.random() * (hi - lo);
      return { midi: null, isRest: true, durationBeats: dur };
    }
    const stepIdx = weightedPick(this.weights);
    const delta = STEP_DELTAS[stepIdx];
    this.degree += delta;
    // Soft-bound the degree so we don't drift off into infinity.
    if (this.degree > 14) this.degree -= 7;
    if (this.degree < -14) this.degree += 7;
    const midi = degreeToMidi(this.degree, this.octaveOffset, key);
    return { midi, isRest: false, durationBeats: 1 };
  }

  // When the key changes, we keep our scale-degree state (so the melody contour
  // is preserved) but re-anchor by clamping the degree near zero so the new key
  // is heard from a "fresh" starting point.
  rekey() {
    this.degree = Math.round(this.degree / 2);
  }
}
