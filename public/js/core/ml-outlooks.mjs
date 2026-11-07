// Machine-learning severe-weather chances drawn as outlook areas, for the outlook hook
// (app.mjs addOutlooks): a grid of a hazard's chance filled at SPC's probability levels
// and in its colours, each level an area of its own, holes and all.
//
// Nadocast (US): tornado, wind and hail chances, and their significant kinds, within
// 25 miles of a point, from HREF/SREF and HRRR/RAP through gradient-boosted trees. Three
// runs a day on its data server, each a GRIB2 grid on a 15 km Lambert grid:
//
//   00Z  f12-35   the convective day (12Z to 12Z)
//   12Z  f02-23   the rest of it, and f24-47, the next day
//   18Z  f02-17   the rest of it again
//
// Day 1 is the newest run out for the convective day under way, day 2 that day's 12Z run.

import { passFetch } from '../lib/passthrough.mjs';
import { decodeFile } from './grib2.mjs';
import { lattice } from '../render/model-overlay.mjs';

// SPC's levels and colours: tornado, and wind and hail.
const TOR = [[2, '#008b00'], [5, '#8b4726'], [10, '#ffc800'], [15, '#ff0000'], [30, '#ff00ff'], [45, '#912cee'], [60, '#104e8b']];
const SEVERE = [[5, '#8b4726'], [15, '#ffc800'], [30, '#ff0000'], [45, '#ff00ff'], [60, '#912cee']];
// The significant kinds run lower: from 1%, in the tornado colours.
const SIG = [[1, '#5fb85f'], ...TOR];

const KINDS = [
  { id: 'tornado', label: 'Tornado', name: 'tornado', levels: TOR },
  { id: 'wind', label: 'Wind', name: 'severe wind', levels: SEVERE },
  { id: 'hail', label: 'Hail', name: 'severe hail', levels: SEVERE },
  { id: 'sig_tornado', label: 'EF2+', name: 'EF2+ tornado', levels: SIG },
  { id: 'sig_wind', label: '65 kt+', name: '65 kt+ wind', levels: SIG },
  { id: 'sig_hail', label: '2 in+', name: '2 in+ hail', levels: SIG },
];

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

/**
 * A grid's areas at each level, lowest first (so the higher are drawn over them): each
 * [level, colour, polygons]. `box` the lattice's reach, `step` its spacing in degrees.
 */
export function areasOf(grid, values, levels, { box, step = 0.1, passes = 1 }) {
  const { z, nx, ny } = lattice(grid, values, box, step, passes);
  return latticeAreas(z, nx, ny, levels, box, step);
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

// --- Pictures ----------------------------------------------------------------------------------

/**
 * A lattice of levels read off a picture of an outlook: for each point, the picture's
 * pixels round where it falls (`toPixel(lon, lat)` -> [x, y], fitted to the picture's
 * coastline), each taken as the nearest of `classes` ({ rgb, level }; white is level 0)
 * if near enough, and the commonest of those kept. Points on lines and lettering, which
 * match no class, take their neighbours' level after, as do those `toPixel` gives null
 * for (under the picture's legend).
 */
export function pictureLattice({ data, width, height }, toPixel, classes, box, step, near = 42) {
  const nx = Math.floor((box.east - box.west) / step) + 1;
  const ny = Math.floor((box.north - box.south) / step) + 1;
  const z = new Float32Array(nx * ny).fill(NaN);
  const top = Math.max(...classes.map((c) => c.level)) + 1;
  const votes = new Uint16Array(top);
  const classify = (x, y) => {
    const o = (y * width + x) * 4;
    let best = -1;
    let bd = near * near;
    for (const c of classes) {
      const d = (data[o] - c.rgb[0]) ** 2 + (data[o + 1] - c.rgb[1]) ** 2 + (data[o + 2] - c.rgb[2]) ** 2;
      if (d < bd) { bd = d; best = c.level; }
    }
    return best;
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const at = toPixel(box.west + i * step, box.south + j * step);
      // Under the picture's legend: decided by the points round it, as a line is.
      if (!at) { z[j * nx + i] = -1; continue; }
      const [px, py] = at;
      const x0 = Math.round(px);
      const y0 = Math.round(py);
      if (x0 < 1 || y0 < 1 || x0 >= width - 1 || y0 >= height - 1) continue;
      votes.fill(0);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const c = classify(x0 + dx, y0 + dy); if (c >= 0) votes[c]++; }
      let lv = -1;
      for (let k = 0; k < top; k++) if (votes[k] && (lv < 0 || votes[k] > votes[lv])) lv = k;
      if (lv >= 0) z[j * nx + i] = lv;
      else z[j * nx + i] = -1; // on a line: decided below
    }
  }
  // Lines, lettering and legends: the commonest level among the decided neighbours,
  // widening a point a pass until none is left.
  for (let pass = 0; pass < 400; pass++) {
    let left = 0;
    const next = z.slice();
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (z[j * nx + i] !== -1) continue;
        votes.fill(0);
        let any = false;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di; const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
            const v = z[jj * nx + ii];
            if (v >= 0) { votes[v]++; any = true; }
          }
        }
        if (!any) { left++; continue; }
        let lv = 0;
        for (let k = 0; k < top; k++) if (votes[k] > votes[lv]) lv = k;
        next[j * nx + i] = lv;
      }
    }
    z.set(next);
    if (!left) break;
  }
  for (let n = 0; n < z.length; n++) if (!(z[n] >= 0)) z[n] = 0;
  return { z, nx, ny };
}

