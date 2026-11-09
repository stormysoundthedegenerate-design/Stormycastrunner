// Stormycast: Nexradar's own severe outlook, a chance of a tornado, hail or wind report
// within 40 km during a day, for anywhere, from the environment ECMWF forecasts.
//
// The models (stormycast-model.mjs, fitted by scripts/stormycast-fit.mjs on ERA5 and SPC's
// reports) are run each day on the PC (scripts/stormycast-run.mjs), which publishes a
// lattice a day (0.5°, percent per hazard) on the `stormycast` branch of the Pages project.
// This file reads those for the outlook hook (app.mjs addOutlooks), and holds the
// arithmetic of the trees for the runner.

import { latticeAreas } from './ml-outlooks.mjs';

export const STORMYCAST_HAZARDS = ['tor', 'sigtor', 'hail', 'sighail', 'wind', 'sigwind'];

/**
 * A forecast's input put on ERA5's scale (the model's `maps`: [forecast, ERA5] quantile
 * pairs, linear between, shifted beyond the ends).
 */
export function mapValue(m, v) {
  if (!m || !Number.isFinite(v)) return v;
  if (v <= m[0][0]) return v + (m[0][1] - m[0][0]);
  for (let k = 1; k < m.length; k++) {
    if (v <= m[k][0]) {
      const [x0, y0] = m[k - 1];
      const [x1, y1] = m[k];
      return y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return v + (m.at(-1)[1] - m.at(-1)[0]);
}

function onCurve(c, p) {
  for (let i = 1; i < c.length; i++) {
    if (p <= c[i][0]) {
      const [x0, y0] = c[i - 1];
      const [x1, y1] = c[i];
      return x1 > x0 ? y0 + ((p - x0) / (x1 - x0)) * (y1 - y0) : y1;
    }
  }
  return c.at(-1)[1];
}

/**
 * A model's chance (0–1) for a feature vector (in STORMYCAST.features' order). `lead`: hours
 * from the run to the point's afternoon snapshot; a model calibrated by lead (`curves`,
 * [hours, curve] pairs) blends its two nearest curves, so later days come out as unsure as
 * they really are.
 */
export function chanceOf(model, x, lead = null) {
  return calibrated(model, rawChance(model, x), lead);
}

/** A model's raw chance (0–1) from its trees, before calibration. */
export function rawChance(model, x) {
  let z = model.base;
  for (const t of model.trees) {
    let n = t[0];
    while (n.length === 4) { const v = x[n[0]]; n = t[v <= n[1] || Number.isNaN(v) ? n[2] : n[3]]; }
    z += n[0];
  }
  return 1 / (1 + Math.exp(-z));
}

/** A model's smoothing width (km) at a lead (hours): its `blur` pairs, linear between; 0 if none. */
export function blurAt(model, lead) {
  const b = model.blur;
  if (!b?.length) return 0;
  if (lead <= b[0][0]) return b[0][1];
  for (let i = 1; i < b.length; i++) if (lead <= b[i][0]) return b[i - 1][1] + ((lead - b[i - 1][0]) / (b[i][0] - b[i - 1][0])) * (b[i][1] - b[i - 1][1]);
  return b.at(-1)[1];
}

/** A raw chance through the model's calibration for that lead. */
export function calibrated(model, p, lead = null) {
  const cs = model.curves;
  if (lead == null || !cs?.length) return onCurve(model.curve, p);
  if (lead <= cs[0][0]) return onCurve(cs[0][1], p);
  for (let i = 1; i < cs.length; i++) {
    if (lead <= cs[i][0]) {
      const f = (lead - cs[i - 1][0]) / (cs[i][0] - cs[i - 1][0]);
      return (1 - f) * onCurve(cs[i - 1][1], p) + f * onCurve(cs[i][1], p);
    }
  }
  return onCurve(cs.at(-1)[1], p);
}

// --- reading the published days ------------------------------------------------------------

const BASE = 'https://stormycast.nexradar.pages.dev';
const TOR = [[2, '#008b00'], [5, '#8b4726'], [10, '#ffc800'], [15, '#ff0000'], [30, '#ff00ff'], [45, '#912cee'], [60, '#104e8b']];
const SEVERE = [[5, '#8b4726'], [15, '#ffc800'], [30, '#ff0000'], [45, '#ff00ff'], [60, '#912cee']];
const SIG = [[1, '#5fb85f'], ...TOR];
// SPC's thunder levels and greens.
const THUNDER = [[10, '#c1e9c1'], [40, '#66c57d'], [70, '#2e8b57']];
const KINDS = [
  { id: 'tornado', hazard: 'tor', label: 'Tornado', name: 'tornado', levels: TOR },
  { id: 'wind', hazard: 'wind', label: 'Wind', name: 'severe wind', levels: SEVERE },
  { id: 'hail', hazard: 'hail', label: 'Hail', name: 'severe hail', levels: SEVERE },
  { id: 'sig_tornado', hazard: 'sigtor', label: 'EF2+', name: 'EF2+ tornado', levels: SIG },
  { id: 'sig_wind', hazard: 'sigwind', label: '65 kt+', name: '65 kt+ wind', levels: SIG },
  { id: 'sig_hail', hazard: 'sighail', label: '2 in+', name: '2 in+ hail', levels: SIG },
  { id: 'thunder', hazard: 'thunder', label: 'Thunder', name: 'thunder', levels: THUNDER },
];

let latest = null; // { at, doc }
const days = new Map(); // date -> Promise<{ doc, bytes }>
const areasKept = new Map();

// The PC's own copy (server.mjs /stormycast-data/, made by the runner there) when it is
// newer, else the website's; anywhere else, only the website's answers.
const LOCAL = '/stormycast-data';
async function docAt(base) {
  const r = await fetch(`${base}/latest.json`, { cache: 'no-cache', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Stormycast answered ${r.status}`);
  const doc = await r.json();
  if (!Array.isArray(doc?.days)) throw new Error('not Stormycast');
  return { ...doc, base };
}
async function latestDoc() {
  if (latest && Date.now() - latest.at < 10 * 60e3) return latest.doc;
  const [here, site] = await Promise.allSettled([docAt(LOCAL), docAt(BASE)]);
  const ok = [here, site].filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw site.reason || here.reason;
  // The newer run; on a tie, the PC's own (made here, so at least as new).
  const doc = ok.sort((a, b) => (a.run < b.run ? 1 : a.run > b.run ? -1 : 0))[0];
  latest = { at: Date.now(), doc };
  return doc;
}

async function dayBytes(base, entry) {
  const key = `${base}:${entry.date}:${entry.run}`;
  if (!days.has(key)) {
    days.set(key, (async () => {
      const r = await fetch(`${base}/${entry.file}`, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`Stormycast answered ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      // Still gzipped unless a server along the way unpacked it.
      if (buf[0] !== 0x1f || buf[1] !== 0x8b) return buf;
      return new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    })());
    days.get(key).catch(() => days.delete(key));
    if (days.size > 8) days.delete(days.keys().next().value);
  }
  return days.get(key);
}

