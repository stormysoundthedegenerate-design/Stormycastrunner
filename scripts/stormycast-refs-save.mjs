// Keeps REFS's (the RRFS ensemble's) day 1–2 storm inputs for training Stormycast on them later,
// beside stormycast-rrfs-save.mjs: each 00Z run's five members, days 1 and 2 (forecast hours
// 13–36 and 37–60), as REFS_FEATURES (stormycast/refs.mjs) at the US scoring points.
//
//   node scripts/stormycast-refs-save.mjs <folder>
//
// Writes <folder>/refs-<YYYYMMDD>00.f32.gz (gzipped float32 records: day (days since 1970,
// the day starting 12Z), f0, member index, then points × features, NaN where none),
// <folder>/FORMAT-refs.json and the run's RRFS version in <folder>/versions.json. Runs
// already saved are skipped; a run is saved only with all members and both days.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { neighbourhoods } from './stormycast/hrrr.mjs';
import { refsDay, refsHas, REFS_FEATURES, REFS_MEMBERS, refsFetched } from './stormycast/refs.mjs';
import { SCORE_POINTS } from './stormycast/score-points.mjs';
import { rrfsVersion, noteVersion } from './stormycast/rrfs-version.mjs';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node scripts/stormycast-refs-save.mjs <folder>');
mkdirSync(OUT, { recursive: true });
const H = 3600e3;
const pad = (n) => String(n).padStart(2, '0');
writeFileSync(join(OUT, 'FORMAT-refs.json'), JSON.stringify({
  about: 'REFS (RRFS ensemble) 00Z runs, members m001–m005, days 1–2 (12Z to 12Z), Stormycast REFS inputs at its US scoring points. Records: day (days since 1970), f0, member index, then points × features float32, NaN where none.',
  members: REFS_MEMBERS, points: SCORE_POINTS, features: REFS_FEATURES, days: 2,
}));

const version = await rrfsVersion();
const today = Math.floor(Date.now() / 864e5) * 864e5;
let hoods = null;
for (const run of [today - 864e5, today]) {
  const d = new Date(run);
  const name = `refs-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}00.f32.gz`;
  if (existsSync(join(OUT, name))) { console.log(name, 'already saved'); continue; }
  if (!(await refsHas(run, REFS_MEMBERS.at(-1), 60))) { console.log(name, 'not out (or gone)'); continue; }
  hoods ||= neighbourhoods(SCORE_POINTS.map(([lat, lon]) => ({ lat, lon })));
  const t0 = Date.now();
  const parts = [];
  let ok = true;
  for (let m = 0; m < REFS_MEMBERS.length && ok; m++) {
    for (let k = 0; k < 2; k++) {
      const f0 = 12 + 24 * k;
      const X = await refsDay(run, REFS_MEMBERS[m], f0, hoods).catch((err) => { console.log(`  ${REFS_MEMBERS[m]} day ${k + 1} failed:`, err.message); return null; });
      if (!X) { console.log(`  ${REFS_MEMBERS[m]} day ${k + 1}: missing`); ok = false; break; }
      const rec = new Float32Array(3 + X.length);
      rec[0] = Math.floor((run + (f0 - 12) * H) / 864e5); rec[1] = f0; rec[2] = m; rec.set(X, 3);
      parts.push(Buffer.from(rec.buffer));
    }
  }
  if (!ok) { console.log(name, 'incomplete, not saved'); continue; }
  writeFileSync(join(OUT, name), gzipSync(Buffer.concat(parts), { level: 9 }));
  await noteVersion(OUT, name, version);
  console.log(`${name}: ${parts.length} member-days, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(refsFetched() / 1e6).toFixed(0)} MB read, RRFS ${version}`);
}
