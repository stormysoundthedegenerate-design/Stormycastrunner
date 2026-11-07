// HRRR's hourly analyses from the University of Utah's Zarr copy on AWS (hrrrzarr, since
// August 2016, kept current): each field cut into 150 × 150 tiles of floats (16-bit until
// mid-2024, 32-bit since), Blosc-compressed (LZ4, byte-shuffled), so the environment round one place costs a tile
// a field — tens of kilobytes — rather than the whole country.
//
//   sfc/<yyyymmdd>/<yyyymmdd>_<hh>z_anl.zarr/<level>/<name>/<level>/<name>/<row>.<col>
//
// The grid is HRRR's own: Lambert conformal on a sphere of 6371229 m, true at 38.5°N,
// centred on 97.5°W, 1799 × 1059 points 3 km apart, the first row the southernmost.

import { locator } from '../lib/model-grid.mjs';

const BASE = 'https://hrrrzarr.s3.amazonaws.com/sfc';
export const HRRR_GRID = {
  kind: 'lambert', radius: 6371229, nx: 1799, ny: 1059, la1: 21.138123, lo1: 237.280472,
  lad: 38.5, lov: 262.5, latin1: 38.5, latin2: 38.5, dx: 3000, dy: 3000, scan: 0x40,
};
const TILE = 150;
const locate = locator(HRRR_GRID);

// --- Blosc and LZ4 -----------------------------------------------------------------------

/** An LZ4 block decompressed into `out` from `at`; how many bytes it wrote. */
function lz4Block(src, out, at) {
  let i = 0;
  let o = at;
  while (i < src.length) {
    const token = src[i++];
    let lit = token >> 4;
    if (lit === 15) { let b; do { b = src[i++]; lit += b; } while (b === 255); }
    out.set(src.subarray(i, i + lit), o);
    i += lit;
    o += lit;
    if (i >= src.length) break;
    const offset = src[i] | (src[i + 1] << 8);
    i += 2;
    let len = token & 15;
    if (len === 15) { let b; do { b = src[i++]; len += b; } while (b === 255); }
    len += 4;
    for (let k = 0; k < len; k++, o++) out[o] = out[o - offset];
  }
  return o - at;
}

/** A Blosc (v1) buffer decompressed: LZ4 blocks, split per byte of the type, then unshuffled. */
export function bloscDecode(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[2];
  const typesize = buf[3];
  const nbytes = v.getUint32(4, true);
  const blocksize = v.getUint32(8, true);
  const out = new Uint8Array(nbytes);
  if (flags & 0x02) { out.set(buf.subarray(16, 16 + nbytes)); return out; } // stored as it is
  const nblocks = Math.ceil(nbytes / blocksize);
  const shuffled = !!(flags & 0x01);
  const split = !(flags & 0x10) && typesize > 1;
  const block = new Uint8Array(blocksize);
  for (let b = 0; b < nblocks; b++) {
    const size = Math.min(blocksize, nbytes - b * blocksize);
    let p = v.getUint32(16 + b * 4, true);
    // Blosc splits a block into one stream per byte of the type, except the leftover
    // block at the end of a buffer (an analysis tile is one whole block; a forecast's
    // chunk, every hour of the tile, ends in a short one).
    const leftover = size < blocksize;
    const streams = split && !leftover && size % typesize === 0 && blocksize / typesize >= 128 ? typesize : 1;
    const each = size / streams;
    let o = 0;
    for (let s = 0; s < streams; s++) {
      const csize = v.getInt32(p, true);
      p += 4;
      if (csize === each) block.set(buf.subarray(p, p + csize), o);
      else lz4Block(buf.subarray(p, p + csize), block, o);
      p += csize;
      o += each;
    }
    const dst = out.subarray(b * blocksize, b * blocksize + size);
    if (shuffled && typesize > 1) {
      const n = size / typesize;
      for (let k = 0; k < n; k++) for (let t = 0; t < typesize; t++) dst[k * typesize + t] = block[t * n + k];
    } else dst.set(block.subarray(0, size));
  }
  return out;
}

/**
 * Some blocks of a Blosc (v1) buffer, read without the rest: `head` holds the buffer's
 * first bytes (16 plus four per block), `comp` the compressed bytes from offset `at` on.
 * Returns blocks b0..b1 decompressed (the first byte is byte b0 × blocksize of the whole).
 */
