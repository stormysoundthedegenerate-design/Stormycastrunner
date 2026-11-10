// Stormycast's daily scorecard. Each run's days are noted at the US scoring points (3,529
// points of the lower 48, scripts/stormycast/score-points.mjs) in score-pending.json; once a
// day is over and SPC's storm reports are in, each forecast made for it is scored against
// them — a report within 40 km (SPC's "within 25 miles") during the day — beside SPC's own
// 13Z day 1 outlook on the same points. Days are scored again while late reports trickle in
// (to a week after), then kept as they are in scores.json, which the website reads.
//
// Run by stormycast-run.mjs after each run (so every run's days are noted, not only the
// newest for each date), or alone:
//
//   node scripts/stormycast-score.mjs
//
// scores.json: { updated, points, hazards, days: { YYYYMMDD: { reports, final, forecasts:
// [{ src: 'stormycast' | 'spc13z', run, lead, hz: { <hazard>: [n, events, sse, sumP, rel] } }] } } },
// rel = [count, events, sum of chances] in the bins of REL_EDGES (percent). Preliminary reports seldom carry a
// tornado's rating, so EF2+ is not scored; thunder is not (no lightning truth here yet).

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCORE_POINTS } from './stormycast/score-points.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NX = 720;
const H = 3600e3;
const D = 864e5;
export const SCORED = ['tor', 'hail', 'sighail', 'wind', 'sigwind'];
const SPC_KIND = { tor: 'torn', hail: 'hail', wind: 'wind' };
const REL_EDGES = [0, 2, 5, 10, 15, 30, 45, 60];
const NP = SCORE_POINTS.length;
const cellOf = SCORE_POINTS.map(([lat, lon]) => Math.round((90 - lat) / 0.5) * NX + Math.round((lon + 180) / 0.5));
const km = (la1, lo1, la2, lo2) => Math.hypot((la1 - la2) * 111.2, (lo1 - lo2) * 111.2 * Math.cos((la1 * Math.PI) / 180));
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
const timeOf = (date) => Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
const UA = { 'user-agent': 'Stormycast scoring (once a day)' };

async function text(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (r?.ok) return r.text();
    if (r && r.status === 404) return null;
    await new Promise((ok) => setTimeout(ok, 3000));
  }
  return null;
}

/** SPC's preliminary reports for a convective day (12Z to 12Z): { tor, hail, sighail, wind, sigwind: [[lat, lon]] }, or null. */
async function reportsOf(date) {
  const yymmdd = date.slice(2);
  const out = { tor: [], hail: [], sighail: [], wind: [], sigwind: [] };
  for (const kind of ['torn', 'hail', 'wind']) {
    const t = await text(`https://www.spc.noaa.gov/climo/reports/${yymmdd}_rpts_filtered_${kind}.csv`);
    if (t == null) return null;
    for (const line of t.split('\n').slice(1)) {
      // Comments may hold commas; the first seven columns don't.
      const f = line.split(',');
      const lat = +f[5];
      const lon = +f[6];
      if (!(lat > 20 && lat < 55) || !(lon < -60 && lon > -130)) continue;
      const mag = +f[1];
      if (kind === 'torn') out.tor.push([lat, lon]);
      else if (kind === 'hail') {
        if (!(mag >= 100)) continue; // hundredths of an inch
        out.hail.push([lat, lon]);
        if (mag >= 200) out.sighail.push([lat, lon]);
      } else {
        out.wind.push([lat, lon]);
        if (mag >= 75) out.sigwind.push([lat, lon]); // mph: 65 kt
      }
    }
  }
  return out;
}

function labelsOf(reps) {
  const lab = {};
  for (const h of SCORED) {
    const y = new Uint8Array(NP);
    for (let p = 0; p < NP; p++) {
      const [lat, lon] = SCORE_POINTS[p];
      for (const [la, lo] of reps[h]) if (Math.abs(la - lat) < 0.5 && km(lat, lon, la, lo) <= 40) { y[p] = 1; break; }
    }
    lab[h] = y;
  }
  return lab;
}

// --- SPC's day 1 outlook (13Z) at the points ----------------------------------------------------
const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolys = (polys, x, y) => polys.some((poly) => inRing(poly[0], x, y) && !poly.slice(1).some((hole) => inRing(hole, x, y)));
async function spcAt(date, h) {
  const t = await text(`https://www.spc.noaa.gov/products/outlook/archive/${date.slice(0, 4)}/day1otlk_${date}_1300_${SPC_KIND[h]}.lyr.geojson`);
  if (t == null) return null;
  const doc = JSON.parse(t);
  const v = new Uint8Array(NP);
  for (const f of doc.features || []) {
    const pct = +f.properties?.DN;
    if (!(pct > 0) || !/^0\.\d+$/.test(f.properties?.LABEL || '')) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (let p = 0; p < NP; p++) if (pct > v[p] && inPolys(polys, SCORE_POINTS[p][1], SCORE_POINTS[p][0])) v[p] = pct;
  }
  return v;
}

