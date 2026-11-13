// Runs Stormycast on ECMWF's newest open forecast (IFS, 0.25°) and makes the days it
// publishes: for each 0.5° point of the globe and each of five days, the chance of thunder
// and of each hazard within 40 km (public/js/core/stormycast.mjs reads them).
//
// A "day" is each place's own: 06:00 to 06:00 by the sun. The models were taught on ERA5 at
// 15Z, 21Z, 03Z and 09Z over the US — morning, afternoon, evening and small hours there —
// so each point is given the forecast step nearest 14:40 by its sun (a), 6 h before and
// after it and 12 h after, and the rain of its day; each chance is calibrated for its lead
// (hours to a). A 00Z run gives the run's date and the four after; a 12Z run the five after
// its date. Surface height and land come from ERA5 (kept in site-data/stormycast).
//
//   node scripts/stormycast-run.mjs [YYYYMMDDHH] [--deploy]
//
// Writes site-data/stormycast/site/<date>-<run>.bin.gz (uint8 percent, hazard by hazard,
// rows from 90°N, columns from 180°W) and latest.json; --deploy sends site/ as the
// `stormycast` branch of the nexradar Pages project (apart from the app's own deployment).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeMessage } from '../public/js/core/grib2.mjs';
import { environment, ENV_FEATURES, OUTLOOK_LEVELS, WIND_LEVELS } from '../public/js/core/severe-env.mjs';
import { chanceOf, rawChance, calibrated, blurAt, mapValue, ingredientIndex, ceilingAt, STORMYCAST_HAZARDS } from '../public/js/core/stormycast.mjs';
import { gustFactorAt } from '../public/js/core/stormycast-gust.mjs';
import { rows as era5Rows } from './stormycast/era5.mjs';
import { hrrrDay, hrrrHas, neighbourhoods } from './stormycast/hrrr.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DIR = join(root, 'site-data/stormycast');
const SITE = process.env.STORMYCAST_SITE || join(DIR, 'site'); // a test run can write elsewhere
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
// Four runs a day: 00Z and 12Z do all five days; 06Z and 18Z (or --day1) only update day 1.
const isFull = (t) => new Date(t).getUTCHours() % 12 === 0;
// The last step each kind needs (06Z/18Z go to 144 h; an update reaches about 48 h).
const lastStepOf = (t) => (isFull(t) ? 150 : 48);
async function newestRun() {
  const now = Date.now();
  for (let t = Math.floor(now / (6 * H)) * 6 * H; t > now - 4 * 864e5; t -= 6 * H) {
    // Out when its last step needed is.
    if (await indexOf(t, lastStepOf(t))) return t;
  }
  throw new Error('no ECMWF run found');
}
/**
 * The run this hour's job is for: the newest whose data is due by now (00Z/12Z land about
 * 7.6 h after the run, 06Z/18Z about 6.5 h), waited for up to `waitMin` minutes; else the
 * newest out. GitHub starts timed jobs late or, now and then, early.
 */
async function dueRun(waitMin) {
  const now = Date.now();
  let t = Math.floor(now / (6 * H)) * 6 * H;
  while (t + (isFull(t) ? 7.6 : 6.5) * H > now + 30 * 60e3) t -= 6 * H;
  const until = now + waitMin * 60e3;
  for (;;) {
    indexes.delete(`${t}:${lastStepOf(t)}`);
    if (await indexOf(t, lastStepOf(t))) return t;
    if (Date.now() > until) break;
    console.log(`waiting for ECMWF ${new Date(t).toISOString().slice(0, 13)}Z…`);
    await new Promise((r) => setTimeout(r, 60e3));
  }
  return newestRun();
}
const given = args.find((a) => /^\d{10}$/.test(a));
const waitArg = args.find((a) => a.startsWith('--wait='));
const RUN = given ? Date.UTC(+given.slice(0, 4), +given.slice(4, 6) - 1, +given.slice(6, 8), +given.slice(8, 10))
  : waitArg ? await dueRun(+waitArg.slice(7)) : await newestRun();
