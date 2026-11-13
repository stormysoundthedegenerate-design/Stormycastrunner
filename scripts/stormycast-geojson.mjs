// Stormycast's outlooks as GeoJSON, for other apps: each day and hazard a FeatureCollection
// of its areas, one feature a level (everything at that chance or more, lowest first), with
// properties in the same shape as SPC's own outlook GeoJSON (DN, LABEL, LABEL2, fill, stroke,
// ISSUE), so an app that draws SPC's can draw these. Written beside latest.json:
//
//   geojson/index.json                    what is there: the run, the days, every file
//   geojson/<YYYYMMDD>/<hazard>.geojson   by date (each place's own 6 am–6 am solar day)
//   geojson/day<N>_<hazard>.geojson       the same, by the run's day number: day 1 is the
//                                         date twelve hours after the run's hour
//
// Hazards: tor, sigtor (EF2+), hail (1 in+), sighail (2 in+), wind (50 kt+), sigwind
// (65 kt+), thunder. Chances are within 25 miles of a point. The contours are the website's
// own (core/contour-areas.mjs), at its levels and colours (core/stormycast-levels.mjs).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { latticeAreas } from '../public/js/core/contour-areas.mjs';
import { HAZARD_LEVELS } from '../public/js/core/stormycast-levels.mjs';

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const dash = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const spcTime = (iso) => iso.slice(0, 16).replace(/[-T:]/g, ''); // YYYYMMDDHHmm, as SPC's ISSUE

/**
 * Writes site/geojson/ from site/latest.json's days (those from the day before the run on)
 * and their day files. Returns how many files were written.
 */
export function writeGeojson(site) {
  const doc = JSON.parse(readFileSync(join(site, 'latest.json'), 'utf8'));
  const out = join(site, 'geojson');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { nx, ny, west, south, step } = doc.grid;
  const runMs = Date.parse(doc.run);
  const day1 = Date.parse(dash(ymd(runMs + 12 * 3600e3)));
  // From the day before day 1, which is still running in the west when a run comes out.
  const from = ymd(day1 - 864e5);
  const days = doc.days.filter((e) => e.date >= from).slice(0, 7);
  const index = {
    model: 'Stormycast',
    version: 1, // the files' shape; a change that would break a reader gets a new number
    run: doc.run,
    ...(doc.update ? { update: true } : {}),
    written: new Date().toISOString(),
    // Runs come every six hours: past this, something has stopped, and the days below
    // should not be shown as current.
    stale_after: new Date(runMs + 24 * 3600e3).toISOString(),
    about: 'Chance (percent) of each hazard within 25 miles (40 km) of a point, over each place\'s own day: 6 am to 6 am local solar time. Day 1 is the date twelve hours after the run\'s hour. Each file is a FeatureCollection, one feature a level (everything at that chance or more), lowest first. Experimental and automated, not an official forecast.',
    credit: 'Stormycast by stormy_sound, Nexradar',
    license: 'CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/): credit "Stormycast by stormy_sound, Nexradar" with a link to https://nexradar.pages.dev',
    sources: 'Made from ECMWF open data (CC BY 4.0), NOAA GEFS and HRRR; contains modified Copernicus Climate Change Service information (ERA5).',
    days: [],
  };
  let written = 0;
  for (const e of days) {
    if (!existsSync(join(site, e.file))) continue;
    let bytes = readFileSync(join(site, e.file));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
    const hazards = e.hazards || doc.hazards;
    const n = Math.round((Date.parse(dash(e.date)) - day1) / 864e5) + 1;
    const files = {};
    for (const [h, { levels, name }] of Object.entries(HAZARD_LEVELS)) {
      const at = hazards.indexOf(h);
      if (at < 0) continue;
      // Rows south first, as the contouring takes them.
      const z = new Float32Array(nx * ny);
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = bytes[at * nx * ny + (ny - 1 - j) * nx + i];
      const features = latticeAreas(z, nx, ny, levels, { west, south }, step, 3, { offset: 0.5, round: 3 })
        .filter(([, , polys]) => polys.length)
        .map(([L, colour, polys]) => ({
          type: 'Feature',
          geometry: { type: 'MultiPolygon', coordinates: polys },
          properties: {
            DN: L,
            LABEL: (L / 100).toFixed(2),
            LABEL2: `${L}% ${name}`,
            fill: colour,
            stroke: colour,
            ISSUE: spcTime(e.run),
            hazard: h,
            percent: L,
            date: dash(e.date),
            day: n,
            run: e.run,
            ...(e.update ? { update: true } : {}),
          },
        }));
      const fc = { type: 'FeatureCollection', name: `Stormycast ${name} ${dash(e.date)}`, credit: index.credit, license: 'CC BY 4.0', features };
      const text = JSON.stringify(fc);
      mkdirSync(join(out, e.date), { recursive: true });
      writeFileSync(join(out, e.date, `${h}.geojson`), text);
      written++;
      if (n >= 1 && n <= 5) { writeFileSync(join(out, `day${n}_${h}.geojson`), text); written++; }
      files[h] = `geojson/${e.date}/${h}.geojson`;
    }
    index.days.push({ date: dash(e.date), day: n, run: e.run, ...(e.update ? { update: true } : {}), files });
  }
  writeFileSync(join(out, 'index.json'), JSON.stringify(index, null, 1));
  return written + 1;
}
