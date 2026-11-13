// Keeps every Stormycast run for the record: each run's day files, as published at
// https://stormycast.nexradar.pages.dev, go to the `archive` branch (checked out at the folder
// given) under runs/YYYY/MM/YYYYMMDDHH/, with a run.json saying what they are. Anything live
// and not yet archived is added — this run, and any whose own archiving failed — so it can
// be run again safely. Nothing here is shown on the website.
//
//   node scripts/stormycast-archive.mjs <archive-folder>

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BASE = 'https://stormycast.nexradar.pages.dev';
const OUT = process.argv[2];
if (!OUT) throw new Error('usage: stormycast-archive.mjs <archive-folder>');

const r = await fetch(`${BASE}/latest.json`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
if (!r.ok) throw new Error(`latest.json: ${r.status}`);
const doc = await r.json();

// Every day file live now, by the run that made it (named in the file: date-YYYYMMDDHH).
const byRun = new Map();
for (const e of [...(doc.days || []), ...(doc.history || []).flatMap((h) => h.days || [])]) {
  const m = /^(\d{8})-(\d{10})\.bin\.gz$/.exec(e.file || '');
  if (!m) continue;
  const list = byRun.get(m[2]) || byRun.set(m[2], new Map()).get(m[2]);
  list.set(e.file, e);
}

let added = 0;
for (const [run, files] of [...byRun].sort()) {
  const dir = join(OUT, 'runs', run.slice(0, 4), run.slice(4, 6), run);
  mkdirSync(dir, { recursive: true });
  const metaF = join(dir, 'run.json');
  const meta = existsSync(metaF) ? JSON.parse(readFileSync(metaF, 'utf8')) : { days: [] };
  let changed = false;
  for (const [file, e] of files) {
    if (existsSync(join(dir, file))) continue;
    const f = await fetch(`${BASE}/${file}`, { signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!f?.ok) { console.log('missing', file); continue; }
    let b = new Uint8Array(await f.arrayBuffer());
    if (b[0] !== 0x1f || b[1] !== 0x8b) b = gzipSync(b, { level: 9 }); // kept gzipped, as published
    writeFileSync(join(dir, file), b);
    meta.days = [...meta.days.filter((d) => d.file !== file), e].sort((a, b2) => (a.date < b2.date ? -1 : 1));
    changed = true;
    added++;
  }
  if (!changed) continue;
  const first = meta.days[0] || {};
  Object.assign(meta, {
    model: 'Stormycast',
    run: first.run || `${run.slice(0, 4)}-${run.slice(4, 6)}-${run.slice(6, 8)}T${run.slice(8, 10)}:00:00.000Z`,
    ...(meta.days.some((d) => d.update) ? { update: true, base: meta.days.find((d) => d.base)?.base } : {}),
    hazards: doc.hazards,
    grid: doc.grid,
  });
  writeFileSync(metaF, `${JSON.stringify(meta, null, 1)}\n`);
}

// runs/index.json: every archived run, oldest first, for the website's archive viewer:
// { run, path, update?, dates }.
const index = [];
const runsDir = join(OUT, 'runs');
if (existsSync(runsDir)) {
  for (const y of readdirSync(runsDir).filter((d) => /^\d{4}$/.test(d)).sort()) {
    for (const m of readdirSync(join(runsDir, y)).filter((d) => /^\d\d$/.test(d)).sort()) {
      for (const run of readdirSync(join(runsDir, y, m)).filter((d) => /^\d{10}$/.test(d)).sort()) {
        const f = join(runsDir, y, m, run, 'run.json');
        if (!existsSync(f)) continue;
        const meta = JSON.parse(readFileSync(f, 'utf8'));
        index.push({ run: meta.run, path: `runs/${y}/${m}/${run}`, ...(meta.update ? { update: true } : {}), dates: meta.days.map((d) => d.date) });
      }
    }
  }
  writeFileSync(join(runsDir, 'index.json'), JSON.stringify(index));
}

const readme = join(OUT, 'README.md');
if (!existsSync(readme)) {
  writeFileSync(readme, `# Stormycast archive

Every Stormycast run, kept for the record (not shown on the website). One folder a run:
\`runs/YYYY/MM/YYYYMMDDHH/\`, holding

- \`run.json\`: the run (UTC), whether it is a day 1 update (and the run it updated), the
  hazards in each file, the grid, and one entry a day file;
- \`<date>-<run>.bin.gz\`: a day's chances (the place's own 6 am–6 am day), gzipped bytes of
  percent, one 720 × 361 grid a hazard in the order \`hazards\` gives: rows from 90°N, columns
  from 180°W, 0.5°.

A day 1 update's file is that day whole: the updated places merged into the run it updated.

\`runs/index.json\` lists every run here (its folder and the dates it has), for the archive
viewer on https://stormycast.pages.dev.

Forecasts © Stormycast by stormy_sound, Nexradar, CC BY 4.0 (see MODEL_LICENSE on main).
`);
}
console.log(`archived ${added} file(s) from ${byRun.size} live run(s)`);
