// Contours and wind barbs for a model field, as GeoJSON the map draws itself.
//
// Both are vector rather than painted into the field's picture, so they stay sharp at
// any zoom, carry labels that follow the line, and sit over whichever field is shaded
// underneath — pressure over precipitation type, heights over vorticity.

import { sampler, gridTurn } from '../lib/model-grid.mjs';
import { barbName } from './barbs.mjs';

const RAD = Math.PI / 180;
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * Resample a field onto a regular latitude/longitude lattice over the box, and smooth
 * it: a 3 km model's pressure is busy enough at that scale that its isobars would
 * crawl round every hill.
 */
/** Each grid point given the largest value within about half a lattice step of it. */
function widen(grid, values, step) {
  const { nx, ny } = grid;
  const cellKm = grid.kind === 'latlon' || grid.kind === 'rotated' ? grid.dx * 111 : grid.dx / 1000;
  const r = Math.max(1, Math.ceil((step * 111) / Math.max(cellKm, 0.1) / 2));
  const tmp = new Float32Array(values.length).fill(NaN);
  const out = new Float32Array(values.length).fill(NaN);
  const spread = (from, to, along) => {
    for (let a = 0; a < (along ? ny : nx); a++) {
      for (let b = 0; b < (along ? nx : ny); b++) {
        let best = NaN;
        for (let d = -r; d <= r; d++) {
          const bb = b + d;
          if (bb < 0 || bb >= (along ? nx : ny)) continue;
          const v = from[along ? a * nx + bb : bb * nx + a];
          if (v === v && !(v <= best)) best = v;
        }
        to[along ? a * nx + b : b * nx + a] = best;
      }
    }
  };
  spread(values, tmp, true);
  spread(tmp, out, false);
  return out;
}

export function lattice(grid, values, box, step, passes) {
  const nx = Math.floor((box.east - box.west) / step) + 1;
  const ny = Math.floor((box.north - box.south) / step) + 1;
  const at = sampler(grid, values);
  let z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const lat = box.south + j * step;
    for (let i = 0; i < nx; i++) z[j * nx + i] = at(lat, box.west + i * step);
  }
  for (let pass = 0; pass < passes; pass++) {
    const out = new Float32Array(z.length);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = z[j * nx + i];
        if (Number.isNaN(c)) { out[j * nx + i] = NaN; continue; }
        let sum = 0;
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx) continue;
            const v = z[jj * nx + ii];
            if (!Number.isNaN(v)) { sum += v; n++; }
          }
        }
        out[j * nx + i] = sum / n;
      }
    }
    z = out;
  }
  return { z, nx, ny };
}

/**
 * Isolines of a field at its contour interval.
 *
 * Marching squares on the lattice, one cell at a time; each crossing lies on a cell
 * edge, and an edge is shared by the two cells either side of it, so naming the edges
 * is what stitches the pieces into lines long enough to carry a label.
 *
 * `inUnits`, for a field written in other units than its own (lib/units.mjs), has the
 * lines drawn at round numbers of those: { a, b } turning a value into one of them, and
 * the `iso`, `emph`, `units` and `digits` to draw them with there.
 *
 * @returns {object} a GeoJSON FeatureCollection of LineStrings, each with `v`, `label`
 *   and `emph`
 */
