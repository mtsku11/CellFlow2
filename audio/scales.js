// audio/scales.js
// Scale definitions and key picker. Pentatonic-family scales are favoured because
// they remain consonant under arbitrary simultaneous voicings, which we need when
// 6 colors might all be playing at once.

export const SCALES = {
  minorPent:   [0, 3, 5, 7, 10],
  majorPent:   [0, 2, 4, 7, 9],
  hirajoshi:   [0, 2, 3, 7, 8],
  kumoi:       [0, 2, 3, 7, 9],
  inSen:       [0, 1, 5, 7, 10],
  egyptian:    [0, 2, 5, 7, 10],
  blues:       [0, 3, 5, 6, 7, 10],
  wholeTone:   [0, 2, 4, 6, 8, 10],
};

export const SCALE_NAMES = Object.keys(SCALES);
const REGEN_MODE_CYCLE = [
  'minorPent',
  'hirajoshi',
  'kumoi',
  'inSen',
  'egyptian',
  'blues',
  'wholeTone',
  'majorPent',
];
const REGEN_ROOT_STEPS = [2, 5, -3, 7, -5, 3];

// MIDI root range — keeps the overall pitch field musical (G2..G3).
const ROOT_MIN = 43;
const ROOT_MAX = 55;

export function pickRandomKey(prevRoot = null) {
  const scaleName = SCALE_NAMES[Math.floor(Math.random() * SCALE_NAMES.length)];
  let root;
  // Avoid repeating the exact same root twice in a row so a regen is audibly distinct.
  do {
    root = ROOT_MIN + Math.floor(Math.random() * (ROOT_MAX - ROOT_MIN + 1));
  } while (root === prevRoot && (ROOT_MAX - ROOT_MIN) > 0);
  return { rootMidi: root, scaleName, intervals: SCALES[scaleName] };
}

function wrapRootToRange(root) {
  let out = root;
  while (out < ROOT_MIN) out += 12;
  while (out > ROOT_MAX) out -= 12;
  return out;
}

// Deterministic "world hop" key picker for REGEN:
// cycle modes in a fixed order and move root by an interval pattern so
// successive regenerations feel related but clearly different.
export function pickNextRegenKey(prevKey = null, regenCount = 0) {
  if (!prevKey) return pickRandomKey();
  const prevMode = prevKey.scaleName;
  const prevModeIdx = REGEN_MODE_CYCLE.indexOf(prevMode);
  const nextModeIdx = prevModeIdx >= 0
    ? (prevModeIdx + 1) % REGEN_MODE_CYCLE.length
    : (Math.abs(regenCount) % REGEN_MODE_CYCLE.length);
  const scaleName = REGEN_MODE_CYCLE[nextModeIdx];
  const step = REGEN_ROOT_STEPS[Math.abs(regenCount) % REGEN_ROOT_STEPS.length];
  const rootMidi = wrapRootToRange(prevKey.rootMidi + step);
  return { rootMidi, scaleName, intervals: SCALES[scaleName] };
}

// Convert a (degree, octaveOffset) pair under a key into a MIDI note number.
// degree wraps across octaves so a 5-note scale still gives access to the full range.
export function degreeToMidi(degree, octaveOffset, key) {
  const len = key.intervals.length;
  const octaveShift = Math.floor(degree / len);
  const stepIndex = ((degree % len) + len) % len;
  return key.rootMidi + key.intervals[stepIndex] + 12 * (octaveOffset + octaveShift);
}

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
