// HRRR (v4, 3 km) for Stormycast over the US: a day of one run's forecast turned into
// features at given points, the same for training (stormycast-hrrr-samples.mjs, the 12Z
// run's first 24 hours, 2021 on) and the daily runs (stormycast-run.mjs).
//
// The storm itself, as HRRR draws it, is the day's highest value in each pixel of each
// hourly maximum — updraft helicity 2–5 km and 0–3 km, hail size, 10 m wind, updraft,
// 1 km reflectivity, lightning — taken over 40 km round a point (and 100 km for helicity
// and hail), with the share of those pixels past a mark. The air round it is from two
// snapshots, nine and fifteen hours into the day (21Z and 03Z for a 12Z-to-12Z day):
// HRRR's own CAPE, CIN, helicity, shear and storm motion, averaged over 20 km, a few as
// highs over 40 km. Files from NOAA's AWS copy, fields by byte range from the .idx.

import { decodeMessage } from '../../public/js/core/grib2.mjs';
import { locator } from '../../public/js/lib/model-grid.mjs';
import { HRRR_GRID } from '../../public/js/core/hrrr-zarr.mjs';

const BASE = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com';
const NX = HRRR_GRID.nx;
const NY = HRRR_GRID.ny;
const NP = NX * NY;
const pad = (n, k = 2) => String(n).padStart(k, '0');

let active = 0;
const waiting = [];
let bytes = 0;
export const hrrrFetched = () => bytes;
let LIMIT = 12;
export function setHrrrLimit(n) { LIMIT = n; }
async function slot(fn) {
  while (active >= LIMIT) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
async function get(url, range, text = false) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await slot(async () => {
        const r = await fetch(url, { headers: range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : {}, signal: AbortSignal.timeout(90000) });
        if (r.status === 404 || r.status === 403) return null;
        if (!r.ok) throw new Error(`HRRR ${r.status}`);
        if (text) return r.text();
        const b = new Uint8Array(await r.arrayBuffer());
        bytes += b.length;
        return b;
      });
    } catch (err) { last = err; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
  }
  throw last;
}
const fileOf = (run, f) => {
  const d = new Date(run);
  return `${BASE}/hrrr.${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}/conus/hrrr.t${pad(d.getUTCHours())}z.wrfsfcf${pad(f)}.grib2`;
};
const idxKept = new Map();
async function idxOf(run, f) {
  const url = fileOf(run, f);
  if (!idxKept.has(url)) {
    idxKept.set(url, get(`${url}.idx`, null, true).then((t) => {
      if (!t) return null;
      const lines = t.trim().split('\n').map((l) => l.split(':'));
      return lines.map((l, k) => ({ name: `${l[3]}:${l[4]}:${l[5]}`, start: +l[1], end: k + 1 < lines.length ? +lines[k + 1][1] : null }));
    }));
    if (idxKept.size > 120) idxKept.delete(idxKept.keys().next().value);
  }
  return idxKept.get(url);
}
/** Whether a run's forecast hour is out. */
export async function hrrrHas(run, f) { return !!(await idxOf(run, f)); }

/** A field (var:level, and a pattern for the time part) at a forecast hour, or null. */
async function field(run, f, what, time = null) {
  const idx = await idxOf(run, f);
  if (!idx) return null;
  const e = idx.find((x) => x.name.startsWith(`${what}:`) && (!time || time.test(x.name)));
  if (!e) return null;
  const b = await get(fileOf(run, f), [e.start, e.end ?? e.start + 50e6]);
  if (!b) return null;
  return decodeMessage(b).values;
}

// --- the points' neighbourhoods ----------------------------------------------------------------
const locate = locator(HRRR_GRID);
/** For each point, its pixels within 20, 40 and 100 km (the last every other pixel). */
export function neighbourhoods(points) {
  return points.map(({ lat, lon }) => {
    const [ci, cj] = locate(lat, lon);
    const out = { r20: [], r40: [], r100: [] };
    if (!(ci > -34 && cj > -34 && ci < NX + 33 && cj < NY + 33)) return out;
    const i0 = Math.round(ci);
    const j0 = Math.round(cj);
    for (let dj = -34; dj <= 34; dj++) {
      const j = j0 + dj;
      if (j < 0 || j >= NY) continue;
      for (let di = -34; di <= 34; di++) {
        const i = i0 + di;
        if (i < 0 || i >= NX) continue;
        const d = Math.hypot(i - ci, j - cj) * 3;
        const k = j * NX + i;
        if (d <= 20) out.r20.push(k);
        if (d <= 40) out.r40.push(k);
        if (d <= 100 && !(i & 1) && !(j & 1)) out.r100.push(k);
      }
    }
    return { r20: Int32Array.from(out.r20), r40: Int32Array.from(out.r40), r100: Int32Array.from(out.r100) };
  });
}