export function bloscHead(head) {
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const nbytes = v.getUint32(4, true);
  const blocksize = v.getUint32(8, true);
  const cbytes = v.getUint32(12, true);
  const nblocks = Math.ceil(nbytes / blocksize);
  const starts = [];
  for (let b = 0; b < nblocks; b++) starts.push(v.getUint32(16 + b * 4, true));
  return { flags: head[2], typesize: head[3], nbytes, blocksize, cbytes, nblocks, starts };
}
export function bloscBlocks(h, comp, at, b0, b1) {
  const v = new DataView(comp.buffer, comp.byteOffset, comp.byteLength);
  const { flags, typesize, nbytes, blocksize } = h;
  const shuffled = !!(flags & 0x01);
  const split = !(flags & 0x10) && typesize > 1;
  const first = b0 * blocksize;
  const out = new Uint8Array(Math.min(nbytes, (b1 + 1) * blocksize) - first);
  const block = new Uint8Array(blocksize);
  for (let b = b0; b <= b1; b++) {
    const size = Math.min(blocksize, nbytes - b * blocksize);
    let p = h.starts[b] - at;
    const leftover = size < blocksize;
    const streams = split && !leftover && size % typesize === 0 && blocksize / typesize >= 128 ? typesize : 1;
    const each = size / streams;
    let o = 0;
    for (let s = 0; s < streams; s++) {
      const csize = v.getInt32(p, true);
      p += 4;
      if (csize === each) block.set(comp.subarray(p, p + csize), o);
      else lz4Block(comp.subarray(p, p + csize), block, o);
      p += csize;
      o += each;
    }
    const dst = out.subarray(b * blocksize - first, b * blocksize - first + size);
    if (shuffled && typesize > 1) {
      const n = size / typesize;
      for (let k = 0; k < n; k++) for (let t = 0; t < typesize; t++) dst[k * typesize + t] = block[t * n + k];
    } else dst.set(block.subarray(0, size));
  }
  return out;
}

/** IEEE half floats to numbers. */
function halves(bytes) {
  const n = bytes.length / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const h = bytes[2 * i] | (bytes[2 * i + 1] << 8);
    const e = (h >> 10) & 31;
    const f = h & 1023;
    const s = h & 0x8000 ? -1 : 1;
    out[i] = e === 0 ? s * f * 2 ** -24 : e === 31 ? (f ? NaN : s * Infinity) : s * (1 + f / 1024) * 2 ** (e - 15);
  }
  return out;
}

// --- reading ---------------------------------------------------------------------------

const tiles = new Map(); // url -> Promise<Float32Array|null>
const MAX_TILES = 1500;

/** One tile of one field at one hour (150 × 150 values, NaN where none), or null if missing. */
function tile(hour, field, ty, tx, fetcher) {
  const d = new Date(hour);
  const day = d.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const [level, name] = field.split('/');
  const url = `${BASE}/${day}/${day}_${hh}z_anl.zarr/${level}/${name}/${level}/${name}/${ty}.${tx}`;
  if (!tiles.has(url)) {
    tiles.set(url, (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetcher(url);
          if (r.status === 404 || r.status === 403) return null;
          if (!r.ok) throw new Error(`hrrrzarr ${r.status}`);
          // Half floats until mid-2024, single floats since (missing as -10000, then
          // -9999): told apart by how big the tile unpacks, 2 or 4 bytes a value.
          const raw = bloscDecode(new Uint8Array(await r.arrayBuffer()));
          const v = raw.length >= TILE * TILE * 4
            ? new Float32Array(raw.buffer, raw.byteOffset, TILE * TILE).slice()
            : halves(raw);
          for (let i = 0; i < v.length; i++) if (v[i] === -10000 || v[i] === -9999) v[i] = NaN;
          return v;
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        }
      }
      return null;
    })());
    if (tiles.size > MAX_TILES) tiles.delete(tiles.keys().next().value);
  }
  return tiles.get(url);
}

// A forecast run's fields come every hour of the run at once: one chunk a tile holds all
// of them (18 hours, 48 for 00, 06, 12 and 18Z), so a storm's next hours in the same
// tile cost one read. A chunk is a few megabytes unpacked: fewer kept.
//
//   sfc/<yyyymmdd>/<yyyymmdd>_<hh>z_fcst.zarr/<level>/<name>/<level>/<name>/0.<row>.<col>
const chunks = new Map(); // url -> Promise<Float32Array[] | null> (one tile an hour, from hour 1)
const MAX_CHUNKS = 80;