const runName = new Date(RUN).toISOString().slice(0, 13).replace(/[-T]/g, '');
const runDate = Math.floor(RUN / 864e5) * 864e5;
const UPDATE = !isFull(RUN) || args.includes('--day1');
// Each point's afternoon step (≈14:40 local solar time) on a date, in hours from the run.
const afternoonStep = (D, i) => Math.round((D + (14.7 - lonOf(i) / 15) * H - RUN) / (3 * H)) * 3;
// Full runs, five days: a 00Z run gives its date and the four after; a 12Z run the five after
// its date. An update gives each place its next afternoon still 9 h or more off (about when
// it is published): from the 06Z run, today across the Americas, Europe and Africa and
// tomorrow from about 20°E on; from the 18Z run, tomorrow everywhere. `DAY1[d]` marks the
// columns (longitudes) date d updates; the rest of that date stays as published.
const NDAYS = 5;
let DATES;
let DAY1 = null;
if (!UPDATE) {
  DATES = Array.from({ length: NDAYS }, (_, k) => k).map((k) => runDate + (new Date(RUN).getUTCHours() === 0 ? k : k + 1) * 864e5);
} else {
  const cand = [-1, 0, 1, 2].map((k) => runDate + k * 864e5);
  const pick = new Int8Array(NX);
  for (let i = 0; i < NX; i++) pick[i] = cand.findIndex((D) => afternoonStep(D, i) >= 9);
  // A date with only a sliver of columns (the far Pacific) hands them to the next.
  for (let c = 0; c < cand.length - 1; c++) {
    const n = pick.reduce((s, v) => s + (v === c), 0);
    if (n && n < NX * 0.1) for (let i = 0; i < NX; i++) if (pick[i] === c) pick[i] = c + 1;
  }
  const used = [...new Set(pick)].sort((x, y) => x - y);
  DATES = used.map((c) => cand[c]);
  DAY1 = used.map((c) => Uint8Array.from(pick, (v) => (v === c ? 1 : 0)));
}
console.log('run', runName, UPDATE ? 'day 1 update,' : '', 'days', DATES.map((d) => new Date(d).toISOString().slice(0, 10)).join(' '));
// Splitting the run over several machines (the GitHub workflow): --print-run just names the
// run (YYYYMMDDHH) for the other jobs; --gefs-member=NAME --gefs-out=DIR works out one GEFS
// member's raw chances alone and leaves them in DIR; the main run, --gefs-from=DIR, reads the
// members it finds there and works out any missing itself.
const argOpt = (k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
if (args.includes('--print-run')) {
  // GO=no when this run is already live (a job that started early found only the last one).
  let go = 'yes';
  try {
    const live = await (await fetch('https://stormycast.nexradar.pages.dev/latest.json', { signal: AbortSignal.timeout(20000) })).json();
    if (Date.parse(live.run) >= RUN && !args.includes('--force')) go = 'no';
  } catch { /* can't tell: run it */ }
  console.log(`RUN=${runName}\nGO=${go}`);
  process.exit(0);
}
const GEFS_MEMBER = argOpt('gefs-member') || null;
const GEFS_OUT = argOpt('gefs-out') || null;
const GEFS_FROM = argOpt('gefs-from') || null;

// Each point's steps, day by day.
// ECMWF's open steps: every 3 h to 144 h, every 6 h after.
const onStep = (s) => (s <= 144 ? s : Math.round(s / 6) * 6);
const near3 = (t) => onStep(Math.max(0, Math.round((t - RUN) / (3 * H)) * 3));
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
const stepOf = (p, i, w) => onStep(Math.max(0, p.a[i] + SNAP_OFF[w]));
const snapSteps = new Set();
const rainSteps = new Set();
for (const p of plan) for (let i = 0; i < NX; i++) { for (const w of SNAPS) snapSteps.add(stepOf(p, i, w)); rainSteps.add(p.s[i]); rainSteps.add(p.e[i]); }

// The day's rain comes down meanwhile; and for the correction layers, ECMWF's convective
// rain (its run total) at each point's day start and end, 3 h before its afternoon and 9 h after.
const rain = new Map();
const rainDone = GEFS_MEMBER ? Promise.resolve() : Promise.all([...rainSteps].map(async (s) => { rain.set(s, s === 0 ? new Float32Array(NP) : await field(RUN, s, 'tp')); }));
const TOPUP_CP = Object.values(STORMYCAST_MODEL.models).some((m) => m?.topup);
const cpSteps = new Set();
if (TOPUP_CP) for (const p of plan) for (let i = 0; i < NX; i++) for (const s of [p.s[i], p.e[i], onStep(Math.max(0, p.a[i] - 3)), onStep(p.a[i] + 9)]) cpSteps.add(s);
const cpRun = new Map();
const cpDone = Promise.all([...cpSteps].map(async (s) => { cpRun.set(s, s === 0 ? new Float32Array(NP) : await field(RUN, s, 'cp').catch(() => null)); }));

// Land, or within a cell of it: the points scored.
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
// The points given severe chances: land (ERA5 land fraction ≥ 0.5), and an island too small
// to have such a cell (≥ 0.2 with no ≥ 0.5 cell around it). Coastal sea gets none: its own
// environment (warm water, strong flow) is not where the reports come from, and smoothed
// in it would spread offshore chances onto the coast. Thunder still covers coastal sea.
const onLand = new Uint8Array(NP);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  const k = j * NX + i;
  if (lsm[k] >= 0.5) { onLand[k] = 1; continue; }
  if (lsm[k] < 0.2) continue;
  let big = false;
  for (let dj = -1; dj <= 1 && !big; dj++) for (let di = -1; di <= 1; di++) {
    const jj = j + dj;
    if (jj >= 0 && jj < NY && lsm[jj * NX + ((i + di + NX) % NX)] >= 0.5) { big = true; break; }
  }
  if (!big) onLand[k] = 1;
}
// Environments are worked out only there and one cell beyond (the nearby maxes read it);
// open sea is left out.
const needEnv = new Uint8Array(NP);
for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
  if (!nearLand[j * NX + i]) continue;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const jj = j + dj;
    if (jj >= 0 && jj < NY) needEnv[jj * NX + ((i + di + NX) % NX)] = 1;
  }
}

// Environments: for each day, each snapshot's features per point. The next step's fields
// are fetched while this one's are worked through.
const NE = ENV_FEATURES.length;
const env = plan.map(() => Object.fromEntries(SNAPS.map((w) => [w, new Float32Array(NP * NE).fill(NaN)])));
const t0 = Date.now();
// ECMWF's own fields at each snapshot step, for the correction layers (topup): its MUCAPE,
// 700 hPa vertical velocity and gust; null where a run has none (older runs lack some).
const TOPUP = Object.values(STORMYCAST_MODEL.models).some((m) => m?.topup);
const own = new Map(); // step -> { mucape, w700, fg }
const ownJobs = [];
function stepFields(step) {
  const F = {};
  if (TOPUP) {
    const o = {};
    own.set(step, o);
    for (const [k, p, l] of [['mucape', 'mucape'], ['w700', 'w', 700], ['fg', '10fg']]) ownJobs.push(field(RUN, step, p, l ?? null).then((a) => { o[k] = a; }, () => { o[k] = null; }));
  }
  const jobs = [['sp', 'sp'], ['t2', '2t'], ['d2', '2d'], ['u10', '10u'], ['v10', '10v']].map(async ([k, p]) => { F[k] = await field(RUN, step, p); });
  for (const p of OUTLOOK_LEVELS) jobs.push(field(RUN, step, 't', p).then((a) => { F[`t${p}`] = a; }));
  for (const p of WIND_LEVELS) for (const k of ['q', 'u', 'v']) jobs.push(field(RUN, step, k, p).then((a) => { F[k + p] = a; }));
  return Promise.all(jobs).then(() => F);
}
const stepList = [...snapSteps].sort((x, y) => x - y);
/**
 * Fills `out` (each day's snapshots' environments at the points that need them) from the
 * fields `load(step)` gives (sp, t2, d2, u10, v10, t<level>, q/u/v<level>), the next step's
 * fetched while this one's are worked through. ECMWF's and each GEFS member's alike.
 */
