// Fetches the days already published (https://stormycast.nexradar.pages.dev) into
// site-data/stormycast/site before a run, so a deploy — which replaces the whole branch —
// keeps the earlier days as well as adding the new ones.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://stormycast.nexradar.pages.dev';
const SITE = join(dirname(fileURLToPath(import.meta.url)), '../site-data/stormycast/site');
mkdirSync(SITE, { recursive: true });

const r = await fetch(`${BASE}/latest.json`, { cache: 'no-store', signal: AbortSignal.timeout(30000) }).catch(() => null);
if (!r?.ok) {
  console.log('nothing published yet; starting fresh');
  process.exit(0);
}
const doc = await r.json();
let n = 0;
for (const e of doc.days || []) {
  if (!/^\d{8}-\d{10}\.bin\.gz$/.test(e.file)) continue;
  const f = await fetch(`${BASE}/${e.file}`, { signal: AbortSignal.timeout(60000) }).catch(() => null);
  if (!f?.ok) { console.log('missing', e.file); continue; }
  // Saved as published (gzipped); a server along the way may have unpacked it.
  let b = new Uint8Array(await f.arrayBuffer());
  if (b[0] !== 0x1f || b[1] !== 0x8b) b = (await import('node:zlib')).gzipSync(b, { level: 9 });
  writeFileSync(join(SITE, e.file), b);
  n++;
}
// The scorecard and its notes of earlier runs (stormycast-score.mjs) carry on from run to run.
for (const name of ['scores.json', 'score-pending.json']) {
  const f = await fetch(`${BASE}/${name}`, { cache: 'no-store', signal: AbortSignal.timeout(60000) }).catch(() => null);
  if (f?.ok) { writeFileSync(join(SITE, name), Buffer.from(await f.arrayBuffer())); console.log('pulled', name); }
}
// Only days whose file came down are kept.
writeFileSync(join(SITE, 'latest.json'), JSON.stringify(doc));
console.log(`pulled ${n} of ${(doc.days || []).length} days (run ${doc.run})`);
