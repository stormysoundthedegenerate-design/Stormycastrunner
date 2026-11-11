// REFS, NOAA's storm-scale ensemble (the RRFS ensemble that replaced HREF in November 2026),
// for Stormycast: a member's day as features at given points, like hrrr.mjs does for HRRR.
// Members m001–m005 on NOMADS (00Z and 06Z runs, to 60 h, the last two days only), on HRRR's
// 3 km grid (so hrrr.mjs' neighbourhoods serve), with a slimmer set of fields than RRFS
// itself: no hail or 1 km reflectivity, surface CAPE only — but its downdrafts too.
//
// The storm, each pixel's highest over the day's 24 hourly files, over 40 km round a point
// (100 km for helicity) and the share past a mark: updraft helicity 2–5 and 0–3 km, updraft,
// downdraft, 10 m wind, lightning, composite reflectivity; the day's rain. The air at 9 and
// 15 hours into the day, averaged over 20 km (a few as highs over 40 km). Neighbouring
// fields come in one request each, and requests are spaced as NOMADS asks.

import { decodeMessage } from '../../public/js/core/grib2.mjs';

const BASE = 'https://nomads.ncep.noaa.gov/pub/data/nccf/com/rrfs/prod';
export const REFS_MEMBERS = ['m001', 'm002', 'm003', 'm004', 'm005'];
const pad = (n, k = 2) => String(n).padStart(k, '0');

let bytes = 0;
export const refsFetched = () => bytes;
let nextAt = 0;
async function get(url, range = null, text = false) {
  let last;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = nextAt - Date.now();
    nextAt = Math.max(Date.now(), nextAt) + 700;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const headers = { 'user-agent': 'Stormycast REFS archive (paced, once a day)' };
      if (range) headers.Range = `bytes=${range[0]}-${range[1] - 1}`;
      const r = await fetch(url, { headers, signal: AbortSignal.timeout(90000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`REFS ${r.status}`);
      if (text) return r.text();
      const b = new Uint8Array(await r.arrayBuffer());
      bytes += b.length;
      return b;
    } catch (err) { last = err; await new Promise((res) => setTimeout(res, 3000 * (attempt + 1))); }
  }
  throw last;
}

const urlOf = (run, member, f) => {
  const d = new Date(run);
  const hh = pad(d.getUTCHours());
  return `${BASE}/rrfsens.${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}/${hh}/${member}/rrfs.t${hh}z.${member}.2dfldnomads.3km.f${pad(f, 3)}.conus.grib2`;
};
async function indexOf(url) {
  const t = await get(`${url}.idx`, null, true);
  if (!t) return null;
  const lines = t.trim().split('\n').map((l) => l.split(':'));
  return lines.map((l, k) => ({ name: `${l[3]}:${l[4]}`, time: l[5], start: +l[1], end: k + 1 < lines.length ? +lines[k + 1][1] : null }));
}
/** Whether a member's forecast hour is out. */
export async function refsHas(run, member, f) { return !!(await get(`${urlOf(run, member, f)}.idx`, null, true)); }

/**
 * Several fields of one file: wants [{ key, name: 'VAR:level', time: RegExp|null }] → { key:
 * values } (missing ones left out). Messages next to each other in the file come in one request.
 */
async function fields(url, wants) {
  const idx = await indexOf(url);
  if (!idx) return null;
  const found = [];
  for (const w of wants) {
    const e = idx.find((x) => x.name === w.name && (!w.time || w.time.test(x.time)));
    if (e && e.end != null) found.push({ ...e, key: w.key });
  }
  found.sort((a, b) => a.start - b.start);
  const groups = [];
  for (const e of found) {
    const g = groups.at(-1);
    // Neighbours, or nearly (a few small messages between are cheaper than another request).
    if (g && e.start - g.end <= 2e6) { g.end = Math.max(g.end, e.end); g.items.push(e); } else groups.push({ start: e.start, end: e.end, items: [e] });
  }
  const out = {};
  for (const g of groups) {
    const b = await get(url, [g.start, g.end]);
    if (!b) continue;
    for (const e of g.items) out[e.key] = decodeMessage(b.subarray(e.start - g.start, e.end - g.start)).values;
  }
  return out;
}

const HOURLY = [
  { key: 'refc', name: 'REFC:entire atmosphere (considered as a single layer)', time: /hour fcst$/ },
  { key: 'uvv', name: 'MAXUVV:100-1000 mb', time: /max/ },
  { key: 'dvv', name: 'MAXDVV:100-1000 mb', time: /max/ },
  { key: 'uh25', name: 'MXUPHL:5000-2000 m above ground', time: /max/ },
  { key: 'uh03', name: 'MXUPHL:3000-0 m above ground', time: /max/ },
  { key: 'ltng', name: 'LTNG:entire atmosphere', time: /max/ },
  { key: 'wind10', name: 'WIND:10 m above ground', time: /max/ },
];
const AIR = [
  { key: 'cape', name: 'CAPE:surface' }, { key: 'cin', name: 'CIN:surface' },
  { key: 'pwat', name: 'PWAT:entire atmosphere (considered as a single layer)' },
  { key: 'srh1', name: 'HLCY:1000-0 m above ground' }, { key: 'srh3', name: 'HLCY:3000-0 m above ground' },
  { key: 'u1', name: 'VUCSH:0-1000 m above ground' }, { key: 'v1', name: 'VVCSH:0-1000 m above ground' },
  { key: 'u6', name: 'VUCSH:0-6000 m above ground' }, { key: 'v6', name: 'VVCSH:0-6000 m above ground' },
  { key: 't2', name: 'TMP:2 m above ground' }, { key: 'td2', name: 'DPT:2 m above ground' },
].map((w) => ({ ...w, time: /^\d+ hour fcst$/ }));