function scoreOf(v, y) {
  let n = 0; let ev = 0; let sse = 0; let sumP = 0;
  const rel = REL_EDGES.map(() => [0, 0, 0]);
  for (let p = 0; p < NP; p++) {
    if (v[p] === 255) continue; // no forecast here
    const pr = v[p] / 100;
    n++; ev += y[p]; sse += (pr - y[p]) ** 2; sumP += pr;
    let b = 0;
    while (b + 1 < REL_EDGES.length && v[p] >= REL_EDGES[b + 1]) b++;
    rel[b][0]++; rel[b][1] += y[p]; rel[b][2] += pr;
  }
  return [n, ev, +sse.toFixed(4), +sumP.toFixed(3), rel.map(([c, e, p]) => [c, e, +p.toFixed(3)])];
}

/**
 * Notes the site's day files in score-pending.json and scores every day that is over.
 * `site`: the folder of latest.json and the day files.
 */
export async function scoreStormycast(site, now = Date.now()) {
  const pendF = join(site, 'score-pending.json');
  const scoreF = join(site, 'scores.json');
  const pending = existsSync(pendF) ? JSON.parse(readFileSync(pendF, 'utf8')) : {};
  const scores = existsSync(scoreF) ? JSON.parse(readFileSync(scoreF, 'utf8')) : { days: {} };
  let hazards = null;
  try { hazards = JSON.parse(readFileSync(join(site, 'latest.json'), 'utf8')).hazards; } catch { /* none */ }

  // Each day file not yet noted: its values at the points (255 where it has none).
  for (const f of readdirSync(site)) {
    const m = /^(\d{8})-(\d{10})\.bin\.gz$/.exec(f);
    if (!m || pending[`${m[1]}|${m[2]}`] || scores.days[m[1]]?.final) continue;
    let bytes = readFileSync(join(site, f));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const hz = hazards || ['tor', 'sigtor', 'hail', 'sighail', 'wind', 'sigwind', 'thunder'];
    const NPG = bytes.length / hz.length;
    const vals = {};
    for (const h of SCORED) {
      const at = hz.indexOf(h);
      if (at < 0) continue;
      const v = new Uint8Array(NP);
      for (let p = 0; p < NP; p++) v[p] = bytes[at * NPG + cellOf[p]];
      vals[h] = Buffer.from(v).toString('base64');
    }
    const run = Date.UTC(+m[2].slice(0, 4), +m[2].slice(4, 6) - 1, +m[2].slice(6, 8), +m[2].slice(8, 10));
    pending[`${m[1]}|${m[2]}`] = { date: m[1], run: m[2], lead: Math.round((timeOf(m[1]) + 12 * H - run) / H), vals };
  }

  // Days over (their 12Z–12Z window and half a day more for the reports), newest week again.
  const dates = [...new Set(Object.values(pending).map((e) => e.date))].sort();
  for (const date of dates) {
    const t = timeOf(date);
    if (now < t + 2 * D) continue;
    const final = now >= t + 8 * D;
    const reps = await reportsOf(date);
    if (!reps) { console.log(`score ${date}: no SPC reports file yet`); continue; }
    const lab = labelsOf(reps);
    const forecasts = [];
    for (const e of Object.values(pending).filter((x) => x.date === date).sort((a, b) => a.lead - b.lead)) {
      const hz = {};
      for (const [h, b64] of Object.entries(e.vals)) hz[h] = scoreOf(new Uint8Array(Buffer.from(b64, 'base64')), lab[h]);
      forecasts.push({ src: 'stormycast', run: e.run, lead: e.lead, hz });
    }
    const spc = {};
    for (const h of Object.keys(SPC_KIND)) {
      const v = await spcAt(date, h).catch(() => null);
      if (v) spc[h] = scoreOf(v, lab[h]);
    }
    if (Object.keys(spc).length) forecasts.push({ src: 'spc13z', run: `${date}13`, lead: -1, hz: spc });
    scores.days[date] = { reports: Object.fromEntries(SCORED.map((h) => [h, reps[h].length])), final, forecasts };
    const d1 = forecasts.find((f) => f.src === 'stormycast' && f.lead === 12);
    console.log(`score ${date}${final ? ' (final)' : ''}: ${SCORED.map((h) => `${h} ${reps[h].length}`).join(', ')} reports; ${forecasts.length} forecasts${d1 ? `; day 1 tor events ${d1.hz.tor?.[1]}` : ''}`);
    if (final) for (const k of Object.keys(pending)) if (pending[k].date === date) delete pending[k];
  }
  // Pending notes of days long gone (no reports ever came) are dropped; scores kept two years.
  for (const k of Object.keys(pending)) if (now > timeOf(pending[k].date) + 15 * D) delete pending[k];
  for (const d of Object.keys(scores.days)) if (now > timeOf(d) + 730 * D) delete scores.days[d];
  scores.updated = new Date(now).toISOString();
  scores.points = NP;
  scores.hazards = SCORED;
  scores.relEdges = REL_EDGES;
  scores.days = Object.fromEntries(Object.entries(scores.days).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  writeFileSync(pendF, JSON.stringify(pending));
  writeFileSync(scoreF, JSON.stringify(scores));
  return scores;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await scoreStormycast(join(root, 'site-data/stormycast/site'));
}