// --- a day ---------------------------------------------------------------------------------------
const STORM = [
  // [name, var:level, mark for the share past it]
  ['uh25', 'MXUPHL:5000-2000 m above ground', 25],
  ['uh03', 'MXUPHL:3000-0 m above ground', 25],
  ['hail', 'HAIL:0.1 sigma level', 0.0254],
  ['wind10', 'WIND:10 m above ground', 25],
  ['uvv', 'MAXUVV:100-1000 mb above ground', null],
  ['ref', 'MAXREF:1000 m above ground', 40],
  ['ltng', 'LTNG:entire atmosphere', null, null], // lightning is the hour's, not a maximum
];
const ENV = [
  ['sbcape', 'CAPE:surface'], ['mlcape', 'CAPE:90-0 mb above ground'], ['mucape', 'CAPE:255-0 mb above ground'],
  ['sbcin', 'CIN:surface'], ['mlcin', 'CIN:90-0 mb above ground'], ['cape03', 'CAPE:0-3000 m above ground'],
  ['srh1', 'HLCY:1000-0 m above ground'], ['srh3', 'HLCY:3000-0 m above ground'],
  ['ushr', 'VUCSH:0-6000 m above ground'], ['vshr', 'VVCSH:0-6000 m above ground'],
  ['ustm', 'USTM:0-6000 m above ground'], ['vstm', 'VSTM:0-6000 m above ground'],
  ['t2', 'TMP:2 m above ground'], ['td2', 'DPT:2 m above ground'], ['t700', 'TMP:700 mb'], ['t500', 'TMP:500 mb'],
  ['pwat', 'PWAT:entire atmosphere (considered as a single layer)'],
];
const SNAP = ['sbcape', 'mlcape', 'mucape', 'sbcin', 'mlcin', 'cape03', 'srh1', 'srh3', 'shr6', 'storm', 't2', 'td2', 'lcl', 'lapse75', 'pwat', 'stp', 'scp'];
const SNAP_MAX = ['mlcape', 'srh1', 'stp', 'scp'];
export const HRRR_FEATURES = [
  ...STORM.flatMap(([n, , mark]) => [`${n}_max`, ...(mark != null ? [`${n}_cov`] : [])]), 'uh25_max100', 'hail_max100', 'rain_max', 'rain_mean',
  ...['a', 'b'].flatMap((s) => [...SNAP.map((f) => `${s}_${f}`), ...SNAP_MAX.map((f) => `${s}_${f}_max40`)]),
];

/** The air of one snapshot, pixel by pixel, as SNAP's fields. */
async function snapshot(run, f) {
  const F = {};
  await Promise.all(ENV.map(async ([k, what]) => { F[k] = await field(run, f, what); }));
  if (Object.values(F).some((a) => !a)) return null;
  const out = Object.fromEntries(SNAP.map((n) => [n, new Float32Array(NP)]));
  for (let k = 0; k < NP; k++) {
    const shr6 = Math.hypot(F.ushr[k], F.vshr[k]);
    const lcl = Math.max(0, 125 * (F.t2[k] - F.td2[k]));
    const ml = F.mlcape[k];
    const lclT = lcl < 1000 ? 1 : lcl > 2000 ? 0 : (2000 - lcl) / 1000;
    const shrT = shr6 < 12.5 ? 0 : Math.min(1.5, shr6 / 20);
    const cinT = F.mlcin[k] > -50 ? 1 : F.mlcin[k] < -200 ? 0 : (200 + F.mlcin[k]) / 150;
    out.sbcape[k] = F.sbcape[k]; out.mlcape[k] = ml; out.mucape[k] = F.mucape[k];
    out.sbcin[k] = F.sbcin[k]; out.mlcin[k] = F.mlcin[k]; out.cape03[k] = F.cape03[k];
    out.srh1[k] = F.srh1[k]; out.srh3[k] = F.srh3[k]; out.shr6[k] = shr6; out.storm[k] = Math.hypot(F.ustm[k], F.vstm[k]);
    out.t2[k] = F.t2[k] - 273.15; out.td2[k] = F.td2[k] - 273.15; out.lcl[k] = lcl; out.lapse75[k] = F.t700[k] - F.t500[k];
    out.pwat[k] = F.pwat[k];
    out.stp[k] = (ml / 1500) * lclT * (Math.max(0, F.srh1[k]) / 150) * shrT * cinT;
    out.scp[k] = (F.mucape[k] / 1000) * (Math.max(0, F.srh3[k]) / 50) * (shr6 < 10 ? 0 : Math.min(1, shr6 / 20));
  }
  return out;
}

