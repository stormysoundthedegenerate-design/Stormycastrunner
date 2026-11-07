// Runs Stormycast on ECMWF's newest open forecast (IFS, 0.25°) and makes the days it
// publishes: for each 0.5° point of the globe and each of three days, the chance of each
// hazard within 40 km (public/js/core/stormycast.mjs reads them).
//
// A "day" is each place's own: 06:00 to 06:00 by the sun. The models were taught on ERA5 at
// 21Z and 03Z over the US — mid-afternoon and evening there — so each point is given the
// forecast step nearest 14:40 by its sun and the one six hours after, and the rain of
// its day. A 00Z run gives the run's date and the two after; a 12Z run the three
// after its date. Surface height and land come from ERA5 (kept in site-data/stormycast).
//
//   node scripts/stormycast-run.mjs [YYYYMMDDHH] [--deploy]
//
// Writes site-data/stormycast/site/<date>-<run>.bin.gz (uint8 percent, hazard by hazard,
// rows from 90°N, columns from 180°W) and latest.json; --deploy sends site/ as the
// `stormycast` branch of the nexradar Pages project (apart from the app's own deployment).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessage } from '../public/js/core/grib2.mjs';
import { environment, ENV_FEATURES, OUTLOOK_LEVELS, WIND_LEVELS } from '../public/js/core/severe-env.mjs';
import { chanceOf, mapValue, STORMYCAST_HAZARDS } from '../public/js/core/stormycast.mjs';
import { rows as era5Rows } from './stormycast/era5.mjs';
import { hrrrDay, hrrrHas, neighbourhoods } from './stormycast/hrrr.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DIR = join(root, 'site-data/stormycast');
const SITE = join(DIR, 'site');
mkdirSync(SITE, { recursive: true });
const { STORMYCAST_MODEL } = await import('../public/js/core/stormycast-model.mjs');
const FEATURES = STORMYCAST_MODEL.features;
const NB = ['mucape', 'scp', 'stp', 'shr6', 'srh1'];

const MIRRORS = ['https://storage.googleapis.com/ecmwf-open-data', 'https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com'];
const NX = 720;
const NY = 361;
const NP = NX * NY;
const latOf = (j) => 90 - j * 0.5;
const lonOf = (i) => -180 + i * 0.5;
const pad = (n) => String(n).padStart(2, '0');
const H = 3600e3;

