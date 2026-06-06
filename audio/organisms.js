// audio/organisms.js
// Detect emergent multi-color clusters from particle data, with stable IDs
// across frames so the audio scheduler doesn't churn every readback.

// --- Tunables (could be exposed in UI later) ---
const MIN_ORG_SIZE_BASE = 24;     // baseline lower bound
const MIN_ORG_SIZE_RATIO = 0.005; // 0.5% of particles
const MIN_ORG_SIZE_MAX = 72;
const MIN_ORG_COLORS = 2;         // and at least this many distinct colors
const ID_MATCH_MAX_DIST = 120;    // px — max centroid drift to be the "same" organism
const ID_MATCH_MIN_OVERLAP = 0.3; // colorSet Jaccard overlap to be considered same
const STABILITY_STEPS_TO_FULL = 6;

// --- Union-Find ---
class UF {
  constructor(n) {
    this.parent = new Int32Array(n);
    this.rank = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]; // path compression
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
}

// State for cross-frame ID matching.
let nextOrgId = 1;
let prevOrganisms = [];

// Detect organisms.
//   particleData: Float32/Uint32 view of the particle buffer (32B stride, 8 floats per particle)
//   numParticles: count of particles
//   neighborRadius: same `radius` value used by the simulation
//   canvasW, canvasH: canvas dimensions (for wrap-around aware distance)
// Returns array of { id, indices, colorSet, size, centroidX, centroidY, avgVelocity }
export function detectOrganisms(particleFloats, particleUints, numParticles, neighborRadius, canvasW, canvasH, options = {}) {
  if (numParticles === 0) return [];
  const motionScale = clamp01(Math.abs(options.deltaT ?? 1));
  const minOrgSize = Math.min(
    MIN_ORG_SIZE_MAX,
    Math.max(MIN_ORG_SIZE_BASE, Math.round(numParticles * MIN_ORG_SIZE_RATIO))
  );

  const cellSize = neighborRadius;
  const cols = Math.max(1, Math.ceil(canvasW / cellSize));
  const rows = Math.max(1, Math.ceil(canvasH / cellSize));

  // Build spatial hash: cell -> list of particle indices.
  // Using a flat Map of "row*cols+col" -> array because most cells will be empty.
  const cells = new Map();
  for (let i = 0; i < numParticles; i++) {
    const fb = i * 8;
    const x = particleFloats[fb + 0];
    const y = particleFloats[fb + 1];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(x / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(y / cellSize)));
    const key = cy * cols + cx;
    let bucket = cells.get(key);
    if (!bucket) { bucket = []; cells.set(key, bucket); }
    bucket.push(i);
  }

  const uf = new UF(numParticles);
  const r2 = neighborRadius * neighborRadius;

  // For each cell, union particles within neighborRadius of each other.
  // Check this cell + 4 neighbors (right, down, down-right, down-left) so each
  // pair is examined once. Cells wrap because the simulation does too.
  for (const [key, indices] of cells) {
    const cy = Math.floor(key / cols);
    const cx = key - cy * cols;

    // Same cell — all pairs
    for (let a = 0; a < indices.length; a++) {
      const ia = indices[a];
      const fa = ia * 8;
      const ax = particleFloats[fa + 0];
      const ay = particleFloats[fa + 1];
      for (let b = a + 1; b < indices.length; b++) {
        const ib = indices[b];
        const fb = ib * 8;
        let dx = particleFloats[fb + 0] - ax;
        let dy = particleFloats[fb + 1] - ay;
        if (dx > canvasW * 0.5) dx -= canvasW; else if (dx < -canvasW * 0.5) dx += canvasW;
        if (dy > canvasH * 0.5) dy -= canvasH; else if (dy < -canvasH * 0.5) dy += canvasH;
        if (dx * dx + dy * dy <= r2) uf.union(ia, ib);
      }
    }

    // Neighbor cells (with wrap)
    const neighborOffsets = [[1, 0], [0, 1], [1, 1], [-1, 1]];
    for (const [ox, oy] of neighborOffsets) {
      const nx = (cx + ox + cols) % cols;
      const ny = (cy + oy + rows) % rows;
      const nKey = ny * cols + nx;
      const nbBucket = cells.get(nKey);
      if (!nbBucket) continue;
      for (let a = 0; a < indices.length; a++) {
        const ia = indices[a];
        const fa = ia * 8;
        const ax = particleFloats[fa + 0];
        const ay = particleFloats[fa + 1];
        for (let b = 0; b < nbBucket.length; b++) {
          const ib = nbBucket[b];
          const fb = ib * 8;
          let dx = particleFloats[fb + 0] - ax;
          let dy = particleFloats[fb + 1] - ay;
          if (dx > canvasW * 0.5) dx -= canvasW; else if (dx < -canvasW * 0.5) dx += canvasW;
          if (dy > canvasH * 0.5) dy -= canvasH; else if (dy < -canvasH * 0.5) dy += canvasH;
          if (dx * dx + dy * dy <= r2) uf.union(ia, ib);
        }
      }
    }
  }

  // Collect cluster roots.
  const groups = new Map(); // root -> { indices, colorSet (Set), cellKeys(Set), sumX, sumY, sumVx, sumVy, sumSpeed }
  for (let i = 0; i < numParticles; i++) {
    const root = uf.find(i);
    let g = groups.get(root);
    if (!g) {
      g = {
        indices: [],
        colorSet: new Set(),
        cellKeys: new Set(),
        sumX: 0,
        sumY: 0,
        sumVx: 0,
        sumVy: 0,
        sumSpeed: 0
      };
      groups.set(root, g);
    }
    const fb = i * 8;
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(particleFloats[fb + 0] / cellSize)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor(particleFloats[fb + 1] / cellSize)));
    g.indices.push(i);
    g.colorSet.add(particleUints[i * 8 + 6]); // ptype lives at uint offset 6
    g.cellKeys.add(cy * cols + cx);
    g.sumX += particleFloats[fb + 0];
    g.sumY += particleFloats[fb + 1];
    const vx = particleFloats[fb + 2];
    const vy = particleFloats[fb + 3];
    g.sumVx += vx;
    g.sumVy += vy;
    g.sumSpeed += Math.min(30, Math.sqrt(vx * vx + vy * vy) * motionScale);
  }

  // Filter to organism-worthy clusters.
  const candidates = [];
  for (const g of groups.values()) {
    if (g.indices.length >= minOrgSize && g.colorSet.size >= MIN_ORG_COLORS) {
      const crowding = clamp01(g.indices.length / Math.max(1, g.cellKeys.size * 8));
      candidates.push({
        indices: g.indices,
        colorSet: g.colorSet,
        size: g.indices.length,
        centroidX: g.sumX / g.indices.length,
        centroidY: g.sumY / g.indices.length,
        avgVelocity: g.sumSpeed / g.indices.length,
        crowding,
      });
    }
  }

  // ID matching to previous frame.
  // Greedy: for each new organism, find the prev organism that's closest in
  // centroid AND has sufficient color overlap. If found, inherit its id.
  const usedPrev = new Set();
  for (const cand of candidates) {
    let bestPrev = null;
    let bestScore = Infinity;
    for (const prev of prevOrganisms) {
      if (usedPrev.has(prev.id)) continue;
      let dx = cand.centroidX - prev.centroidX;
      let dy = cand.centroidY - prev.centroidY;
      if (dx > canvasW * 0.5) dx -= canvasW; else if (dx < -canvasW * 0.5) dx += canvasW;
      if (dy > canvasH * 0.5) dy -= canvasH; else if (dy < -canvasH * 0.5) dy += canvasH;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > ID_MATCH_MAX_DIST) continue;
      const overlap = jaccard(cand.colorSet, prev.colorSet);
      if (overlap < ID_MATCH_MIN_OVERLAP) continue;
      // Score combines distance (lower better) and color similarity (higher better).
      const score = d * (1.5 - overlap);
      if (score < bestScore) { bestScore = score; bestPrev = prev; }
    }
    if (bestPrev) {
      cand.id = bestPrev.id;
      cand.age = (bestPrev.age || 1) + 1;
      usedPrev.add(bestPrev.id);
    } else {
      cand.id = nextOrgId++;
      cand.age = 1;
    }
    const stability = clamp01(cand.age / STABILITY_STEPS_TO_FULL);
    cand.confidence = clamp01(0.55 * stability + 0.45 * cand.crowding);
  }

  prevOrganisms = candidates;
  return candidates;
}

function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

// Reset state — useful when particle count or numTypes changes.
export function resetOrganismState() {
  prevOrganisms = [];
}
