// Which RRFS version NOAA is running now, from the NOMADS directory listing (its vX.Y
// folders beside prod/), so saved runs record the model that made them and training or the
// RRFS-to-HRRR translation can be redone when a new version comes in. null if unreadable.
export async function rrfsVersion() {
  try {
    const r = await fetch('https://nomads.ncep.noaa.gov/pub/data/nccf/com/rrfs/', { headers: { 'user-agent': 'Stormycast RRFS archive (once a day)' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    const v = [...(await r.text()).matchAll(/href="v(\d+)\.(\d+)(?:\.(\d+))?\/"/g)].map((m) => [+m[1], +m[2], +(m[3] || 0)]);
    if (!v.length) return null;
    v.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return `v${v.at(-1).join('.').replace(/\.0$/, '')}`;
  } catch { return null; }
}

/** Notes a saved run's version in <folder>/versions.json ({ file: version }). */
export async function noteVersion(folder, file, version) {
  const { readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const f = join(folder, 'versions.json');
  const all = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  all[file] = version || 'unknown';
  writeFileSync(f, JSON.stringify(all, null, 1));
}