export function contourLines(grid, values, field, box, area, inUnits = null) {
  // A tenth of a degree is finer than any regional grid's isobars need; past ninety
  // degrees across (the Canadian regional domain) a fifth keeps the lattice in hand.
  const step = area === 'global' ? 0.5 : box.east - box.west > 90 ? 0.2 : 0.1;
  // A field with `widen` (narrow tracks) is spread over a lattice step first, so a track
  // a grid cell or two across is not passed over between the lattice's points, and is
  // not smoothed away after.
  if (field.widen) values = widen(grid, values, step);
  const { z, nx, ny } = lattice(grid, values, box, step, field.widen ? 0 : area === 'global' ? 1 : 3);
  if (inUnits) {
    for (let n = 0; n < z.length; n++) z[n] = z[n] * inUnits.a + inUnits.b;
    field = { ...field, ...inUnits };
  }
  const int = field.iso;
  const digits = field.digits ?? 0;
  const byLevel = new Map(); // k -> segments [[edgeA, ptA, edgeB, ptB]]

  const P = (i, j) => z[j * nx + i];
  const lonAt = (i) => box.west + i * step;
  const latAt = (j) => box.south + j * step;

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = P(i, j); // south-west
      const b = P(i + 1, j); // south-east
      const c = P(i + 1, j + 1); // north-east
      const d = P(i, j + 1); // north-west
      if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
      const lo = Math.min(a, b, c, d);
      const hi = Math.max(a, b, c, d);
      for (let k = Math.ceil(lo / int); k * int <= hi; k++) {
        const L = k * int;
        // A corner exactly on the level is nudged above it, so no crossing is counted
        // twice and no cell has a degenerate case.
        const above = (v) => v >= L;
        const code = (above(a) ? 1 : 0) | (above(b) ? 2 : 0) | (above(c) ? 4 : 0) | (above(d) ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const t = (p, q) => (L - p) / (q - p || 1e-9);
        // The four edges: name, and where the level crosses it.
        const S = () => [`h${i},${j}`, [lonAt(i) + t(a, b) * step, latAt(j)]];
        const E = () => [`v${i + 1},${j}`, [lonAt(i + 1), latAt(j) + t(b, c) * step]];
        const N = () => [`h${i},${j + 1}`, [lonAt(i) + t(d, c) * step, latAt(j + 1)]];
        const W = () => [`v${i},${j}`, [lonAt(i), latAt(j) + t(a, d) * step]];
        let segs;
        switch (code) {
          case 1: case 14: segs = [[S(), W()]]; break;
          case 2: case 13: segs = [[S(), E()]]; break;
          case 3: case 12: segs = [[W(), E()]]; break;
          case 4: case 11: segs = [[E(), N()]]; break;
          case 6: case 9: segs = [[S(), N()]]; break;
          case 7: case 8: segs = [[W(), N()]]; break;
          case 5: case 10: {
            // A saddle: which way it joins depends on the centre.
            const mid = (a + b + c + d) / 4 >= L;
            if ((code === 5) === mid) segs = [[S(), E()], [W(), N()]];
            else segs = [[S(), W()], [E(), N()]];
            break;
          }
          default: segs = [];
        }
        let list = byLevel.get(k);
        if (!list) byLevel.set(k, (list = []));
        for (const [[ea, pa], [eb, pb]] of segs) list.push([ea, pa, eb, pb]);
      }
    }
  }

  const features = [];
  for (const [k, segs] of byLevel) {
    // Each edge name is shared by at most two segments of one level: walk them into lines.
    const at = new Map();
    segs.forEach((s, n) => {
      for (const e of [s[0], s[2]]) {
        const list = at.get(e);
        if (list) list.push(n); else at.set(e, [n]);
      }
    });
    const used = new Uint8Array(segs.length);
    const L = k * int;
    for (let n = 0; n < segs.length; n++) {
      if (used[n]) continue;
      used[n] = 1;
      const [ea, pa, eb, pb] = segs[n];
      const line = [pa, pb];
      // Extend forward from eb, then backward from ea.
      for (const [start, push] of [[eb, (p) => line.push(p)], [ea, (p) => line.unshift(p)]]) {
        let edge = start;
        for (;;) {
          const next = (at.get(edge) || []).find((m) => !used[m]);
          if (next === undefined) break;
          used[next] = 1;
          const s = segs[next];
          if (s[0] === edge) { push(s[3]); edge = s[2]; } else { push(s[1]); edge = s[0]; }
        }
      }
      // Specks — a closed loop round a single lattice point — are noise, not features.
      if (line.length < 5) continue;
      features.push({
        type: 'Feature',
        properties: {
          v: L,
          label: `${L.toFixed(digits)}${field.units === '°F' || field.units === '°C' ? '°' : ''}`,
          emph: field.emph != null && Math.abs(field.emph - L) < int * 1e-6,
        },
        geometry: { type: 'LineString', coordinates: line.map(([x, y]) => [round3(x), round3(y)]) },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Wind barbs on a lattice. Every point carries a rank — 0 on the coarsest spacing,
 * up to 3 on the finest — and the map places low ranks first and drops whatever no
 * longer fits, so zooming in fills the gaps between the barbs already there.
 *
 * @returns {object} a GeoJSON FeatureCollection of Points with `barb`, `drct`, `rank`
 */
export function barbPoints(grid, u, v, box, area) {
  const fine = area === 'global' ? 1 : box.east - box.west > 90 ? 0.5 : 0.25;
  const atU = sampler(grid, u);
  const atV = sampler(grid, v);
  const turn = gridTurn(grid);
  const features = [];
  const i0 = Math.ceil(box.west / fine);
  const i1 = Math.floor(box.east / fine);
  const j0 = Math.ceil(box.south / fine);
  const j1 = Math.floor(box.north / fine);
  for (let jj = j0; jj <= j1; jj++) {
    const lat = jj * fine;
    for (let ii = i0; ii <= i1; ii++) {
      const lon = ii * fine;
      let uu = atU(lat, lon);
      let vv = atV(lat, lon);
      if (Number.isNaN(uu) || Number.isNaN(vv)) continue;
      if (turn) {
        const a = turn(lat, lon);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const ue = ca * uu + sa * vv;
        const ve = -sa * uu + ca * vv;
        uu = ue;
        vv = ve;
      }
      // Coarse lattice points are those on every 2nd, 4th, 8th line both ways.
      let k = 0;
      while (k < 3 && ii % (2 << k) === 0 && jj % (2 << k) === 0) k++;
      const kt = Math.hypot(uu, vv) * 1.943844;
      const from = ((Math.atan2(-uu, -vv) / RAD) + 360) % 360;
      features.push({
        type: 'Feature',
        properties: { barb: `m${barbName(kt)}`, drct: Math.round(from), rank: 3 - k },
        geometry: { type: 'Point', coordinates: [round3(lon), round3(lat)] },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