/** The viewer's date n − 1 days on, as YYYYMMDD. */
function dateOf(day) {
  const d = new Date(Date.now() + (day - 1) * 864e5);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function stormycastAreas(day, kindId) {
  const kind = KINDS.find((k) => k.id === kindId) || KINDS[0];
  const doc = await latestDoc();
  const want = dateOf(day);
  const entry = doc.days.find((d) => d.date === want) || (day === 1 ? doc.days[0] : null);
  if (!entry) throw new Error('no run out yet for that day');
  const key = `${entry.date}:${entry.run}:${kind.id}`;
  let areas = areasKept.get(key);
  if (!areas) {
    const bytes = await dayBytes(doc.base, entry);
    const { nx, ny, west, south, step } = doc.grid;
    // Each day's own list; days from before it was recorded have the first six.
    const h = (entry.hazards || STORMYCAST_HAZARDS).indexOf(kind.hazard);
    if (h < 0) throw new Error(`no ${kind.name} in this run`);
    // Stored north row first; the lattice wants the south row first.
    const z = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = bytes[h * nx * ny + (ny - 1 - j) * nx + i];
    areas = latticeAreas(z, nx, ny, kind.levels, { west, south, east: west + (nx - 1) * step, north: south + (ny - 1) * step }, step, 3);
    areasKept.set(key, areas);
    if (areasKept.size > 24) areasKept.delete(areasKept.keys().next().value);
  }
  const start = Date.UTC(+entry.date.slice(0, 4), +entry.date.slice(4, 6) - 1, +entry.date.slice(6, 8));
  return areas.filter(([, , polys]) => polys.length).map(([L, colour, polys]) => ({
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: polys },
    properties: {
      label: `${L}%`, detail: `${L}% ${kind.name}`, fill: colour, stroke: colour, day, kind: kind.id, kindLabel: kind.label,
      valid: new Date(start).toISOString(), expires: new Date(start + 864e5).toISOString(), run: entry.run,
      machine: 'Stormycast',
    },
  }));
}

/** Stormycast, for the outlook hook. */
export const STORMYCAST = {
  id: 'stormycast',
  label: 'Stormycast',
  note: "Nexradar's own: chances within 25 mi, worldwide. Each place's own day.",
  days: 5,
  kinds: KINDS.map(({ id, label }) => ({ id, label })),
  load: stormycastAreas,
  credit: 'Stormycast by stormy_sound, Nexradar: NOAA HRRR over the US; GOES GLM lightning; ECMWF open data (CC BY 4.0); contains modified Copernicus Climate Change Service information (ERA5); SPC storm reports',
};