function forecastChunk(run, field, ty, tx, fetcher) {
  const d = new Date(run);
  const day = d.toISOString().slice(0, 10).replace(/-/g, '');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const [level, name] = field.split('/');
  const url = `${BASE}/${day}/${day}_${hh}z_fcst.zarr/${level}/${name}/${level}/${name}/0.${ty}.${tx}`;
  if (!chunks.has(url)) {
    chunks.set(url, (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetcher(url);
          if (r.status === 404 || r.status === 403) return null;
          if (!r.ok) throw new Error(`hrrrzarr ${r.status}`);
          const raw = bloscDecode(new Uint8Array(await r.arrayBuffer()));
          // 18 or 48 hours, of 2- or 4-byte values: the size says which.
          const per = raw.length / (TILE * TILE);
          const four = per === 72 || per === 192;
          const hours = four ? per / 4 : per / 2;
          const all = four ? new Float32Array(raw.buffer, raw.byteOffset, hours * TILE * TILE) : halves(raw);
          return Array.from({ length: hours }, (_, k) => {
            const v = all.slice(k * TILE * TILE, (k + 1) * TILE * TILE);
            for (let i = 0; i < v.length; i++) if (v[i] === -10000 || v[i] === -9999) v[i] = NaN;
            return v;
          });
        } catch (err) {
          if (attempt === 2) throw err;
          await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
        }
      }
      return null;
    })());
    if (chunks.size > MAX_CHUNKS) chunks.delete(chunks.keys().next().value);
  }
  return chunks.get(url);
}

/** One tile of one field at an hour of a forecast run (the run's first slot is its hour 1). */
async function forecastTile(run, hour, field, ty, tx, fetcher) {
  const k = Math.round((hour - run) / 3600e3) - 1;
  if (k < 0) return null;
  const all = await forecastChunk(run, field, ty, tx, fetcher);
  return all?.[k] || null;
}

/**
 * The newest forecast run in the archive at or before `now` (ms, on the hour), looked for
 * up to eight hours back (it runs two or three behind); null if none. Kept ten minutes.
 */
let runKept = null;
export async function newestRun(now = Date.now(), fetcher = fetch) {
  const top = Math.floor(now / 3600e3) * 3600e3;
  if (runKept && runKept.top === top && Date.now() - runKept.at < 10 * 60e3) return runKept.job;
  const job = (async () => {
    for (let back = 0; back <= 8; back++) {
      const run = top - back * 3600e3;
      const d = new Date(run);
      const day = d.toISOString().slice(0, 10).replace(/-/g, '');
      const hh = String(d.getUTCHours()).padStart(2, '0');
      const r = await fetcher(`${BASE}/${day}/${day}_${hh}z_fcst.zarr/surface/CAPE/surface/CAPE/.zarray`).catch(() => null);
      if (r?.ok) {
        const shape = (await r.json().catch(() => null))?.shape;
        return { run, hours: shape?.[0] || 18 };
      }
    }
    return null;
  })();
  runKept = { top, at: Date.now(), job };
  return job;
}

/** Where a place is on the grid: fractional column and row, or null off it. */
export function hrrrCell(lat, lon) {
  const [i, j] = locate(lat, lon);
  return i < 0 || j < 0 || i > HRRR_GRID.nx - 1 || j > HRRR_GRID.ny - 1 ? null : { i, j };
}

/**
 * A field's values round a place at an hour: every grid point within `km`, as a flat
 * list (for the neighbourhood's median, high end and so on). Reads the tiles it touches.
 *
 * @param {number} hour ms, on the hour
 * @param {string} field "<level>/<name>", e.g. "surface/CAPE" or "1000_0m_above_ground/HLCY"
 * @param {number|null} run a forecast run's start (ms): that run's forecast for `hour`,
 *   instead of the hour's analysis
 */
export async function hrrrAround(hour, field, lat, lon, km = 40, fetcher = fetch, run = null) {
  const c = hrrrCell(lat, lon);
  if (!c) return null;
  const r = Math.ceil(km / 3);
  const i0 = Math.max(0, Math.round(c.i) - r);
  const i1 = Math.min(HRRR_GRID.nx - 1, Math.round(c.i) + r);
  const j0 = Math.max(0, Math.round(c.j) - r);
  const j1 = Math.min(HRRR_GRID.ny - 1, Math.round(c.j) + r);
  const need = new Map();
  for (let ty = Math.floor(j0 / TILE); ty <= Math.floor(j1 / TILE); ty++) {
    for (let tx = Math.floor(i0 / TILE); tx <= Math.floor(i1 / TILE); tx++) need.set(`${ty}.${tx}`, run != null ? forecastTile(run, hour, field, ty, tx, fetcher) : tile(hour, field, ty, tx, fetcher));
  }
  const got = new Map();
  for (const [k, p] of need) got.set(k, await p);
  const out = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if ((i - c.i) ** 2 + (j - c.j) ** 2 > r * r) continue;
      const t = got.get(`${Math.floor(j / TILE)}.${Math.floor(i / TILE)}`);
      if (!t) continue;
      const v = t[(j % TILE) * TILE + (i % TILE)];
      if (v === v) out.push(v);
    }
  }
  return out;
}