async function environments(load, out, label) {
  for (const day of out) for (const w of SNAPS) day[w].fill(NaN);
  let nextFields = load(stepList[0]);
  for (let si = 0; si < stepList.length; si++) {
    const step = stepList[si];
    const F = await nextFields;
    if (si + 1 < stepList.length) nextFields = load(stepList[si + 1]);
    nextFields?.catch(() => {});
    let n = 0;
    let cols = 0;
    for (let d = 0; d < plan.length; d++) {
      for (const w of SNAPS) {
        const o = out[d][w];
        for (let i = 0; i < NX; i++) {
          if (stepOf(plan[d], i, w) !== step) continue;
          // A breath now and then, so the next step's downloads keep moving.
          if (++cols % 40 === 0) await new Promise((r) => setImmediate(r));
          for (let j = 0; j < NY; j++) {
            const k = j * NX + i;
            if (!needEnv[k]) continue;
            const c = { ps: F.sp[k] / 100, zs: zs[k] / 9.80665, t2: F.t2[k], d2: F.d2[k], u10: F.u10[k], v10: F.v10[k], t: {}, q: {}, u: {}, v: {}, lat: latOf(j) };
            for (const p of OUTLOOK_LEVELS) c.t[p] = F[`t${p}`][k];
            for (const p of WIND_LEVELS) { c.q[p] = F[`q${p}`][k]; c.u[p] = F[`u${p}`][k]; c.v[p] = F[`v${p}`][k]; }
            const e = environment(c);
            if (!e) continue;
            for (let f = 0; f < NE; f++) o[k * NE + f] = e[ENV_FEATURES[f]];
            n++;
          }
        }
      }
    }
    if (label === 'ECMWF' || si === stepList.length - 1) console.log(`${label} step ${step}: ${n} environments (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
}
if (!GEFS_MEMBER) await environments(stepFields, env, 'ECMWF');
await rainDone;
await cpDone;
await Promise.all(ownJobs);

/**
 * A Gaussian average of v over the points that have a value, each point with its own width
 * σ(k) in km (0 leaves it as it is), out to 2.5σ — as stormycast-blur.mjs tuned it.
 */
function smooth(v, sigmaOf) {
  const out = new Float32Array(NP).fill(NaN);
  for (let j = 0; j < NY; j++) {
    const lat = latOf(j);
    const kmLon = 55.6 * Math.max(0.05, Math.cos((lat * Math.PI) / 180));
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      if (!Number.isFinite(v[k])) continue;
      const sigma = sigmaOf(k);
      if (!(sigma > 0)) { out[k] = v[k]; continue; }
      const rj = Math.ceil((2.5 * sigma) / 55.6);
      const ri = Math.min(NX >> 1, Math.ceil((2.5 * sigma) / kmLon));
      let s = 0;
      let w = 0;
      for (let dj = -rj; dj <= rj; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= NY) continue;
        const dy = dj * 55.6;
        for (let di = -ri; di <= ri; di++) {
          const vv = v[jj * NX + ((i + di + NX) % NX)];
          if (!Number.isFinite(vv)) continue;
          const d2 = dy * dy + (di * kmLon) ** 2;
          if (d2 > 6.25 * sigma * sigma) continue;
          const g = Math.exp(-d2 / (2 * sigma * sigma));
          s += g * vv;
          w += g;
        }
      }
      out[k] = s / w;
    }
  }
  return out;
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
// 2 in+ hail and EF2+ tornadoes stay with ECMWF (and GEFS) over the US; the rest is mixed. (EF2+
// was three quarters HRRR's from 27 days, until the longer test below.) The shares were tried
// on the consensus's 665 days of 2024–25 (scripts/stormycast-consensus.mjs --sweep,
// 2026-11-13): about 60% HRRR beat HRRR alone for every hazard (tornado skill .104
// against .099 alone, hail .141 against .135, wind .189 against .183, 65 kt+ wind .052 against
// .048), and EF2+ was best with no HRRR at all (.082; .069 at the three quarters it had from 27
// days). HRRR alone had also wiped out the 2–4% the coarse models gave the 11 Nov EF0.
const HRRR_SKIP = new Set(['sighail', 'sigtor']);
const HRRR_SHARE = { tor: 0.6, hail: 0.6, wind: 0.6, sigwind: 0.6 };
// A significant hazard is never let above its own kind (EF2+ above any tornado, and so on).
const PARENT = { sigtor: 'tor', sighail: 'hail', sigwind: 'wind' };
const hrrrModels = HRRR_MODEL ? STORMYCAST_HAZARDS.map((h) => (HRRR_SKIP.has(h) ? null : HRRR_MODEL.models[h])) : [];
// The consensus (scripts/stormycast-consensus.mjs), day 1 only: one small model per hazard
// reads each source's smoothed chance at the point (ECMWF, the GEFS member mean and spread,
// over the US HRRR) and gives one chance, for the hazards where it scored better than the
// fixed shares (`use`). Off until its file exists.
let CONSENSUS = null;
try { CONSENSUS = (await import('../public/js/core/stormycast-consensus.mjs')).STORMYCAST_CONSENSUS; } catch { /* not fitted yet */ }
const usAt = new Int32Array(NP).fill(-1);
us.forEach((u, p) => { usAt[u.k] = p; });
const logitOf = (p) => { const c = Math.min(1 - 1e-5, Math.max(1e-5, p)); return Math.log(c / (1 - c)); };
const onCurveOf = (c, v) => {
  for (let i = 1; i < c.length; i++) if (v <= c[i][0]) { const [x0, y0] = c[i - 1]; const [x1, y1] = c[i]; return x1 > x0 ? y0 + ((v - x0) / (x1 - x0)) * (y1 - y0) : y1; }
  return c.at(-1)[1];
};
/** One consensus model's chance from v = { e, g, h, spread, pe, pg, ph } (smoothed raw chances). */
function consensusChance(c, v) {
  const src = c.names.filter((n) => /^l[egh]$/.test(n)).map((n) => n[1]);
  const l = src.map((s) => logitOf(v[s]));
  const row = [...l, ...l.map((a) => a * a)];
  for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) row.push(l[a] * l[b]);
  row.push(Math.sqrt(v.spread));
  if (c.names.length > row.length) for (const s of src) row.push(logitOf(v[`p${s}`]));
  if (row.length !== c.names.length || row.some((a) => !Number.isFinite(a))) return NaN;
  let z = c.beta[row.length];
  for (let j = 0; j < row.length; j++) z += (c.beta[j] * (row[j] - c.mu[j])) / c.sd[j];
  return onCurveOf(c.curve, 1 / (1 + Math.exp(-z)));
}
// The time the runner acts as if it were (--as-of=2026-11-11T08:40Z), so a past run can be
// made again with only the HRRR runs that were out then.
const AS_OF = argOpt('as-of') ? Date.parse(argOpt('as-of')) : null;
// How many of HRRR's 48-hour runs (6 hours apart) are averaged: one run alone flips from cycle
// to cycle (11 Nov 2026: 3–4% at Riley, Indiana from the 18Z run, nothing from the 06Z one,
// and the EF0 came), so its raw chances are taken over the newest few that cover the day.
const HRRR_LAG = Math.max(1, Number(argOpt('hrrr-lag')) || 3);

/**
 * The US day (12Z on D to 12Z next) from HRRR: the raw chances of the newest HRRR_LAG runs
 * that cover it (48 h runs) averaged (a time-lagged ensemble), then smoothed and calibrated
 * as for one run at the newest one's lead.
 */
async function hrrrChances(D) {
  if (!us.length) return null;
  const start = D + 12 * H;
  const newest = Math.min(start, Math.floor((AS_OF ?? Date.now()) / (6 * H)) * 6 * H);
  const NFH = HRRR_MODEL.features.length;
  const allH = STORMYCAST_HAZARDS.map((h) => HRRR_MODEL.models[h] || null);
  const sum = allH.map((m) => (m ? new Float64Array(us.length) : null));
  const runs = [];
  let first = null;
  for (let run = newest; run >= start - 30 * H && runs.length < HRRR_LAG; run -= 6 * H) {
    const f0 = Math.round((start - run) / H);
    if (f0 + 24 > 48 || !(await hrrrHas(run, f0 + 24))) continue;
    const X = await hrrrDay(run, f0, us.map((p) => p.hood));
    if (!X) continue;
    const x = new Float32Array(NFH);
    for (let p = 0; p < us.length; p++) {
      for (let q = 0; q < NFH; q++) x[q] = X[p * NFH + q];
      for (let m = 0; m < allH.length; m++) if (allH[m]) sum[m][p] += rawChance(allH[m], x);
    }
    runs.push(run);
    first ??= { run, f0 };
  }
  if (!first) return null;
  {
    const { run, f0 } = first;
    console.log(`  HRRR runs averaged: ${runs.map((r) => new Date(r).toISOString().slice(5, 13).replace('T', ' ') + 'Z').join(', ')}`);
    const out = new Uint8Array(hrrrModels.length * us.length);
    // Raw chances first (the runs' mean), then (as ECMWF's) smoothed over the US points by the
    // model's σ for the newest run's lead (hours to the day's afternoon snapshot), then calibrated.
    // Every hazard's (the consensus reads the skipped ones too); only the overlaid ones calibrated.
    const rawH = sum.map((s) => (s ? s.map((v) => v / runs.length) : null));
    const smH = allH.map(() => null);
    for (let m = 0; m < allH.length; m++) {
      if (!allH[m]) continue;
      const sigma = blurAt(allH[m], f0 + 9);
      let v = rawH[m];
      if (sigma > 0) {
        const full = new Float32Array(NP).fill(NaN);
        for (let p = 0; p < us.length; p++) full[us[p].k] = v[p];
        const sm = smooth(full, () => sigma);
        v = us.map(({ k }) => sm[k]);
      }
      smH[m] = v;
      if (hrrrModels[m]) for (let p = 0; p < us.length; p++) out[m * us.length + p] = Math.round(100 * calibrated(hrrrModels[m], v[p]));
    }
    return { run, f0, out, sm: smH };
  }
  return null;
}

// --- GEFS (core/stormycast-gefs-model.mjs) ------------------------------------------------------
// NOAA's ensemble, the same cycle as ECMWF's run: its first members (gec00, gep01…), each
// through the GEFS model (trained on the GEFSv12 reforecast) at the same snapshots and days,
// their raw chances averaged, smoothed and calibrated for the lead, then mixed with ECMWF's
// by the share the model holds for each hazard and lead (scripts/stormycast-gefs-blend.mjs).
// Left out (ECMWF alone) if the model has no mix yet, the run is not out, or --no-gefs.
let GEFS = null;
if (!args.includes('--no-gefs')) {
  try {
    const G = (await import('../public/js/core/stormycast-gefs-model.mjs')).STORMYCAST_GEFS_MODEL;
    if (G.models.tor?.weight) GEFS = G;
  } catch { /* not fitted */ }
}
/** [day][model] Float32Array of calibrated GEFS chances (NaN where none), or null. */
async function gefsChances() {
  const { gefsOpsGrid, gefsOpsHas, gefsFetched } = await import('./stormycast/gefs.mjs');
  const all = ['gec00', ...Array.from({ length: (GEFS.members || 5) - 1 }, (_, k) => `gep${String(k + 1).padStart(2, '0')}`)];
  const members = GEFS_MEMBER ? [GEFS_MEMBER] : all;
  // A member's saved part (from a --gefs-member job): this run's days' raw sums, then which points were worked out.
  const partFile = (dir, member) => join(dir, `gefs-${runName}-${member}.f32.gz`);
  const PART = plan.length * (STORMYCAST_HAZARDS.length + 1) * NP;
  const lastStep = Math.max(...stepList, ...plan.flatMap((p) => [...p.e, ...[...p.a].map((a) => a + 9)]));
  if (!(await gefsOpsHas(RUN, members.at(-1), Math.ceil(lastStep / 3) * 3))) { console.log('GEFS: this cycle is not out yet; ECMWF alone'); return null; }
  const GF = GEFS.features;
  const GM = STORMYCAST_HAZARDS.map((h) => GEFS.models[h]);
  // Where each input comes from: as ECMWF's SOURCE, or a GEFS field of its own.
  const OWN = { g_cape: 'gefs_cape', g_cin: 'gefs_cin', g_hlcy: 'gefs_hlcy', g_pwat: 'gefs_pwat', g_hpbl: 'gefs_hpbl', g_gust: 'gefs_gust' };
  const GSRC = GF.map((f) => {
    const m = /^([abmn])_(.+)$/.exec(f);
    if (m && ENV_FEATURES.includes(m[2])) return [m[1], ENV_FEATURES.indexOf(m[2])];
    if (f === 'rain' || f === 'nb_rain') return f;
    if (f.startsWith('nb_')) return ['nb', NB.indexOf(f.slice(3))];
    const o = /^(g_[a-z]+)_([ab])$/.exec(f);
    if (o && OWN[o[1]]) return ['own', OWN[o[1]], o[2]];
    if (f.startsWith('g_cp_')) return ['cp', f.slice(5)];
    throw new Error(`unknown GEFS input ${f}`);
  });
  const MUCAPE = ENV_FEATURES.indexOf('mucape');
  let skipped = 0;
  let treed = 0;
  const genv = plan.map(() => Object.fromEntries(SNAPS.map((w) => [w, new Float32Array(NP * NE)])));
  const sum = plan.map(() => GM.map(() => new Float32Array(NP)));
  const cnt = plan.map(() => new Uint8Array(NP));
  // Day 1's sums of squares, for the members' spread (the consensus reads it).
  const sq1 = GM.map(() => new Float32Array(NP));
  const x = new Float32Array(GF.length);
  const t1 = Date.now();
  let used = 0;
  for (const member of members) {
    const mSum = plan.map(() => GM.map(() => new Float32Array(NP)));
    const mCnt = plan.map(() => new Uint8Array(NP));
    const take = () => {
      for (let d = 0; d < plan.length; d++) {
        for (let m = 0; m < GM.length; m++) { const a = sum[d][m]; const b = mSum[d][m]; for (let k = 0; k < NP; k++) a[k] += b[k]; }
        if (d === 0) for (let m = 0; m < GM.length; m++) { const a = sq1[m]; const b = mSum[0][m]; for (let k = 0; k < NP; k++) a[k] += b[k] * b[k]; }
        for (let k = 0; k < NP; k++) cnt[d][k] += mCnt[d][k];
      }
      used++;
    };
    if (GEFS_FROM && existsSync(partFile(GEFS_FROM, member))) {
      const buf = gunzipSync(readFileSync(partFile(GEFS_FROM, member)));
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
      if (v.length === PART) {
        let o = 0;
        for (let d = 0; d < plan.length; d++) { for (let m = 0; m < GM.length; m++) { mSum[d][m].set(v.subarray(o, o + NP)); o += NP; } for (let k = 0; k < NP; k++) mCnt[d][k] = v[o + k]; o += NP; }
        take();
        console.log(`GEFS ${member}: from its own job`);
        continue;
      }
      console.log(`GEFS ${member}: its saved part doesn't fit this run; working it out here`);
    }
    const cache = new Map();
    const memo = new Map();
    const grid = (field, fh, level = null) => {
      const key = `${field}:${fh}:${level}`;
      if (!memo.has(key)) memo.set(key, gefsOpsGrid(field, fh, level, RUN, member, cache).then((a) => { if (!a) throw new Error(`GEFS ${member} has no ${field} ${level ?? ''} at ${fh} h`); return a; }));
      return memo.get(key);
    };
    // The environment's own fields, let go once their step is worked out.
    const ENV_FIELDS = new Set(['surface_pressure', '2m_temperature', '2m_dewpoint_temperature', '10m_u_component_of_wind', '10m_v_component_of_wind', 'temperature', 'specific_humidity', 'u_component_of_wind', 'v_component_of_wind']);
    const load = async (step) => {
      const F = {};
      const jobs = [['sp', 'surface_pressure'], ['t2', '2m_temperature'], ['d2', '2m_dewpoint_temperature'], ['u10', '10m_u_component_of_wind'], ['v10', '10m_v_component_of_wind']].map(async ([k, f]) => { F[k] = await grid(f, step); });
      for (const p of OUTLOOK_LEVELS) jobs.push(grid('temperature', step, p).then((a) => { F[`t${p}`] = a; }));
      for (const p of WIND_LEVELS) for (const [k, f] of [['q', 'specific_humidity'], ['u', 'u_component_of_wind'], ['v', 'v_component_of_wind']]) jobs.push(grid(f, step, p).then((a) => { F[k + p] = a; }));
      await Promise.all(jobs);
      // The step's environment fields are not needed again (rain and GEFS's own come separately).
      for (const key of [...memo.keys()]) { const [f, s] = key.split(':'); if (ENV_FIELDS.has(f) && s === String(step)) memo.delete(key); }
      return F;
    };
    try {
      // Every other field the days need, fetched together while the environments are worked
      // out (one at a time they waited on the network for most of a member's time).
      const wanted = new Set();
      for (const p of plan) {
        for (let i = 0; i < NX; i++) {
          for (const f of Object.values(OWN)) { wanted.add(`${f}|${stepOf(p, i, 'a')}`); wanted.add(`${f}|${stepOf(p, i, 'b')}`); }
          for (const s of [p.s[i], Math.max(0, p.a[i] - 3), p.a[i] + 9, p.e[i]]) wanted.add(`convective_precipitation|${s}`);
          wanted.add(`total_precipitation|${p.s[i]}`); wanted.add(`total_precipitation|${p.e[i]}`);
        }
      }
      const others = Promise.all([...wanted].map((w) => { const [f, s] = w.split('|'); return grid(f, +s); }));
      others.catch(() => {});
      await environments(load, genv, `GEFS ${member}`);
      await others;
      for (let d = 0; d < plan.length; d++) {
        const p = plan[d];
        const E = genv[d];
        // The day's rain and the nearby maxes, as ECMWF's.
        const tp = new Float32Array(NP);
        for (let i = 0; i < NX; i++) {
          const [s, e] = await Promise.all([grid('total_precipitation', p.s[i]), grid('total_precipitation', p.e[i])]);
          for (let j = 0; j < NY; j++) { const k = j * NX + i; tp[k] = Math.max(0, (e[k] - s[k]) * 1000); }
        }
        const nbtp = nbMax((k) => tp[k]);
        const nb = NB.map((f) => { const fi = ENV_FEATURES.indexOf(f); return nbMax((k) => { const a = E.a[k * NE + fi]; const b = E.b[k * NE + fi]; return Math.max(Number.isFinite(a) ? a : -Infinity, Number.isFinite(b) ? b : -Infinity); }); });
        for (let i = 0; i < NX; i++) {
          const sa = stepOf(p, i, 'a');
          const sb = stepOf(p, i, 'b');
          const own = {};
          for (const f of Object.values(OWN)) own[f] = { a: await grid(f, sa), b: await grid(f, sb) };
          const cpAt = await Promise.all([p.s[i], Math.max(0, p.a[i] - 3), p.a[i] + 9, p.e[i]].map((s) => grid('convective_precipitation', s)));
          for (let j = 0; j < NY; j++) {
            const k = j * NX + i;
            if (!onLand[k] || !Number.isFinite(E.a[k * NE]) || !Number.isFinite(E.b[k * NE])) continue;
            const cp = (u, v) => Math.max(0, (cpAt[v][k] - cpAt[u][k]) * 1000);
            mCnt[d][k] = 1;
            // No instability all day (MUCAPE under 25 J/kg at every snapshot and nearby): the
            // trees would give ~0, so they are skipped (most land, most of the year; the bulk
            // of the time GEFS takes otherwise).
            let cape = nb[NB.indexOf('mucape')][k];
            for (const w of SNAPS) { const v = E[w][k * NE + MUCAPE]; if (v > cape) cape = v; }
            if (!(cape >= 25)) { skipped++; continue; }
            treed++;
            for (let f = 0; f < GF.length; f++) {
              const s = GSRC[f];
              x[f] = s === 'rain' ? tp[k] : s === 'nb_rain' ? nbtp[k] : s[0] === 'nb' ? nb[s[1]][k]
                : s[0] === 'own' ? own[s[1]][s[2]][k]
                  : s[0] === 'cp' ? (s[1] === 'before' ? cp(0, 1) : s[1] === 'storm' ? cp(1, 2) : cp(0, 3))
                    : E[s[0]][k * NE + s[1]];
            }
            for (let m = 0; m < GM.length; m++) mSum[d][m][k] = rawChance(GM[m], x);
          }
          if (i % 60 === 59) await new Promise((r) => setImmediate(r));
        }
      }
      take();
      if (GEFS_OUT) {
        mkdirSync(GEFS_OUT, { recursive: true });
        const v = new Float32Array(PART);
        let o = 0;
        for (let d = 0; d < plan.length; d++) { for (let m = 0; m < GM.length; m++) { v.set(mSum[d][m], o); o += NP; } v.set(mCnt[d], o); o += NP; }
        writeFileSync(partFile(GEFS_OUT, member), gzipSync(Buffer.from(v.buffer), { level: 6 }));
      }
      console.log(`GEFS ${member} done (${((Date.now() - t1) / 1000).toFixed(0)} s, ${(gefsFetched() / 1e9).toFixed(1)} GB so far, memory ${(process.memoryUsage().rss / 1e9).toFixed(1)} GB; trees at ${treed} point-days, ${skipped} skipped with no CAPE)`);
    } catch (err) {
      // A member's sums are already mixed in, and the calibration expects every member: this
      // run goes out on ECMWF alone.
      console.log(`GEFS ${member} failed (${err.message}); ECMWF alone this run`);
      return null;
    }
  }
  // Averaged, smoothed and calibrated for each point's lead.
  const out = plan.map((p, d) => GM.map((model) => {
    const mean = new Float32Array(NP).fill(NaN);
    for (let k = 0; k < NP; k++) if (cnt[d][k] === used) mean[k] = sum[d][GM.indexOf(model)][k] / used;
    const sm = smooth(mean, (k) => blurAt(model, p.a[k % NX]));
    return sm.map((v, k) => (Number.isFinite(v) ? calibrated(model, v, p.a[k % NX]) : NaN));
  }));
  // Day 1's smoothed mean and spread, uncalibrated, for the consensus.
  if (CONSENSUS) {
    const p = plan[0];
    out.day1 = { mean: [], spread: [] };
    GM.forEach((model, m) => {
      const mean = new Float32Array(NP).fill(NaN);
      const sd = new Float32Array(NP).fill(NaN);
      for (let k = 0; k < NP; k++) {
        if (cnt[0][k] !== used) continue;
        mean[k] = sum[0][m][k] / used;
        sd[k] = Math.sqrt(Math.max(0, sq1[m][k] / used - mean[k] * mean[k]));
      }
      out.day1.mean.push(smooth(mean, (k) => blurAt(model, p.a[k % NX])));
      out.day1.spread.push(smooth(sd, (k) => blurAt(model, p.a[k % NX])));
    });
  }
  console.log(`GEFS: ${used} members in ${((Date.now() - t1) / 1000).toFixed(0)} s`);
  return out;
}
const gefsDays = GEFS ? await gefsChances().catch((err) => { console.log('GEFS failed:', err.message); return null; }) : null;
if (GEFS_MEMBER) { console.log(`GEFS member ${GEFS_MEMBER} done`); process.exit(gefsDays ? 0 : 1); }

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
// The wind models' places, and each point's gust factor (1 over the US and far from the tropics).
const WIND_MODELS = new Set(['wind', 'sigwind'].map((h) => STORMYCAST_HAZARDS.indexOf(h)).filter((m) => m >= 0));
const gustFactor = new Float32Array(NP);
for (let k = 0; k < NP; k++) gustFactor[k] = gustFactorAt(90 - Math.floor(k / NX) * 0.5, -180 + (k % NX) * 0.5);
// Each input's place by name.
const FEATURE_AT = Object.fromEntries(FEATURES.map((f, i) => [f, i]));
// Where each input comes from: [snapshot, env index] | 'rain' | 'nb_rain' | ['nb', k].
const SOURCE = FEATURES.map((f) => {
  const m = /^([abmn])_(.+)$/.exec(f);
  if (m && ENV_FEATURES.includes(m[2])) return [m[1], ENV_FEATURES.indexOf(m[2])];
  if (f === 'rain' || f === 'nb_rain') return f;
  if (f.startsWith('nb_')) return ['nb', NB.indexOf(f.slice(3))];
  throw new Error(`unknown input ${f}`);
});
const entries = [];
// What is live now (the workflow pulls it first): an update keeps its other columns.
let published = { days: [] };
try { published = JSON.parse(readFileSync(join(SITE, 'latest.json'), 'utf8')); } catch { /* first run */ }
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
  // Raw chances first (the trees), then each smoothed over its neighbours (the model's σ for
  // the point's lead, land points only), then calibrated for that lead and held under thunder.
  const rawP = models.map(() => new Float32Array(NP).fill(NaN));
  const thunder = new Int16Array(NP).fill(-1);
  // Each point's ingredient indexes, for the models' ceilings (ceilingAt).
  const ingr = { stp: new Float32Array(NP), wmaxshear: new Float32Array(NP) };
  const byName = (name) => raw[FEATURE_AT[name]];
  // The correction layers' inputs (stormycast/maps.mjs EXTRA, worked out as the saved maps
  // were): ECMWF's own fields at the point's snapshots and its convective rain windows.
  const topupFeatures = models.find((m) => m?.topup)?.topup.features || null;
  const xt = topupFeatures ? new Float32Array(topupFeatures.length) : null;
  const ownAt = (w, key, k, i) => { const o = own.get(stepOf(plan[d], i, w)); return o?.[key] ? o[key][k] : NaN; };
  const cpAt = (s, k) => { const a = cpRun.get(s); return a ? a[k] : NaN; };
  const before = (i) => onStep(Math.max(0, plan[d].a[i] - 3));
  const after = (i) => onStep(plan[d].a[i] + 9);
  const EXTRA_OF = {
    ec_mucape_a: (k, i) => ownAt('a', 'mucape', k, i), ec_mucape_b: (k, i) => ownAt('b', 'mucape', k, i),
    ec_mucape_m: (k, i) => ownAt('m', 'mucape', k, i), ec_mucape_n: (k, i) => ownAt('n', 'mucape', k, i),
    ec_cp_before: (k, i) => Math.max(0, (cpAt(before(i), k) - cpAt(plan[d].s[i], k)) * 1000),
    ec_cp_storm: (k, i) => Math.max(0, (cpAt(after(i), k) - cpAt(before(i), k)) * 1000),
    ec_cp_day: (k, i) => Math.max(0, (cpAt(plan[d].e[i], k) - cpAt(plan[d].s[i], k)) * 1000),
    ec_w700_a: (k, i) => ownAt('a', 'w700', k, i), ec_w700_b: (k, i) => ownAt('b', 'w700', k, i),
    ec_fg_a: (k, i) => ownAt('a', 'fg', k, i), ec_fg_b: (k, i) => ownAt('b', 'fg', k, i),
  };
  for (let k = 0; k < NP; k++) {
    if (!nearLand[k] || !Number.isFinite(A[k * NE]) || !Number.isFinite(B[k * NE])) continue;
    for (let f = 0; f < FEATURES.length; f++) {
      const s = SOURCE[f];
      raw[f] = s === 'rain' ? cp[k] : s === 'nb_rain' ? nbcp[k] : s[0] === 'nb' ? nb[s[1]][k] : E[s[0]][k * NE + s[1]];
    }
    ingr.stp[k] = ingredientIndex('stp', byName);
    ingr.wmaxshear[k] = ingredientIndex('wmaxshear', byName);
    // ECMWF's values on ERA5's scale, as the models were taught.
    for (let f = 0; f < FEATURES.length; f++) x[f] = mapValue(maps[f], raw[f]);
    const lead = plan[d].a[k % NX];
    if (xt) for (let f = 0; f < xt.length; f++) { const name = topupFeatures[f]; xt[f] = name in FEATURE_AT ? raw[FEATURE_AT[name]] : EXTRA_OF[name](k, k % NX); }
    // Severe chances over land only (onLand); thunder over coastal sea too.
    if (onLand[k]) for (let m = 0; m < models.length; m++) if (models[m]) rawP[m][k] = rawChance(models[m], x, xt);
    if (LTG) {
      for (let f = 0; f < FEATURES.length; f++) xl[f] = mapValue(ltgMaps[f], raw[f]);
      thunder[k] = Math.round(100 * chanceOf(LTG, xl, lead));
    }
    if (PROBE.has(k)) console.log(`probe ${PROBE.get(k)} day ${d}: raw`, HAZARDS.map((h, m) => `${h} ${m < models.length ? (100 * rawP[m][k]).toFixed(1) : thunder[k]}%`).join(' '), '\n ', FEATURES.map((f, i) => `${f}=${+x[i].toFixed(1)}`).join(' '));
  }
  // An update date that leaves the US as it was needs no HRRR.
  const usHere = !DAY1 || DAY1[d].some((v, i) => v && lonOf(i) > -126 && lonOf(i) < -66);
  const hr = !usHere ? null : await hrrrChances(plan[d].D).catch((err) => { console.log('HRRR:', err.message); return null; });
  const smAll = models.map((model, m) => (model ? smooth(rawP[m], (k) => blurAt(model, plan[d].a[k % NX])) : null));
  // Day 1's consensus where it is used: over the US (HRRR in it) it takes HRRR's place, so
  // those points skip the overlay below, as they skip the ECMWF-based caps HRRR skips.
  const G1 = d === 0 && CONSENSUS ? gefsDays?.day1 : null;
  const byUs = new Uint8Array(models.length * NP);
  let nCons = 0;
  for (let m = 0; m < models.length; m++) {
    if (!models[m]) continue;
    const sm = smAll[m];
    const hz = STORMYCAST_HAZARDS[m];
    const pm = PARENT[hz] ? STORMYCAST_HAZARDS.indexOf(PARENT[hz]) : -1;
    const useUs = G1 && hr?.sm[m] && CONSENSUS.us.use.includes(hz);
    const useGlobal = G1 && CONSENSUS.global.use.includes(hz);
    for (let k = 0; k < NP; k++) {
      if (!Number.isFinite(sm[k])) continue;
      let pr = calibrated(models[m], sm[k], plan[d].a[k % NX]);
      // Mixed with GEFS's by its share for this hazard and lead.
      const g = gefsDays?.[d][m][k];
      if (g != null && Number.isFinite(g)) {
        const w = blurAt({ blur: GEFS.models[STORMYCAST_HAZARDS[m]].weight }, plan[d].a[k % NX]);
        pr = (1 - w) * pr + w * g;
      }
      let usValue = NaN;
      if (useUs || useGlobal) {
        const cv = { e: sm[k], g: G1.mean[m][k], spread: G1.spread[m][k], pe: pm >= 0 ? smAll[pm][k] : NaN, pg: pm >= 0 ? G1.mean[pm][k] : NaN };
        const c = useGlobal ? consensusChance(CONSENSUS.global[hz], cv) : NaN;
        if (Number.isFinite(c)) { pr = c; nCons++; }
        const p = useUs && onLand[k] ? usAt[k] : -1;
        if (p >= 0) {
          const cu = consensusChance(CONSENSUS.us[hz], { ...cv, h: hr.sm[m][p], ph: pm >= 0 && hr.sm[pm] ? hr.sm[pm][p] : NaN });
          if (Number.isFinite(cu)) { usValue = us[p].w * cu + (1 - us[p].w) * pr; nCons++; }
        }
      }
      let v = Math.round(100 * pr);
      if (thunder[k] >= 0 && v > thunder[k]) v = thunder[k];
      // No more than the point's ingredients carry on US forecast days.
      const ceil = models[m].ceiling;
      if (ceil) v = Math.min(v, Math.round(100 * ceilingAt(models[m], ingr[ceil.index][k])));
      // Wind outside the US: scaled by how often thunderstorms there bring measured damaging
      // gusts (core/stormycast-gust.mjs, from airport reports).
      if (WIND_MODELS.has(m)) v = Math.round(v * gustFactor[k]);
      if (Number.isFinite(usValue)) { v = Math.round(100 * usValue); byUs[m * NP + k] = 1; }
      out[m * NP + k] = v;
    }
  }
  if (G1) console.log(`  consensus at ${nCons} point-hazards (us: ${CONSENSUS.us.use.join(',')}; global: ${CONSENSUS.global.use.join(',')})`);
  if (LTG) for (let k = 0; k < NP; k++) if (thunder[k] >= 0) out[models.length * NP + k] = thunder[k];
  for (const [k, name] of PROBE) console.log(`probe ${name} day ${d}:`, HAZARDS.map((h, m) => `${h} ${out[m * NP + k]}%`).join(' '));
  if (hr) {
    for (let p = 0; p < us.length; p++) {
      const { k, w } = us[p];
      if (!onLand[k]) continue;
      for (let m = 0; m < models.length; m++) {
        if (!hrrrModels[m] || byUs[m * NP + k]) continue;
        const s = w * (HRRR_SHARE[STORMYCAST_HAZARDS[m]] ?? 1);
        out[m * NP + k] = Math.round(s * hr.out[m * us.length + p] + (1 - s) * out[m * NP + k]);
      }
    }
    console.log(`  US from HRRR ${new Date(hr.run).toISOString().slice(0, 13)}Z, hours ${hr.f0 + 1}–${hr.f0 + 24}`);
    for (const [k, name] of PROBE) {
      const p = usAt[k];
      if (p < 0) continue;
      console.log(`probe ${name} day ${d}: HRRR's own`, HAZARDS.slice(0, models.length).map((h, m) => `${h} ${hrrrModels[m] ? hr.out[m * us.length + p] : '-'}%`).join(' '), '· after the mix', HAZARDS.slice(0, models.length).map((h, m) => `${h} ${out[m * NP + k]}%`).join(' '));
    }
  }
  for (const [sig, parent] of Object.entries(PARENT)) {
    const a = STORMYCAST_HAZARDS.indexOf(sig);
    const b = STORMYCAST_HAZARDS.indexOf(parent);
    if (a < 0 || b < 0) continue;
    for (let k = 0; k < NP; k++) if (out[a * NP + k] > out[b * NP + k]) out[a * NP + k] = out[b * NP + k];
  }
  const date = new Date(plan[d].D).toISOString().slice(0, 10).replace(/-/g, '');
  const file = `${date}-${runName}.bin.gz`;
  // An update keeps the published day outside its own columns (DAY1).
  let base = null;
  if (DAY1) {
    const old = published.days.find((e) => e.date === date);
    try {
      if (old && existsSync(join(SITE, old.file))) {
        const ob = gunzipSync(readFileSync(join(SITE, old.file)));
        const oh = old.hazards || STORMYCAST_HAZARDS;
        for (let m = 0; m < HAZARDS.length; m++) {
          const om = oh.indexOf(HAZARDS[m]);
          for (let k = 0; k < NP; k++) if (!DAY1[d][k % NX]) out[m * NP + k] = om >= 0 ? ob[om * NP + k] : 0;
        }
        base = old.run;
        console.log(`  kept ${old.file} outside this update's ${DAY1[d].reduce((s, v) => s + v, 0)} columns`);
      } else console.log(`  no published ${date} to update: all of it from this run`);
    } catch (err) { console.log(`  couldn't read ${old.file} (${err.message}): all of it from this run`); }
  }
  writeFileSync(join(SITE, file), gzipSync(out, { level: 9 }));
  entries.push({ date, run: new Date(RUN).toISOString(), file, hazards: HAZARDS, ...(base ? { update: true, base } : {}), ...(hr ? { hrrr: new Date(hr.run).toISOString() } : {}), ...(gefsDays ? { gefs: GEFS.members || 5 } : {}) });
  const top = HAZARDS.map((h, m) => `${h} ${out.subarray(m * NP, (m + 1) * NP).reduce((a, v) => (v > a ? v : a), 0)}%`).join(', ');
  console.log(`${date}: ${file} (${((Date.now() - t1) / 1000).toFixed(0)} s; highest ${top})`);
}