/**
 * A day's features at the points (Float32Array, points × HRRR_FEATURES), from `run`'s
 * forecast hours f0+1 … f0+24 (the day's first hour's end to its last), or null when the
 * run lacks them. `hoods` from neighbourhoods(points).
 */
export async function hrrrDay(run, f0, hoods) {
  const hours = Array.from({ length: 24 }, (_, k) => f0 + 1 + k);
  const highs = STORM.map(() => new Float32Array(NP).fill(-Infinity));
  // Hour by hour (four at once), each field's highest kept.
  let missing = 0;
  for (let h = 0; h < hours.length; h += 4) {
    await Promise.all(hours.slice(h, h + 4).map(async (f) => {
      const got = await Promise.all(STORM.map(([, what, , time = /hour max fcst/]) => field(run, f, what, time)));
      if (!got[0]) { missing++; return; }
      got.forEach((a, s) => {
        if (!a) return;
        const hi = highs[s];
        for (let k = 0; k < NP; k++) if (a[k] > hi[k]) hi[k] = a[k];
      });
    }));
  }
  if (missing > 2) return null;
  // The run's total so far ("0-N hour acc", "0-1 day acc" at 24 h).
  const total = /:0-\d+ (hour|day) acc/;
  const [rain, A, B] = await Promise.all([field(run, f0 + 24, 'APCP:surface', total), snapshot(run, f0 + 9), snapshot(run, f0 + 15)]);
  if (!A || !B) return null;
  // Rain over the day: the run's total at the day's end less that at its start.
  let rain24 = rain;
  if (rain && f0 > 0) {
    const before = await field(run, f0, 'APCP:surface', total);
    if (before) { rain24 = new Float32Array(NP); for (let k = 0; k < NP; k++) rain24[k] = rain[k] - before[k]; }
  }
  const NF = HRRR_FEATURES.length;
  const out = new Float32Array(hoods.length * NF).fill(NaN);
  const stat = (arr, idx, kind, mark) => {
    if (!idx.length) return NaN;
    let m = -Infinity; let s = 0; let n = 0;
    for (let q = 0; q < idx.length; q++) {
      const v = arr[idx[q]];
      if (!Number.isFinite(v)) continue;
      if (kind === 'max') { if (v > m) m = v; } else if (kind === 'mean') { s += v; n++; } else { n++; if (v >= mark) s++; }
    }
    return kind === 'max' ? (m === -Infinity ? NaN : m) : n ? s / n : NaN;
  };
  for (let p = 0; p < hoods.length; p++) {
    const { r20, r40, r100 } = hoods[p];
    if (!r20.length) continue;
    const row = [];
    STORM.forEach(([, , mark], s) => { row.push(stat(highs[s], r40, 'max')); if (mark != null) row.push(stat(highs[s], r40, 'cov', mark)); });
    row.push(stat(highs[0], r100, 'max'), stat(highs[2], r100, 'max'));
    row.push(rain24 ? stat(rain24, r40, 'max') : NaN, rain24 ? stat(rain24, r40, 'mean') : NaN);
    for (const S of [A, B]) {
      for (const f of SNAP) row.push(stat(S[f], r20, 'mean'));
      for (const f of SNAP_MAX) row.push(stat(S[f], r40, 'max'));
    }
    out.set(row, p * NF);
  }
  return out;
}
