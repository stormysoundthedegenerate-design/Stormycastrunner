// NOAA's GEFSv12 reforecast (2000–2019, the 00Z run every day, members c00 and p01–p04,
// 0.25° to day 10: AWS noaa-gefs-retrospective) read in ERA5's shape — the same field
// names and rows as era5.mjs' rows() and ifs.mjs' ifsRows() (rows from 90°N × 1440 columns
// from 0°E) — so snapshot.mjs works out the very same inputs from any member of it. One
// file a variable (all its levels and hours), with a .idx giving each message's bytes.
//
// Derived: 2 m dewpoint (from 2 m specific humidity and surface pressure); total and
// convective rain as the run's total to that hour in metres (as ECMWF and ERA5 give it),
// summed from GEFS's buckets (0–3, 0–6, 6–9, 6–12, ... hours).
//
// Also GEFS's own fields, for inputs of their own: surface CAPE and CIN, 0–3 km helicity,
// precipitable water, boundary-layer height and the surface gust.

import { decodeMessage } from '../../public/js/core/grib2.mjs';

const BASE = 'https://noaa-gefs-retrospective.s3.amazonaws.com/GEFSv12/reforecast';
const H = 3600e3;
const pad = (n) => String(n).padStart(2, '0');
export const GEFS_MEMBERS = ['c00', 'p01', 'p02', 'p03', 'p04'];

// field name -> [file (by level for pressure fields), GRIB name, level text]
const SFC = {
  surface_pressure: ['pres_sfc', 'PRES', 'surface'],
  '2m_temperature': ['tmp_2m', 'TMP', '2 m above ground'],
  '2m_specific_humidity': ['spfh_2m', 'SPFH', '2 m above ground'],
  '10m_u_component_of_wind': ['ugrd_hgt', 'UGRD', '10 m above ground'],
  '10m_v_component_of_wind': ['vgrd_hgt', 'VGRD', '10 m above ground'],
  gefs_cape: ['cape_sfc', 'CAPE', 'surface'],
  gefs_cin: ['cin_sfc', 'CIN', 'surface'],
  gefs_hlcy: ['hlcy_hgt', 'HLCY', '3000-0 m above ground'],
  gefs_pwat: ['pwat_eatm', 'PWAT', 'entire atmosphere (considered as a single layer)'],
  gefs_hpbl: ['pbl_hgt', 'HPBL', 'surface'],
  gefs_gust: ['gust_sfc', 'GUST', 'surface'],
};
const PL = { temperature: ['tmp', 'TMP'], specific_humidity: ['spfh', 'SPFH'], u_component_of_wind: ['ugrd', 'UGRD'], v_component_of_wind: ['vgrd', 'VGRD'] };
const RAIN = { total_precipitation: ['apcp_sfc', 'APCP'], convective_precipitation: ['acpcp_sfc', 'ACPCP'] };

let active = 0;
const waiting = [];
let bytes = 0;
export const gefsFetched = () => bytes;
async function slot(fn) {
  while (active >= 24) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
async function get(url, range, text = false) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await slot(async () => {
        const r = await fetch(url, { headers: range ? { Range: `bytes=${range[0]}-${range[1] == null ? '' : range[1] - 1}` } : {}, signal: AbortSignal.timeout(120000) });
        if (r.status === 404 || r.status === 403) return null;
        if (!r.ok) throw new Error(`GEFS ${r.status}`);
        if (text) return r.text();
        const b = new Uint8Array(await r.arrayBuffer());
        bytes += b.length;
        return b;
      });
    } catch (err) { last = err; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
  }
  throw last;
}

