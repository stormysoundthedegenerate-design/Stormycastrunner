// Keeps RRFS's day 1–3 storm inputs for training Stormycast on it later. NOMADS holds only
// RRFS's last two days, so each 00Z run is saved while it is there: its days 1, 2 and 3
// (forecast hours 13–36, 37–60 and 61–84 for the 12Z-to-12Z days), as the HRRR model's
// inputs (stormycast/hrrr.mjs HRRR_FEATURES, read from RRFS's own fields), at the 3,529
// US points the daily scores use. Nothing else is kept, about 1–2 MB a run.
//
//   node scripts/stormycast-rrfs-save.mjs <folder>
//
// Writes <folder>/rrfs-<YYYYMMDD>00.f32.gz (gzipped float32: per day, the day (days since
// 1970, the day starting 12Z), the hours from the run to its start (f0), then points ×
// features, NaN where a point has none) and <folder>/FORMAT.json. Runs already saved are
// skipped, so it can run every time the daily runner does.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { hrrrDay, hrrrHas, neighbourhoods, HRRR_FEATURES, hrrrFetched, setCamSource } from './stormycast/hrrr.mjs';
import { SCORE_POINTS } from './stormycast/score-points.mjs';
import { rrfsVersion, noteVersion } from './stormycast/rrfs-version.mjs';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node scripts/stormycast-rrfs-save.mjs <folder>');
mkdirSync(OUT, { recursive: true });
setCamSource('rrfs');
const H = 3600e3;
const pad = (n) => String(n).padStart(2, '0');
const NF = HRRR_FEATURES.length;
const pts = SCORE_POINTS.map(([lat, lon]) => ({ lat, lon }));
writeFileSync(join(OUT, 'FORMAT.json'), JSON.stringify({
  about: 'RRFS 00Z runs, days 1–3 (12Z to 12Z), Stormycast HRRR-model inputs at its US scoring points. Per day: day (days since 1970), f0 (hours from the run to the day start), then points × features float32, NaN where none.',
  points: SCORE_POINTS, features: HRRR_FEATURES, days: 3,
}));

const version = await rrfsVersion();
const today = Math.floor(Date.now() / 864e5) * 864e5;
let hoods = null;
for (const run of [today - 864e5, today]) {
  const d = new Date(run);
  const name = `rrfs-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00.f32.gz`;
  if (existsSync(join(OUT, name))) { console.log(name, 'already saved'); continue; }
  if (!(await hrrrHas(run, 84))) { console.log(name, 'not out (or gone)'); continue; }
  hoods ||= neighbourhoods(pts);
  const t0 = Date.now();
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const f0 = 12 + 24 * k;
    const X = await hrrrDay(run, f0, hoods).catch((err) => { console.log(`  day ${k + 1} failed:`, err.message); return null; });
    if (!X) { console.log(`  day ${k + 1}: missing fields`); continue; }
    const rec = new Float32Array(2 + X.length);
    rec[0] = Math.floor((run + f0 * H - 12 * H) / 864e5); rec[1] = f0; rec.set(X, 2);
    parts.push(Buffer.from(rec.buffer));
  }
  if (!parts.length) { console.log(name, 'nothing read'); continue; }
  writeFileSync(join(OUT, name), gzipSync(Buffer.concat(parts), { level: 9 }));
  await noteVersion(OUT, name, version);
  console.log(`${name}: ${parts.length} days, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(hrrrFetched() / 1e6).toFixed(0)} MB read`);
}