// The storm fields' highs (dvv: the strongest downdraft, as a positive speed) and marks for shares.
const STORM = [['uh25', 25], ['uh03', 25], ['uvv', null], ['dvv', null], ['wind10', 25], ['ltng', null], ['refc', 40]];
const SNAP = ['sbcape', 'sbcin', 'srh1', 'srh3', 'shr1', 'shr6', 'pwat', 't2', 'td2', 'stp'];
const SNAP_MAX = ['sbcape', 'srh1', 'stp'];
export const REFS_FEATURES = [
  ...STORM.flatMap(([n, mark]) => [`${n}_max`, ...(mark != null ? [`${n}_cov`] : [])]), 'uh25_max100', 'rain_max', 'rain_mean',
  ...['a', 'b'].flatMap((s) => [...SNAP.map((f) => `${s}_${f}`), ...SNAP_MAX.map((f) => `${s}_${f}_max40`)]),
];

function air(F) {
  const n = F.cape.length;
  const out = Object.fromEntries(SNAP.map((k) => [k, new Float32Array(n)]));
  for (let k = 0; k < n; k++) {
    const shr6 = Math.hypot(F.u6[k], F.v6[k]);
    const lcl = Math.max(0, 125 * (F.t2[k] - F.td2[k]));
    const lclT = lcl < 1000 ? 1 : lcl > 2000 ? 0 : (2000 - lcl) / 1000;
    const shrT = shr6 < 12.5 ? 0 : Math.min(1.5, shr6 / 20);
    const cinT = F.cin[k] > -50 ? 1 : F.cin[k] < -200 ? 0 : (200 + F.cin[k]) / 150;
    out.sbcape[k] = F.cape[k]; out.sbcin[k] = F.cin[k]; out.srh1[k] = F.srh1[k]; out.srh3[k] = F.srh3[k];
    out.shr1[k] = Math.hypot(F.u1[k], F.v1[k]); out.shr6[k] = shr6; out.pwat[k] = F.pwat[k];
    out.t2[k] = F.t2[k] - 273.15; out.td2[k] = F.td2[k] - 273.15;
    out.stp[k] = (F.cape[k] / 1500) * lclT * (Math.max(0, F.srh1[k]) / 150) * shrT * cinT;
  }
  return out;
}

/**
 * A member's day at the points: Float32Array(points × REFS_FEATURES), from forecast hours
 * f0+1 … f0+24 of `run`, or null when the run lacks them. `hoods` from hrrr.mjs neighbourhoods.
 */
export async function refsDay(run, member, f0, hoods) {
  let highs = null;
  let missing = 0;
  for (let f = f0 + 1; f <= f0 + 24; f++) {
    const got = await fields(urlOf(run, member, f), HOURLY);
    if (!got || !got.uh25) { missing++; continue; }
    highs ||= Object.fromEntries(STORM.map(([k]) => [k, new Float32Array(got.uh25.length).fill(-Infinity)]));
    for (const [k] of STORM) {
      const a = got[k];
      if (!a) continue;
      const h = highs[k];
      if (k === 'dvv') { for (let p = 0; p < a.length; p++) if (-a[p] > h[p]) h[p] = -a[p]; } else for (let p = 0; p < a.length; p++) if (a[p] > h[p]) h[p] = a[p];
    }
  }
  if (!highs || missing > 2) return null;
  const total = /^0-\d+ (hour|day) acc/;
  const [r1, r0, A, B] = await Promise.all([
    fields(urlOf(run, member, f0 + 24), [{ key: 'r', name: 'APCP:surface', time: total }]),
    f0 > 0 ? fields(urlOf(run, member, f0), [{ key: 'r', name: 'APCP:surface', time: total }]) : null,
    fields(urlOf(run, member, f0 + 9), AIR), fields(urlOf(run, member, f0 + 15), AIR),
  ]);
  if (!A || !B || AIR.some((w) => !A[w.key] || !B[w.key])) return null;
  let rain = r1?.r || null;
  if (rain && r0?.r) { const d = new Float32Array(rain.length); for (let p = 0; p < d.length; p++) d[p] = rain[p] - r0.r[p]; rain = d; }
  const SA = air(A); const SB = air(B);
  const NF = REFS_FEATURES.length;
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
    for (const [k, mark] of STORM) { row.push(stat(highs[k], r40, 'max')); if (mark != null) row.push(stat(highs[k], r40, 'cov', mark)); }
    row.push(stat(highs.uh25, r100, 'max'));
    row.push(rain ? stat(rain, r40, 'max') : NaN, rain ? stat(rain, r40, 'mean') : NaN);
    for (const S of [SA, SB]) {
      for (const f of SNAP) row.push(stat(S[f], r20, 'mean'));
      for (const f of SNAP_MAX) row.push(stat(S[f], r40, 'max'));
    }
    out.set(row, p * NF);
  }
  return out;
}