// latest.json: the newest run's file for each date from yesterday on. Days older than a
// month are dropped from the site.
const prev = published;
const byDate = new Map(prev.days.map((e) => [e.date, e]));
for (const e of entries) if (!byDate.has(e.date) || byDate.get(e.date).run <= e.run) byDate.set(e.date, e);
const keepFrom = new Date(Date.now() - 31 * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const days = [...byDate.values()].filter((e) => e.date >= keepFrom).sort((a, b) => (a.date < b.date ? -1 : 1));
// The four runs before this one, newest first, each as the site showed it: its days from
// the day before its run on (a day 1 update with its other days from the run it updated).
// Their files stay on the site so the website can show them.
const runDay = (iso) => new Date(Date.parse(iso) - 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const shownBy = (doc) => ({
  run: doc.run, ...(doc.update ? { update: true } : {}),
  days: doc.days.filter((e) => e.date >= runDay(doc.run)).slice(0, 6),
});
const thisRun = new Date(RUN).toISOString();
const history = [...(published.run ? [shownBy(published)] : []), ...(published.history || [])]
  .filter((h, i, all) => h.run !== thisRun && all.findIndex((x) => x.run === h.run) === i)
  .slice(0, 4);
const live = new Set([...days, ...history.flatMap((h) => h.days)].map((e) => e.file));
for (const f of readdirSync(SITE)) if (f.endsWith('.bin.gz') && !live.has(f)) unlinkSync(join(SITE, f));
writeFileSync(join(SITE, 'latest.json'), JSON.stringify({
  model: 'Stormycast', run: thisRun, ...(UPDATE ? { update: true } : {}), hazards: HAZARDS,
  grid: { nx: NX, ny: NY, west: -180, south: -90, north: 90, step: 0.5, rows: 'north first' }, days, history,
}));
writeFileSync(join(SITE, '_headers'), '/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=600\n');
writeFileSync(join(SITE, '404.html'), '<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found.</p>\n');
writeFileSync(join(SITE, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Stormycast</title><p>Stormycast severe outlooks, for <a href="https://nexradar.pages.dev/">Nexradar</a>.</p>\n');
console.log('wrote site-data/stormycast/site');

// The outlooks as GeoJSON for other apps (stormycast-geojson.mjs). A failure here never
// stops the publishing.
try {
  const { writeGeojson } = await import('./stormycast-geojson.mjs');
  console.log(`GeoJSON outlooks: ${writeGeojson(SITE)} files`);
} catch (err) { console.log('GeoJSON outlooks failed:', err.message); }

// The scorecard (stormycast-score.mjs): this run's days noted at the US scoring points, and
// the days now over scored against SPC's reports. A failure here never stops the publishing.
if (!args.includes('--no-score')) {
  try {
    const { scoreStormycast } = await import('./stormycast-score.mjs');
    await scoreStormycast(SITE);
  } catch (err) { console.log('scoring failed:', err.message); }
}

if (args.includes('--deploy')) {
  writeFileSync(join(DIR, 'wrangler.jsonc'), '// Stormycast\'s days (scripts/stormycast-run.mjs --deploy): site/, deployed as the\n'
    + '// `stormycast` branch of the nexradar Pages project, apart from the app\'s own deployment.\n'
    + '{\n  "name": "nexradar",\n  "pages_build_output_dir": "./site",\n  "compatibility_date": "2026-10-01"\n}\n');
  const r = spawnSync('npx wrangler pages deploy --branch stormycast --commit-dirty=true', { cwd: DIR, stdio: 'inherit', shell: true });
  if (r.status) process.exit(r.status);
}