// --- fetching ------------------------------------------------------------------------------
let active = 0;
const waiting = [];
async function slot(fn) {
  while (active >= 16) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
async function get(path, range, as = 'bytes') {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const base = MIRRORS[attempt % MIRRORS.length];
    try {
      return await slot(async () => {
        const r = await fetch(`${base}/${path}`, { headers: range ? { Range: `bytes=${range[0]}-${range[1] - 1}` } : {}, signal: AbortSignal.timeout(90000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`ECMWF ${r.status}`);
        return as === 'text' ? r.text() : new Uint8Array(await r.arrayBuffer());
      });
    } catch (err) { last = err; await new Promise((res) => setTimeout(res, 1500 * (attempt + 1))); }
  }
  throw last;
}
const runPath = (run, step) => {
  const d = new Date(run);
  const ymd = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  const hh = pad(d.getUTCHours());
  return `${ymd}/${hh}z/ifs/0p25/oper/${ymd}${hh}0000-${step}h-oper-fc`;
};
const indexes = new Map();
function indexOf(run, step) {
  const key = `${run}:${step}`;
  if (!indexes.has(key)) {
    indexes.set(key, get(`${runPath(run, step)}.index`, null, 'text').then((t) => (t ? t.trim().split('\n').map((l) => JSON.parse(l)) : null)));
  }
  return indexes.get(key);
}

/** A field at a step, on the 0.5° grid (rows from 90°N, columns from 180°W). */
async function field(run, step, param, level = null) {
  const idx = await indexOf(run, step);
  if (!idx) throw new Error(`no step ${step}`);
  const e = idx.find((x) => x.param === param && (level == null ? x.levtype === 'sfc' : x.levtype === 'pl' && +x.levelist === level));
  if (!e) throw new Error(`no ${param} ${level ?? ''} at step ${step}`);
  const bytes = await get(`${runPath(run, step)}.grib2`, [e._offset, e._offset + e._length]);
  const { grid, values } = decodeMessage(bytes);
  const out = new Float32Array(NP);
  const nxs = grid.nx;
  const d = grid.dx;
  for (let j = 0; j < NY; j++) {
    const r = Math.round((grid.la1 - latOf(j)) / d);
    for (let i = 0; i < NX; i++) {
      const c = Math.round(((((lonOf(i) - grid.lo1) % 360) + 360) % 360) / d) % nxs;
      out[j * NX + i] = values[r * nxs + c];
    }
  }
  return out;
}

// --- ERA5's ground (once) ------------------------------------------------------------------------
async function ground(name, file) {
  const f = join(DIR, file);
  if (existsSync(f)) { const b = readFileSync(f); return new Float32Array(b.buffer, b.byteOffset, NP); }
  const a = await era5Rows(name, Date.UTC(2024, 0, 1), null, 0, 720);
  const out = new Float32Array(NP);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) out[j * NX + i] = a[(j * 2) * 1440 + ((Math.round((lonOf(i) + 360) * 4)) % 1440)];
  writeFileSync(f, Buffer.from(out.buffer));
  return out;
}
const zs = await ground('geopotential_at_surface', 'zs.f32');
const lsm = await ground('land_sea_mask', 'lsm.f32');

// --- the run ------------------------------------------------------------------------------------
async function newestRun() {
  const now = Date.now();
  for (let t = Math.floor(now / (12 * H)) * 12 * H; t > now - 4 * 864e5; t -= 12 * H) {
    // Out when its last step needed is.
    if (await indexOf(t, 102)) return t;
  }
  throw new Error('no ECMWF run found');
}
const given = args.find((a) => /^\d{10}$/.test(a));
const RUN = given ? Date.UTC(+given.slice(0, 4), +given.slice(4, 6) - 1, +given.slice(6, 8), +given.slice(8, 10)) : await newestRun();
const runName = new Date(RUN).toISOString().slice(0, 13).replace(/[-T]/g, '');
const runDate = Math.floor(RUN / 864e5) * 864e5;
const DATES = [0, 1, 2].map((k) => runDate + (new Date(RUN).getUTCHours() === 0 ? k : k + 1) * 864e5);
console.log('run', runName, 'days', DATES.map((d) => new Date(d).toISOString().slice(0, 10)).join(' '));

// Each point's steps, day by day.
const near3 = (t) => Math.max(0, Math.round((t - RUN) / (3 * H)) * 3);
const plan = DATES.map((D) => {
  const a = new Int16Array(NX);
  const s = new Int16Array(NX);
  const e = new Int16Array(NX);
  for (let i = 0; i < NX; i++) {
    const start = D + (6 - lonOf(i) / 15) * H;
    a[i] = near3(start + 8.7 * H);
    s[i] = near3(start);
    e[i] = near3(start + 24 * H);
  }
  return { D, a, s, e };
});
// The four snapshots of each point's day, as offsets from its afternoon step: a (≈14:40),
// b (6 h on), m (6 h before: the morning) and n (12 h on: the small hours) — the same
// spacing the models learnt from (21Z, 03Z, 15Z and 09Z over the US).
const SNAP_OFF = { a: 0, b: 6, m: -6, n: 12 };
const SNAPS = FEATURES.some((f) => f.startsWith('m_')) ? ['a', 'b', 'm', 'n'] : ['a', 'b'];
const stepOf = (p, i, w) => Math.max(0, p.a[i] + SNAP_OFF[w]);
const snapSteps = new Set();
const rainSteps = new Set();
for (const p of plan) for (let i = 0; i < NX; i++) { for (const w of SNAPS) snapSteps.add(stepOf(p, i, w)); rainSteps.add(p.s[i]); rainSteps.add(p.e[i]); }

// Environments: for each day, each snapshot's features per point.
const NE = ENV_FEATURES.length;
const env = plan.map(() => Object.fromEntries(SNAPS.map((w) => [w, new Float32Array(NP * NE).fill(NaN)])));
const t0 = Date.now();
for (const step of [...snapSteps].sort((x, y) => x - y)) {
  const F = {};
  const jobs = [['sp', 'sp'], ['t2', '2t'], ['d2', '2d'], ['u10', '10u'], ['v10', '10v']].map(async ([k, p]) => { F[k] = await field(RUN, step, p); });
  for (const p of OUTLOOK_LEVELS) jobs.push(field(RUN, step, 't', p).then((a) => { F[`t${p}`] = a; }));
  for (const p of WIND_LEVELS) for (const k of ['q', 'u', 'v']) jobs.push(field(RUN, step, k, p).then((a) => { F[k + p] = a; }));
  await Promise.all(jobs);
  let n = 0;
  for (let d = 0; d < plan.length; d++) {
    for (const w of SNAPS) {
      const out = env[d][w];
      for (let i = 0; i < NX; i++) {
        if (stepOf(plan[d], i, w) !== step) continue;
        for (let j = 0; j < NY; j++) {
          const k = j * NX + i;
          // Sea far from land is left out (the models know only land).
          const c = { ps: F.sp[k] / 100, zs: zs[k] / 9.80665, t2: F.t2[k], d2: F.d2[k], u10: F.u10[k], v10: F.v10[k], t: {}, q: {}, u: {}, v: {}, lat: latOf(j) };
          for (const p of OUTLOOK_LEVELS) c.t[p] = F[`t${p}`][k];
          for (const p of WIND_LEVELS) { c.q[p] = F[`q${p}`][k]; c.u[p] = F[`u${p}`][k]; c.v[p] = F[`v${p}`][k]; }
          const e = environment(c);
          if (!e) continue;
          for (let f = 0; f < NE; f++) out[k * NE + f] = e[ENV_FEATURES[f]];
          n++;
        }
      }
    }
  }
  console.log(`step ${step}: ${n} environments (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const rain = new Map();
await Promise.all([...rainSteps].map(async (s) => { rain.set(s, s === 0 ? new Float32Array(NP) : await field(RUN, s, 'tp')); }));

// Land, or within a cell of it.
const nearLand = new Uint8Array(NP);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  let m = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const jj = Math.min(NY - 1, Math.max(0, j + dj));
    const ii = (i + di + NX) % NX;
    m = Math.max(m, lsm[jj * NX + ii]);
  }
  nearLand[j * NX + i] = m >= 0.5 ? 1 : 0;
}

const nbMax = (get) => {
  const out = new Float32Array(NP);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    let m = -Infinity;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const jj = j + dj;
      if (jj < 0 || jj >= NY) continue;
      const v = get(jj * NX + ((i + di + NX) % NX));
      if (v > m) m = v;
    }
    out[j * NX + i] = m;
  }
  return out;
};

const models = STORMYCAST_HAZARDS.map((h) => STORMYCAST_MODEL.models[h]);
const maps = FEATURES.map((f) => STORMYCAST_MODEL.maps?.[f]);
// Over the US, HRRR's own model (stormycast-hrrr-model.mjs) where a run covers the day,
// faded into ECMWF's over HRRR's last ~100 km.
let HRRR_MODEL = null;
if (!args.includes('--no-hrrr')) {
  try { HRRR_MODEL = (await import('../public/js/core/stormycast-hrrr-model.mjs')).STORMYCAST_HRRR_MODEL; } catch { /* not fitted yet */ }
}
const us = [];
if (HRRR_MODEL) {
  const cand = [];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const lat = latOf(j);
    const lon = lonOf(i);
    if (lat >= 20 && lat <= 55 && lon >= -135 && lon <= -58 && nearLand[j * NX + i]) cand.push({ k: j * NX + i, lat, lon });
  }
  const hoods = neighbourhoods(cand);
  const full = Math.max(...hoods.map((h) => h.r100.length));
  cand.forEach((c, n) => { if (hoods[n].r20.length) us.push({ ...c, hood: hoods[n], w: Math.min(1, Math.max(0, (hoods[n].r100.length / full - 0.6) / 0.3)) }); });
}
// EF2+ tornadoes stay with the ECMWF model over the US too: HRRR's held-back Brier skill for
// them was ~0 (2026-11-07 fit) against ECMWF's 0.04.
const HRRR_SKIP = new Set(['sigtor']);
const hrrrModels = HRRR_MODEL ? STORMYCAST_HAZARDS.map((h) => (HRRR_SKIP.has(h) ? null : HRRR_MODEL.models[h])) : [];
/** The US day (12Z on D to 12Z next) from the newest HRRR run that covers it (48 h runs). */
async function hrrrChances(D) {
  if (!us.length) return null;
  const start = D + 12 * H;
  const newest = Math.min(start, Math.floor(Date.now() / (6 * H)) * 6 * H);
  for (let run = newest; run >= start - 24 * H; run -= 6 * H) {
    const f0 = Math.round((start - run) / H);
    if (!(await hrrrHas(run, f0 + 24))) continue;
    const X = await hrrrDay(run, f0, us.map((p) => p.hood));
    if (!X) continue;
    const NFH = HRRR_MODEL.features.length;
    const out = new Uint8Array(hrrrModels.length * us.length);
    const x = new Float32Array(NFH);
    for (let p = 0; p < us.length; p++) {
      for (let q = 0; q < NFH; q++) x[q] = X[p * NFH + q];
      for (let m = 0; m < hrrrModels.length; m++) if (hrrrModels[m]) out[m * us.length + p] = Math.round(100 * chanceOf(hrrrModels[m], x));
    }
    return { run, f0, out };
  }
  return null;
}

// STORMYCAST_PROBE="lat,lon;lat,lon" prints those points' inputs and chances.
const PROBE = new Map((process.env.STORMYCAST_PROBE || '').split(';').filter(Boolean).map((s) => {
  const [la, lo] = s.split(',').map(Number);
  return [Math.round((90 - la) / 0.5) * NX + Math.round((lo + 180) / 0.5), s];
}));
// Thunder first (as ASTORP does): the chance of lightning within 40 km in the day, from the
// GLM-trained model with its own input maps; no severe chance is let above it (severe
// reports come from thunderstorms), and it is published as its own layer.
const LTG = STORMYCAST_MODEL.models.ltg || null;
const ltgMaps = LTG ? FEATURES.map((f) => LTG.maps?.[f]) : null;
const HAZARDS = LTG ? [...STORMYCAST_HAZARDS, 'thunder'] : STORMYCAST_HAZARDS;
// Where each input comes from: [snapshot, env index] | 'rain' | 'nb_rain' | ['nb', k].
const SOURCE = FEATURES.map((f) => {
  const m = /^([abmn])_(.+)$/.exec(f);
  if (m && ENV_FEATURES.includes(m[2])) return [m[1], ENV_FEATURES.indexOf(m[2])];
  if (f === 'rain' || f === 'nb_rain') return f;
  if (f.startsWith('nb_')) return ['nb', NB.indexOf(f.slice(3))];
  throw new Error(`unknown input ${f}`);
});
const entries = [];
for (let d = 0; d < plan.length; d++) {
  const E = env[d];
  const A = E.a;
  const B = E.b;
  const cp = new Float32Array(NP);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const k = j * NX + i;
    cp[k] = Math.max(0, (rain.get(plan[d].e[i])[k] - rain.get(plan[d].s[i])[k]) * 1000);
  }
  const nbcp = nbMax((k) => cp[k]);
  const nb = NB.map((f) => { const fi = ENV_FEATURES.indexOf(f); return nbMax((k) => { const a = A[k * NE + fi]; const b = B[k * NE + fi]; return Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(b) ? b : -Infinity); }); });
  const out = new Uint8Array(HAZARDS.length * NP);
  const raw = new Float32Array(FEATURES.length);
  const x = new Float32Array(FEATURES.length);
  const xl = new Float32Array(FEATURES.length);
  const t1 = Date.now();
  for (let k = 0; k < NP; k++) {
    if (!nearLand[k] || !Number.isFinite(A[k * NE]) || !Number.isFinite(B[k * NE])) continue;
    for (let f = 0; f < FEATURES.length; f++) {
      const s = SOURCE[f];
      raw[f] = s === 'rain' ? cp[k] : s === 'nb_rain' ? nbcp[k] : s[0] === 'nb' ? nb[s[1]][k] : E[s[0]][k * NE + s[1]];
    }
    // ECMWF's values on ERA5's scale, as the models were taught.
    for (let f = 0; f < FEATURES.length; f++) x[f] = mapValue(maps[f], raw[f]);
    for (let m = 0; m < models.length; m++) if (models[m]) out[m * NP + k] = Math.round(100 * chanceOf(models[m], x));
    if (LTG) {
      for (let f = 0; f < FEATURES.length; f++) xl[f] = mapValue(ltgMaps[f], raw[f]);
      const t = Math.round(100 * chanceOf(LTG, xl));
      out[models.length * NP + k] = t;
      for (let m = 0; m < models.length; m++) if (out[m * NP + k] > t) out[m * NP + k] = t;
    }
    if (PROBE.has(k)) console.log(`probe ${PROBE.get(k)} day ${d}:`, HAZARDS.map((h, m) => `${h} ${out[m * NP + k]}%`).join(' '), '\n ', FEATURES.map((f, i) => `${f}=${+x[i].toFixed(1)}`).join(' '));
  }
  const hr = await hrrrChances(plan[d].D).catch((err) => { console.log('HRRR:', err.message); return null; });
  if (hr) {
    for (let p = 0; p < us.length; p++) {
      const { k, w } = us[p];
      for (let m = 0; m < models.length; m++) if (hrrrModels[m]) out[m * NP + k] = Math.round(w * hr.out[m * us.length + p] + (1 - w) * out[m * NP + k]);
    }
    console.log(`  US from HRRR ${new Date(hr.run).toISOString().slice(0, 13)}Z, hours ${hr.f0 + 1}–${hr.f0 + 24}`);
  }
  const date = new Date(plan[d].D).toISOString().slice(0, 10).replace(/-/g, '');
  const file = `${date}-${runName}.bin.gz`;
  writeFileSync(join(SITE, file), gzipSync(out, { level: 9 }));
  entries.push({ date, run: new Date(RUN).toISOString(), file, hazards: HAZARDS, ...(hr ? { hrrr: new Date(hr.run).toISOString() } : {}) });
  const top = HAZARDS.map((h, m) => `${h} ${out.subarray(m * NP, (m + 1) * NP).reduce((a, v) => (v > a ? v : a), 0)}%`).join(', ');
  console.log(`${date}: ${file} (${((Date.now() - t1) / 1000).toFixed(0)} s; highest ${top})`);
}

// latest.json: the newest run's file for each date from yesterday on. Days older than a
// month are dropped from the site.
let prev = { days: [] };
try { prev = JSON.parse(readFileSync(join(SITE, 'latest.json'), 'utf8')); } catch { /* first run */ }
const byDate = new Map(prev.days.map((e) => [e.date, e]));
for (const e of entries) if (!byDate.has(e.date) || byDate.get(e.date).run <= e.run) byDate.set(e.date, e);
const keepFrom = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const days = [...byDate.values()].filter((e) => e.date >= keepFrom).sort((a, b) => (a.date < b.date ? -1 : 1));
const live = new Set(days.map((e) => e.file));
for (const f of readdirSync(SITE)) if (f.endsWith('.bin.gz') && !live.has(f)) unlinkSync(join(SITE, f));
writeFileSync(join(SITE, 'latest.json'), JSON.stringify({
  model: 'Stormycast', run: new Date(RUN).toISOString(), hazards: HAZARDS,
  grid: { nx: NX, ny: NY, west: -180, south: -90, north: 90, step: 0.5, rows: 'north first' }, days,
}));
writeFileSync(join(SITE, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=600\n');
writeFileSync(join(SITE, '404.html'), '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>\n');
writeFileSync(join(SITE, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Stormycast</title><p>Stormycast severe outlooks, for <a href="https://nexradar.pages.dev/">Nexradar</a>.</p>\n');
console.log('wrote site-data/stormycast/site');

if (args.includes('--deploy')) {
  writeFileSync(join(DIR, 'wrangler.jsonc'), '// Stormycast\'s days (scripts/stormycast-run.mjs --deploy): site/, deployed as the\n'
    + '// `stormycast` branch of the nexradar Pages project, apart from the app\'s own deployment.\n'
    + '{\n  "name": "nexradar",\n  "pages_build_output_dir": "./site",\n  "compatibility_date": "2026-10-01"\n}\n');
  const r = spawnSync('npx wrangler pages deploy --branch stormycast --commit-dirty=true', { cwd: DIR, stdio: 'inherit', shell: true });
  if (r.status) process.exit(r.status);
}
