// Probability areas from a lattice: each level's outline (marching squares), stitched into
// polygons with their holes, for drawing as filled areas. Shared by the app's machine-learning
// outlooks (core/ml-outlooks.mjs, core/stormycast.mjs) and the Stormycast website.

/** A ring's signed area (positive anticlockwise), in square degrees. */
function area(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return s / 2;
}

/** Is a point inside a ring (even-odd)? */
function inside([x, y], ring) {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** Douglas-Peucker on a closed ring, to within `tol` degrees. */
function simplify(ring, tol) {
  if (ring.length < 8) return ring;
  const keep = new Uint8Array(ring.length);
  const last = ring.length - 1;
  // A closed ring starts and ends on the same point: split it at the point farthest
  // from there, so each half has a line to measure from.
  let far0 = 1;
  for (let k = 1; k < last; k++) {
    if (Math.hypot(ring[k][0] - ring[0][0], ring[k][1] - ring[0][1]) > Math.hypot(ring[far0][0] - ring[0][0], ring[far0][1] - ring[0][1])) far0 = k;
  }
  keep[0] = keep[far0] = keep[last] = 1;
  const stack = [[0, far0], [far0, last]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = ring[a];
    const [x2, y2] = ring[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let far = -1;
    let at = -1;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs(dy * ring[k][0] - dx * ring[k][1] + x2 * y1 - y2 * x1) / len;
      if (d > far) { far = d; at = k; }
    }
    if (far > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return ring.filter((_, k) => keep[k]);
}

/**
 * Where a lattice is at or above a level, as polygons with their holes: marching squares
 * on the lattice framed in nothing (so every outline closes), the pieces stitched by the
 * cell edges they share, then each outline put inside the one around it.
 */
function fill(p, W, H, L, lon, lat, minArea) {
  const v = (i, j) => p[j * W + i];
  const at = (a, b) => (L - a) / (b - a || 1e-9);
  const segs = [];
  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = v(i, j); const b = v(i + 1, j); const c = v(i + 1, j + 1); const d = v(i, j + 1);
      const code = (a >= L ? 1 : 0) | (b >= L ? 2 : 0) | (c >= L ? 4 : 0) | (d >= L ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const S = [`h${i},${j}`, lon(i + at(a, b)), lat(j)];
      const E = [`v${i + 1},${j}`, lon(i + 1), lat(j + at(b, c))];
      const N = [`h${i},${j + 1}`, lon(i + at(d, c)), lat(j + 1)];
      const Wd = [`v${i},${j}`, lon(i), lat(j + at(a, d))];
      const mid = (a + b + c + d) / 4 >= L;
      switch (code) {
        case 1: case 14: segs.push([Wd, S]); break;
        case 2: case 13: segs.push([S, E]); break;
        case 3: case 12: segs.push([Wd, E]); break;
        case 4: case 11: segs.push([E, N]); break;
        case 6: case 9: segs.push([S, N]); break;
        case 7: case 8: segs.push([Wd, N]); break;
        case 5: if (mid) segs.push([S, E], [N, Wd]); else segs.push([Wd, S], [E, N]); break;
        case 10: if (mid) segs.push([Wd, S], [E, N]); else segs.push([S, E], [N, Wd]); break;
        default: break;
      }
    }
  }
  // Stitch: every edge crossed is shared by exactly two pieces.
  const byEdge = new Map();
  segs.forEach((s, k) => { for (const e of s) (byEdge.get(e[0]) || byEdge.set(e[0], []).get(e[0])).push(k); });
  const used = new Uint8Array(segs.length);
  const rings = [];
  for (let k = 0; k < segs.length; k++) {
    if (used[k]) continue;
    used[k] = 1;
    const ring = [[segs[k][0][1], segs[k][0][2]]];
    let end = segs[k][1];
    for (;;) {
      ring.push([end[1], end[2]]);
      const next = (byEdge.get(end[0]) || []).find((n) => !used[n]);
      if (next == null) break;
      used[next] = 1;
      end = segs[next][0][0] === end[0] ? segs[next][1] : segs[next][0];
    }
    if (ring.length >= 4) rings.push(ring);
  }
  // Nesting: an outline inside an even number of others bounds an area, inside an odd
  // number a hole in the one just around it.
  const kept = rings.map((r) => simplify(r, 0.02)).filter((r) => r.length >= 4 && Math.abs(area(r)) >= minArea);
  const depth = kept.map((r, k) => kept.reduce((n, o, m) => n + (m !== k && inside(r[0], o) ? 1 : 0), 0));
  const polys = [];
  const outerOf = new Map();
  kept.forEach((r, k) => {
    if (depth[k] % 2) return;
    if (area(r) < 0) r.reverse(); // anticlockwise outside
    outerOf.set(k, polys.push([r]) - 1);
  });
  kept.forEach((r, k) => {
    if (!(depth[k] % 2)) return;
    // The innermost outline around it: the one with the smallest area that holds it.
    let best = -1;
    kept.forEach((o, m) => {
      if (depth[m] === depth[k] - 1 && inside(r[0], o) && (best < 0 || Math.abs(area(o)) < Math.abs(area(kept[best])))) best = m;
    });
    if (best < 0 || !outerOf.has(best)) return;
    if (area(r) > 0) r.reverse(); // clockwise holes
    polys[outerOf.get(best)].push(r);
  });
  return polys;
}

/** The same from a lattice already made: `z` row by row from the south-west corner. */
export function latticeAreas(z, nx, ny, levels, box, step, minCells = 2) {
  const W = nx + 2;
  const H = ny + 2;
  const p = new Float32Array(W * H);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v = z[j * nx + i];
      p[(j + 1) * W + i + 1] = Number.isFinite(v) ? v : 0;
    }
  }
  const lon = (x) => +(box.west + (x - 1) * step).toFixed(3);
  const lat = (y) => +(box.south + (y - 1) * step).toFixed(3);
  return levels.map(([L, colour]) => [L, colour, fill(p, W, H, L, lon, lat, step * step * minCells)]);
}