/** A picture's pixels, from its bytes. */
export async function pictureOf(blob) {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  return g.getImageData(0, 0, bmp.width, bmp.height);
}

/** Levels as outlook features (the hook's shape), the empty ones left out. */
export function outlookFeatures(areas, props) {
  return areas.filter(([, , polys]) => polys.length).map(([L, colour, polys, extra]) => ({
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: polys },
    properties: { fill: colour, stroke: colour, ...props(L, extra) },
  }));
}

// --- Nadocast ------------------------------------------------------------------------------

const CONUS = { south: 19.5, north: 55.5, west: -135.5, east: -59 };
const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`; };
const kept = new Map(); // file -> { at, areas }
const KEEP = 10 * 60e3;

/** The files that might hold a day's chances, newest first: [run hour, forecast hours]. */
function candidates(day) {
  // The convective day under way began at the last 12Z.
  const start = Math.floor((Date.now() - 12 * 3600e3) / 864e5) * 864e5 + 12 * 3600e3;
  const ymd = ymdOf(start - 12 * 3600e3);
  return day === 1
    ? { start, ymd, runs: [[18, '02-17'], [12, '02-23'], [0, '12-35']] }
    : { start: start + 864e5, ymd, runs: [[12, '24-47']] };
}

async function nadocastFile(path) {
  const r = await passFetch(`/nadocast/${path}`, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) return null;
  return new Uint8Array(await r.arrayBuffer());
}

/** Day 1 or 2's areas of a hazard, as outlook features (the hook's shape). */
async function nadocastAreas(day, kindId) {
  const kind = KINDS.find((k) => k.id === kindId) || KINDS[0];
  const { start, ymd, runs } = candidates(day);
  for (const [hh, hours] of runs) {
    const path = `${ymd.slice(0, 6)}/${ymd}/t${hh}z/nadocast_2022_models_conus_${kind.id}_${ymd}_t${pad(hh)}z_f${hours}.grib2`;
    let hit = kept.get(path);
    if (!hit || Date.now() - hit.at > KEEP) {
      const bytes = await nadocastFile(path).catch(() => null);
      if (!bytes) continue;
      // Nadocast packs its grids in JPEG 2000: its decoder, loaded the first time.
      await (await import('./j2k.mjs')).loadJpeg2000();
      const [rec] = decodeFile(bytes);
      if (!rec) continue;
      hit = { at: Date.now(), areas: areasOf(rec.grid, rec.values, kind.levels, { box: CONUS, step: 0.1, passes: 1 }) };
      kept.set(path, hit);
    }
    const run = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), hh);
    return hit.areas.filter(([, , polys]) => polys.length).map(([L, colour, polys]) => ({
      type: 'Feature',
      geometry: { type: 'MultiPolygon', coordinates: polys },
      properties: {
        label: `${L}%`, detail: `${L}% ${kind.name}`, fill: colour, stroke: colour, day, kind: kind.id, kindLabel: kind.label,
        valid: new Date(start).toISOString(), expires: new Date(start + 864e5).toISOString(), run: new Date(run).toISOString(),
        machine: 'Nadocast',
      },
    }));
  }
  throw new Error('no run out yet');
}

/** Nadocast, for the outlook hook. */
export const NADOCAST = {
  id: 'nadocast',
  label: 'Nadocast',
  note: 'Machine-learning chances within 25 mi, US. 00Z, 12Z and 18Z runs.',
  days: 2,
  kinds: KINDS.map(({ id, label }) => ({ id, label })),
  load: nadocastAreas,
  credit: 'Nadocast (Brian Hempel)',
};