const fileUrl = (run, member, file) => {
  const d = new Date(run);
  const ymdh = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00`;
  return `${BASE}/${d.getUTCFullYear()}/${ymdh}/${member}/Days%3A1-10/${file}_${ymdh}_${member}.grib2`;
};
const indexes = new Map();
/** A file's messages: [{ offset, end, name, level, fcst }]. */
function indexOf(run, member, file) {
  const key = `${run}:${member}:${file}`;
  if (!indexes.has(key)) {
    indexes.set(key, get(`${fileUrl(run, member, file)}.idx`, null, true).then((t) => {
      if (!t) return null;
      const lines = t.trim().split('\n').map((l) => l.split(':'));
      return lines.map((f, i) => ({ offset: +f[1], end: i + 1 < lines.length ? +lines[i + 1][1] : null, name: f[3], level: f[4], fcst: f[5] }));
    }));
    if (indexes.size > 400) indexes.delete(indexes.keys().next().value);
  }
  return indexes.get(key);
}

async function message(run, member, file, name, level, fcst) {
  const idx = await indexOf(run, member, file);
  const e = idx?.find((m) => m.name === name && m.level === level && m.fcst === fcst);
  if (!e) return null;
  const b = await get(fileUrl(run, member, file), [e.offset, e.end]);
  return b ? decodeMessage(b) : null;
}

/**
 * A decoded global field's rows r0..r1 in ERA5's shape (0.25°). The fields above 700 hPa
 * come at 0.5°: each 0.25° point takes the nearest of them.
 */
function rowsOf({ grid, values }, r0, r1) {
  if (grid.kind !== 'latlon' || Math.abs(grid.nx * grid.dx - 360) > 1e-3) throw new Error('GEFS grid not global latitude/longitude');
  const out = new Float32Array((r1 - r0 + 1) * 1440);
  const { nx, dx, dy, la1, lo1, ny } = grid;
  const cols = new Int32Array(1440);
  for (let c = 0; c < 1440; c++) cols[c] = ((Math.round((c * 0.25 - lo1) / dx) % nx) + nx) % nx;
  for (let r = r0; r <= r1; r++) {
    const src = Math.min(ny - 1, Math.max(0, Math.round((la1 - (90 - r * 0.25)) / dy))) * nx;
    for (let c = 0; c < 1440; c++) out[(r - r0) * 1440 + c] = values[src + cols[c]];
  }
  return out;
}

/**
 * As era5.mjs' rows(): a field's rows r0..r1 at `hour` from the 00Z run `run` (ms) of
 * `member`, or null where the reforecast has none.
 */
export async function gefsRows(field, hour, level, r0, r1, run, member = 'c00') {
  const fh = Math.round((hour - run) / H);
  if (fh < 0 || fh > 240 || fh % 3) return null;
  if (field === '2m_dewpoint_temperature') {
    const [q, p] = await Promise.all([gefsRows('2m_specific_humidity', hour, null, r0, r1, run, member), gefsRows('surface_pressure', hour, null, r0, r1, run, member)]);
    if (!q || !p) return null;
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) {
      const e = Math.max(1e-6, (q[i] * p[i] / 100) / (0.622 + 0.378 * q[i]));
      const l = Math.log(e / 6.112);
      out[i] = (243.5 * l) / (17.67 - l) + 273.15;
    }
    return out;
  }
  if (RAIN[field]) {
    // The run's total to fh: the 6-hour buckets, then a 3-hour one if fh is not on a 6.
    const [file, name] = RAIN[field];
    const parts = [];
    for (let h = 0; h + 6 <= fh; h += 6) parts.push(`${h}-${h + 6} hour acc fcst`);
    if (fh % 6) parts.push(`${fh - 3}-${fh} hour acc fcst`);
    if (!parts.length) return new Float32Array((r1 - r0 + 1) * 1440);
    const recs = await Promise.all(parts.map((f) => message(run, member, file, name, 'surface', f)));
    if (recs.some((r) => !r)) return null;
    const out = new Float32Array((r1 - r0 + 1) * 1440);
    for (const rec of recs) { const a = rowsOf(rec, r0, r1); for (let i = 0; i < out.length; i++) out[i] += a[i] / 1000; }
    return out;
  }
  const fcst = `${fh} hour fcst`;
  if (SFC[field]) {
    const [file, name, lev] = SFC[field];
    const rec = await message(run, member, file, name, lev, fcst);
    return rec ? rowsOf(rec, r0, r1) : null;
  }
  if (PL[field]) {
    const [stem, name] = PL[field];
    const file = level >= 800 ? `${stem}_pres` : `${stem}_pres_abv700mb`;
    const rec = await message(run, member, file, name, `${level} mb`, fcst);
    return rec ? rowsOf(rec, r0, r1) : null;
  }
  throw new Error(`no GEFS field for ${field}`);
}

// --- the live ensemble ---------------------------------------------------------------------------
// GEFS as it runs now (the same GEFSv12, 31 members gec00 and gep01–gep30, AWS noaa-gefs-pds),
// in the same shape and field names as gefsRows: one file a step, its fields in two halves
// (pgrb2a and pgrb2b, 0.5°). Temperature at 300 hPa and all specific humidity are in the b half.

const OPS = 'https://noaa-gefs-pds.s3.amazonaws.com';
export const GEFS_OPS_MEMBERS = ['gec00', ...Array.from({ length: 30 }, (_, k) => `gep${pad(k + 1)}`)];
const OPS_SFC = {
  surface_pressure: ['a', 'PRES', 'surface'],
  '2m_temperature': ['a', 'TMP', '2 m above ground'],
  '2m_specific_humidity': ['b', 'SPFH', '2 m above ground'],
  '10m_u_component_of_wind': ['a', 'UGRD', '10 m above ground'],
  '10m_v_component_of_wind': ['a', 'VGRD', '10 m above ground'],
  gefs_cape: ['b', 'CAPE', 'surface'],
  gefs_cin: ['b', 'CIN', 'surface'],
  gefs_hlcy: ['b', 'HLCY', '3000-0 m above ground'],
  gefs_pwat: ['a', 'PWAT', 'entire atmosphere (considered as a single layer)'],
  gefs_hpbl: ['b', 'HPBL', 'surface'],
  gefs_gust: ['b', 'GUST', 'surface'],
};
const OPS_RAIN = { total_precipitation: ['a', 'APCP'], convective_precipitation: ['b', 'ACPCP'] };
const opsUrl = (run, member, half, fh) => {
  const d = new Date(run);
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hh = pad(d.getUTCHours());
  return `${OPS}/gefs.${ymd}/${hh}/atmos/pgrb2${half}p5/${member}.t${hh}z.pgrb2${half}.0p50.f${String(fh).padStart(3, '0')}`;
};
function opsIndex(url) {
  if (!indexes.has(url)) {
    indexes.set(url, get(`${url}.idx`, null, true).then((t) => {
      if (!t) return null;
      const lines = t.trim().split('\n').map((l) => l.split(':'));
      return lines.map((f, i) => ({ offset: +f[1], end: i + 1 < lines.length ? +lines[i + 1][1] : null, name: f[3], level: f[4], fcst: f[5] }));
    }));
    if (indexes.size > 400) indexes.delete(indexes.keys().next().value);
  }
  return indexes.get(url);
}
async function opsMessage(run, member, half, fh, name, level, fcst) {
  const url = opsUrl(run, member, half, fh);
  const idx = await opsIndex(url);
  const e = idx?.find((m) => m.name === name && m.level === level && m.fcst === fcst);
  if (!e) return null;
  const b = await get(url, [e.offset, e.end]);
  return b ? decodeMessage(b) : null;
}

/** Whether a live run's member has its fields out to forecast hour fh (both halves). */
export async function gefsOpsHas(run, member, fh) {
  const [a, b] = await Promise.all(['a', 'b'].map((h) => opsIndex(opsUrl(run, member, h, fh))));
  return !!(a && b);
}

/**
 * The daily runner's GEFS reader: a field at forecast hour fh of the live run `run` of
 * `member`, on the runner's grid (0.5°, 720 × 361, rows from 90°N, columns from 180°W —
 * GEFS's own 0.5° points, only reordered), in the units gefsOpsRows gives; null if missing.
 * Rain (total_precipitation, convective_precipitation) is the run's total to fh in metres,
 * its buckets each fetched once (`cache`, a Map kept per member and run).
 */
export async function gefsOpsGrid(field, fh, level, run, member, cache = new Map()) {
  const NXR = 720;
  const NYR = 361;
  const reorder = ({ grid, values }) => {
    const out = new Float32Array(NXR * NYR);
    const { nx, dx, dy, la1, lo1, ny } = grid;
    for (let j = 0; j < NYR; j++) {
      const r = Math.min(ny - 1, Math.max(0, Math.round((la1 - (90 - j * 0.5)) / dy))) * nx;
      for (let i = 0; i < NXR; i++) out[j * NXR + i] = values[r + (((Math.round(((-180 + i * 0.5) - lo1) / dx) % nx) + nx) % nx)];
    }
    return out;
  };
  if (fh < 0 || fh % 3) return null;
  if (field === '2m_dewpoint_temperature') {
    const [q, p] = await Promise.all([gefsOpsGrid('2m_specific_humidity', fh, null, run, member, cache), gefsOpsGrid('surface_pressure', fh, null, run, member, cache)]);
    if (!q || !p) return null;
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) {
      const e = Math.max(1e-6, (q[i] * p[i] / 100) / (0.622 + 0.378 * q[i]));
      const l = Math.log(e / 6.112);
      out[i] = (243.5 * l) / (17.67 - l) + 273.15;
    }
    return out;
  }
  if (OPS_RAIN[field]) {
    const [half, name] = OPS_RAIN[field];
    const parts = [];
    for (let h = 0; h + 6 <= fh; h += 6) parts.push([h + 6, `${h}-${h + 6} hour acc fcst`]);
    if (fh % 6) parts.push([fh, `${fh - 3}-${fh} hour acc fcst`]);
    const out = new Float32Array(NXR * NYR);
    const bucks = await Promise.all(parts.map(([f, text]) => {
      const key = `${name}:${f}:${text}`;
      if (!cache.has(key)) {
        cache.set(key, opsMessage(run, member, half, f, name, 'surface', text).then((rec) => (rec ? reorder(rec) : null)));
      }
      return cache.get(key);
    }));
    if (bucks.some((b) => !b)) return null;
    for (const b of bucks) for (let i = 0; i < out.length; i++) out[i] += b[i] / 1000;
    return out;
  }
  const fcst = fh === 0 ? 'anl' : `${fh} hour fcst`;
  if (OPS_SFC[field]) {
    const [half, name, lev] = OPS_SFC[field];
    const rec = await opsMessage(run, member, half, fh, name, lev, fcst);
    return rec ? reorder(rec) : null;
  }
  if (PL[field]) {
    const name = PL[field][1];
    const half = name === 'SPFH' || (name === 'TMP' && level === 300) ? 'b' : 'a';
    const rec = await opsMessage(run, member, half, fh, name, `${level} mb`, fcst);
    return rec ? reorder(rec) : null;
  }
  throw new Error(`no GEFS field for ${field}`);
}

/** As gefsRows, from the live GEFS run `run` (00/06/12/18Z, ms) of `member` (gec00, gep01…). */
export async function gefsOpsRows(field, hour, level, r0, r1, run, member = 'gec00') {
  const fh = Math.round((hour - run) / H);
  if (fh < 0 || fh > 384 || fh % 3) return null;
  if (field === '2m_dewpoint_temperature') {
    const [q, p] = await Promise.all([gefsOpsRows('2m_specific_humidity', hour, null, r0, r1, run, member), gefsOpsRows('surface_pressure', hour, null, r0, r1, run, member)]);
    if (!q || !p) return null;
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) {
      const e = Math.max(1e-6, (q[i] * p[i] / 100) / (0.622 + 0.378 * q[i]));
      const l = Math.log(e / 6.112);
      out[i] = (243.5 * l) / (17.67 - l) + 273.15;
    }
    return out;
  }
  if (OPS_RAIN[field]) {
    const [half, name] = OPS_RAIN[field];
    const parts = [];
    for (let h = 0; h + 6 <= fh; h += 6) parts.push([h + 6, `${h}-${h + 6} hour acc fcst`]);
    if (fh % 6) parts.push([fh, `${fh - 3}-${fh} hour acc fcst`]);
    if (!parts.length) return new Float32Array((r1 - r0 + 1) * 1440);
    const recs = await Promise.all(parts.map(([f, text]) => opsMessage(run, member, half, f, name, 'surface', text)));
    if (recs.some((r) => !r)) return null;
    const out = new Float32Array((r1 - r0 + 1) * 1440);
    for (const rec of recs) { const a = rowsOf(rec, r0, r1); for (let i = 0; i < out.length; i++) out[i] += a[i] / 1000; }
    return out;
  }
  const fcst = fh === 0 ? 'anl' : `${fh} hour fcst`;
  if (OPS_SFC[field]) {
    const [half, name, lev] = OPS_SFC[field];
    const rec = await opsMessage(run, member, half, fh, name, lev, fcst);
    return rec ? rowsOf(rec, r0, r1) : null;
  }
  if (PL[field]) {
    const name = PL[field][1];
    const half = name === 'SPFH' || (name === 'TMP' && level === 300) ? 'b' : 'a';
    const rec = await opsMessage(run, member, half, fh, name, `${level} mb`, fcst);
    return rec ? rowsOf(rec, r0, r1) : null;
  }
  throw new Error(`no GEFS field for ${field}`);
}
