// ERA5 from Google's analysis-ready copy (ARCO-ERA5, gcp-public-data-arco-era5), read in
// pieces: every field is one Blosc chunk per hour (the whole globe, all 37 levels for the
// pressure fields), so a band of rows at one level is fetched as the few compressed blocks
// that hold it: the chunk's header first (where each block starts), then those blocks.
// 0.25°, rows from 90°N down, columns from 0°E east. Node only (no cross-origin header).

import { bloscHead, bloscBlocks } from '../../public/js/core/hrrr-zarr.mjs';

const BASE = 'https://storage.googleapis.com/gcp-public-data-arco-era5/ar/full_37-1h-0p25deg-chunk-1.zarr-v3';
export const NX = 1440;
export const NY = 721;
const ROW = NX * 4;
export const LEVELS = [1, 2, 3, 5, 7, 10, 20, 30, 50, 70, 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 775, 800, 825, 850, 875, 900, 925, 950, 975, 1000];

/** Hours since 1900-01-01: the time index of the store. */
export const hourIndex = (ms) => Math.round((ms - Date.UTC(1900, 0, 1)) / 3600e3);

// A few dozen fetches at once: Google's storage serves each stream at 1–2 MB/s.
let active = 0;
const waiting = [];
let bytes = 0;
export const fetched = () => bytes;
async function slot(fn) {
  while (active >= LIMIT) await new Promise((r) => waiting.push(r));
  active++;
  try { return await fn(); } finally { active--; waiting.shift()?.(); }
}
let LIMIT = 24;
export function setLimit(n) { LIMIT = n; }

async function range(url, a, b) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await slot(async () => {
        const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` }, signal: AbortSignal.timeout(90000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`ERA5 ${r.status} ${url}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        bytes += buf.length;
        return buf;
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

const heads = new Map();
async function headOf(url, levels) {
  if (heads.has(url)) return heads.get(url);
  const nblocks = Math.ceil((levels * NY * ROW) / 524288) + 2;
  const p = range(url, 0, 16 + nblocks * 4).then((b) => {
    if (!b) return null;
    const h = bloscHead(b);
    if (16 + h.nblocks * 4 > b.length) throw new Error('ERA5 header longer than read');
    return h;
  });
  heads.set(url, p);
  if (heads.size > 400) heads.delete(heads.keys().next().value);
  return p;
}

/**
 * Rows r0..r1 (inclusive) of a field at an hour: `level` in hPa for a pressure field, null
 * for a surface one. A Float32Array (rows × 1440), or null where the hour isn't there.
 */
export async function rows(field, hour, level, r0, r1) {
  const t = hourIndex(hour);
  const li = level == null ? null : LEVELS.indexOf(level);
  if (li === -1) throw new Error(`no ERA5 level ${level}`);
  const url = `${BASE}/${field}/${t}.0.0${li == null ? '' : '.0'}`;
  const h = await headOf(url, li == null ? 1 : LEVELS.length);
  if (!h) return null;
  const from = ((li ?? 0) * NY + r0) * ROW;
  const to = ((li ?? 0) * NY + r1 + 1) * ROW;
  const b0 = Math.floor(from / h.blocksize);
  const b1 = Math.floor((to - 1) / h.blocksize);
  const a = h.starts[b0];
  const b = b1 + 1 < h.nblocks ? h.starts[b1 + 1] : h.cbytes;
  const comp = await range(url, a, b);
  if (!comp) return null;
  const raw = bloscBlocks(h, comp, a, b0, b1);
  const off = from - b0 * h.blocksize;
  return new Float32Array(raw.buffer.slice(raw.byteOffset + off, raw.byteOffset + off + (to - from)));
}

export const rowOf = (lat) => Math.round((90 - lat) * 4);
export const colOf = (lon) => Math.round((((lon % 360) + 360) % 360) * 4) % NX;
