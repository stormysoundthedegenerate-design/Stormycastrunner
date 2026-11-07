// GRIB2: one message in, one grid of numbers out.
//
// Forecast models publish in GRIB2, and every model this app reads keeps an index
// beside each file, so a single field is one byte-range request and one message — never
// the whole file. This reads that message: the grid it lies on (sections 3), how its
// numbers were packed (5), which points carry one (6), and the packed numbers (7).
//
// Only what the models in lib/models.mjs actually use is implemented, and anything
// else is refused by name rather than decoded into garbage:
//
//   grids     3.0  regular latitude/longitude      (GFS, ECMWF, the Canadian global, HAFS)
//             3.1  rotated latitude/longitude      (the Canadian regional models)
//             3.20 polar stereographic, north      (the Alaska grids)
//             3.30 Lambert conformal               (HRRR, NAM 3 km, RRFS, RAP)
//             3.101 unstructured                   (ICON; its cells' positions come in
//                                                  files of their own, see regrid.mjs)
//   packing   5.0  simple
//             5.2  complex
//             5.3  complex with spatial differencing  (every NCEP model)
//             5.42 CCSDS / AEC                        (ECMWF; see aec.mjs)
//             5.40 JPEG 2000                          (RAP, the Canadian models; see j2k.mjs)
//             5.41 PNG                                (MRMS; decodeMessageAsync, as its
//                                                     inflating is the browser's, and async)
//   rows      in either direction, or alternating     (NBM alternates)
//
// GRIB2's signed integers are sign-and-magnitude — the top bit is the sign, not two's
// complement — which is the one trap every hand-written reader falls into once.

import { aecDecode } from './aec.mjs';

// JPEG 2000 (packing 5.40) needs a decoder too big to load for every page, so whoever
// first meets such a message loads it (core/j2k.mjs) and hands it in here.
let jpeg2000 = null;
export function setJpeg2000(decode) { jpeg2000 = decode; }

/** Scanning-mode flag (GRIB2 table 3.4): each row runs the opposite way to the one before. */
const ALTERNATE_ROWS = 0x10;

const u8 = (b, o) => b[o];
const u16 = (b, o) => (b[o] << 8) | b[o + 1];
const u32 = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const s16 = (b, o) => { const v = u16(b, o); return v & 0x8000 ? -(v & 0x7fff) : v; };
const s32 = (b, o) => { const v = u32(b, o); return v >= 0x80000000 ? -(v - 0x80000000) : v; };
const f32 = (b, o) => new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0);
/** An n-octet sign-and-magnitude integer (the spatial-differencing descriptors). */
const sN = (b, o, n) => {
  let v = b[o] & 0x7f;
  for (let i = 1; i < n; i++) v = v * 256 + b[o + i];
  return b[o] & 0x80 ? -v : v;
};

/** Earth radius in metres for a shape-of-earth code; the models here are all spheres. */
function earthRadius(sec, o) {
  const shape = u8(sec, o);
  if (shape === 0) return 6367470;
  if (shape === 6) return 6371229;
  if (shape === 8) return 6371200;
  if (shape === 1) return u32(sec, o + 2) / 10 ** u8(sec, o + 1);
  // Oblate shapes (2, 4, 5): a sphere of the mean radius is within a pixel at these scales.
  return 6371229;
}

function readGrid(sec) {
  const template = u16(sec, 12);
  const npts = u32(sec, 6);
  // Octet numbers below are the WMO template's, minus one.
  if (template === 0 || template === 1) {
    const angle = u32(sec, 38);
    const sub = u32(sec, 42);
    const unit = angle === 0 || sub === 0xffffffff ? 1e-6 : angle / sub;
    const grid = {
      kind: 'latlon',
      npts,
      nx: u32(sec, 30),
      ny: u32(sec, 34),
      la1: s32(sec, 46) * unit,
      lo1: s32(sec, 50) * unit,
      la2: s32(sec, 55) * unit,
      lo2: s32(sec, 59) * unit,
      dx: u32(sec, 63) * unit,
      dy: u32(sec, 67) * unit,
      scan: u8(sec, 71),
      uvGrid: !!(u8(sec, 54) & 0x08),
    };
    if (template === 0) return grid;
    // The same lattice on a sphere turned so its equator runs through the middle of the
    // domain, which keeps the cells square far north. The turn is named by where it put
    // the south pole; a further twist about the new axis is never used by the models here.
    if (f32(sec, 80)) throw new Error('GRIB2 rotated grids twisted about their own pole are not supported');
    return { ...grid, kind: 'rotated', spLat: s32(sec, 72) * unit, spLon: s32(sec, 76) * unit };
  }
  if (template === 10) {
    // Mercator (RRFS's Puerto Rico and Hawaii grids): columns even in longitude, rows
    // even in Mercator's stretched latitude, between the two corners given.
    return {
      kind: 'mercator',
      npts,
      radius: earthRadius(sec, 14),
      nx: u32(sec, 30),
      ny: u32(sec, 34),
      la1: s32(sec, 38) * 1e-6,
      lo1: s32(sec, 42) * 1e-6,
      lad: s32(sec, 47) * 1e-6, // where the spacing is true
      la2: s32(sec, 51) * 1e-6,
      lo2: s32(sec, 55) * 1e-6,
      scan: u8(sec, 59),
      dx: u32(sec, 64) / 1000,
      dy: u32(sec, 68) / 1000,
      // A Mercator grid's axes are east and north, so its winds need no turning.
      uvGrid: false,
    };
  }
  if (template === 20) {
    // Laid out as the Lambert template is, up to its scanning mode.
    if (u8(sec, 63) & 0x80) throw new Error('GRIB2 south-polar stereographic grids are not supported');
    return {
      kind: 'polar',
      npts,
      radius: earthRadius(sec, 14),
      nx: u32(sec, 30),
      ny: u32(sec, 34),
      la1: s32(sec, 38) * 1e-6,
      lo1: s32(sec, 42) * 1e-6,
      lad: s32(sec, 47) * 1e-6, // where the grid's spacing is true
      lov: s32(sec, 51) * 1e-6,
      dx: u32(sec, 55) / 1000,
      dy: u32(sec, 59) / 1000,
      scan: u8(sec, 64),
      uvGrid: !!(u8(sec, 46) & 0x08),
    };
  }
  if (template === 30) {
    return {
      kind: 'lambert',
      npts,
      radius: earthRadius(sec, 14),
      nx: u32(sec, 30),
      ny: u32(sec, 34),
      la1: s32(sec, 38) * 1e-6,
      lo1: s32(sec, 42) * 1e-6,
      lad: s32(sec, 47) * 1e-6,
      lov: s32(sec, 51) * 1e-6,
      dx: u32(sec, 55) / 1000, // millimetres
      dy: u32(sec, 59) / 1000,
      scan: u8(sec, 64),
      latin1: s32(sec, 65) * 1e-6,
      latin2: s32(sec, 69) * 1e-6,
      // Winds along the grid's own x and y rather than east and north: true for the
      // Lambert grids here, and what a barb has to be turned back from.
      uvGrid: !!(u8(sec, 46) & 0x08),
    };
  }
  if (template === 101) {
    // Cells with no rows or columns: the grid is named, and its cells' positions are
    // published separately. The name is the grid's number and a UUID.
    const uuid = Array.from(sec.subarray(19, 35), (b) => b.toString(16).padStart(2, '0')).join('');
    return { kind: 'unstructured', npts, gridNumber: (u8(sec, 15) << 16) | u16(sec, 16), uuid };
  }
  throw new Error(`GRIB2 grid template 3.${template} is not supported`);
}

/** A big-endian bit reader over a byte array. */
class Bits {
  constructor(bytes, start = 0) { this.b = bytes; this.pos = start * 8; }
  read(n) {
    if (n === 0) return 0;
    let v = 0;
    let pos = this.pos;
    const b = this.b;
    for (let left = n; left > 0;) {
      const byte = b[pos >>> 3];
      const off = pos & 7;
      const take = Math.min(8 - off, left);
      const bits = (byte >>> (8 - off - take)) & ((1 << take) - 1);
      v = v * (1 << take) + bits;
      pos += take;
      left -= take;
    }
    this.pos = pos;
    return v;
  }
  align() { this.pos = (this.pos + 7) & ~7; }
  get byte() { return this.pos >>> 3; }
}

/** Template 5.0: every value the same width. */
function unpackSimple(data, n, nbits) {
  const out = new Float64Array(n);
  if (nbits === 0) return out;
  const bits = new Bits(data);
  for (let i = 0; i < n; i++) out[i] = bits.read(nbits);
  return out;
}

/**
 * Templates 5.2 and 5.3: values in groups, each group a reference plus values of its own
 * width; 5.3 has first had the field differenced once or twice along the scan, which is
 * what makes a smooth field pack so small. Returns the integers before scaling, with
 * NaN where the packing marks a value missing.
 */
function unpackComplex(sec5, data, n) {
  const nbits = u8(sec5, 19);
  const missingMgmt = u8(sec5, 22);
  const ng = u32(sec5, 31);
  const widthRef = u8(sec5, 35);
  const widthBits = u8(sec5, 36);
  const lenRef = u32(sec5, 37);
  const lenInc = u8(sec5, 41);
  const lastLen = u32(sec5, 42);
  const lenBits = u8(sec5, 46);
  const template = u16(sec5, 9);
  const order = template === 3 ? u8(sec5, 47) : 0;
  const extra = template === 3 ? u8(sec5, 48) : 0;

  let at = 0;
  const firsts = [];
  let minsd = 0;
  if (order > 0) {
    for (let i = 0; i < order; i++) { firsts.push(sN(data, at, extra)); at += extra; }
    minsd = sN(data, at, extra);
    at += extra;
  }

  const bits = new Bits(data, at);
  const refs = new Float64Array(ng);
  for (let g = 0; g < ng; g++) refs[g] = bits.read(nbits);
  bits.align();
  const widths = new Uint8Array(ng);
  for (let g = 0; g < ng; g++) widths[g] = bits.read(widthBits) + widthRef;
  bits.align();
  const lens = new Uint32Array(ng);
  for (let g = 0; g < ng; g++) lens[g] = bits.read(lenBits) * lenInc + lenRef;
  if (ng) lens[ng - 1] = lastLen;
  bits.align();

  const out = new Float64Array(n);
  const missAll = nbits ? 2 ** nbits - 1 : 0;
  let k = 0;
  for (let g = 0; g < ng && k < n; g++) {
    const w = widths[g];
    const len = lens[g];
    const ref = refs[g];
    if (w === 0) {
      // A constant group — unless its reference is the missing marker.
      const isMiss = missingMgmt >= 1 && (ref === missAll || (missingMgmt === 2 && ref === missAll - 1));
      for (let i = 0; i < len && k < n; i++) out[k++] = isMiss ? NaN : ref;
    } else {
      const miss1 = 2 ** w - 1;
      for (let i = 0; i < len && k < n; i++) {
        const v = bits.read(w);
        out[k++] = missingMgmt >= 1 && (v === miss1 || (missingMgmt === 2 && v === miss1 - 1)) ? NaN : ref + v;
      }
    }
  }

  // Undo the differencing, over the values that are present only.
  if (order === 1) {
    let prev = NaN;
    let seen = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(out[i])) continue;
      if (seen === 0) out[i] = firsts[0];
      else out[i] = out[i] + minsd + prev;
      prev = out[i];
      seen++;
    }
  } else if (order === 2) {
    let p1 = NaN;
    let p2 = NaN;
    let seen = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(out[i])) continue;
      if (seen === 0) out[i] = firsts[0];
      else if (seen === 1) out[i] = firsts[1];
      else out[i] = out[i] + minsd + 2 * p1 - p2;
      p2 = p1;
      p1 = out[i];
      seen++;
    }
  }
  return out;
}

/**
 * Every field of one message, undecoded: its grid, product definition, packing,
 * bitmap and data. A message usually holds one field, but may repeat sections 4 to 7
 * for several on the same grid — NAM keeps a wind's two components in one — and a
 * later field may reuse the bitmap before it (indicator 254).
 */
function* fieldsOf(msg) {
  if (msg[0] !== 0x47 || msg[1] !== 0x52 || msg[2] !== 0x49 || msg[3] !== 0x42) throw new Error('not a GRIB message');
  if (msg[7] !== 2) throw new Error(`GRIB edition ${msg[7]} is not supported`);
  const discipline = msg[6];
  let p = 16;
  let grid = null;
  let sec4 = null;
  let sec5 = null;
  let bitmap = null;
  while (p + 4 < msg.length) {
    if (msg[p] === 0x37 && msg[p + 1] === 0x37 && msg[p + 2] === 0x37 && msg[p + 3] === 0x37) break;
    const len = u32(msg, p);
    const num = msg[p + 4];
    const sec = msg.subarray(p, p + len);
    if (num === 3) grid = readGrid(sec);
    else if (num === 4) sec4 = sec;
    else if (num === 5) sec5 = sec;
    else if (num === 6) {
      const ind = u8(sec, 5);
      if (ind === 0) bitmap = sec.subarray(6);
      else if (ind === 255) bitmap = null;
      else if (ind !== 254) throw new Error(`GRIB2 bitmap indicator ${ind} is not supported`);
    } else if (num === 7) {
      if (!grid || !sec5) throw new Error('GRIB2 message is missing a section');
      yield { discipline, grid, sec4, sec5, bitmap, data: sec.subarray(5) };
    }
    if (!len) break;
    p += len;
  }
}

/** Unpack one field's numbers onto its grid; `given`, the packed integers already read. */
function unpackField({ grid, sec5, bitmap, data }, given = null) {
  const npacked = u32(sec5, 5);
  const template = u16(sec5, 9);
  const R = f32(sec5, 11);
  const E = s16(sec5, 15);
  const D = s16(sec5, 17);
  const nbits = u8(sec5, 19);
  const e2 = 2 ** E;
  const d10 = 10 ** -D;

  let ints;
  if (given) ints = given;
  else if (template === 0) ints = unpackSimple(data, npacked, nbits);
  else if (template === 2 || template === 3) ints = unpackComplex(sec5, data, npacked);
  else if (template === 42) {
    ints = aecDecode(data, npacked, {
      bitsPerSample: nbits,
      flags: u8(sec5, 21),
      blockSize: u8(sec5, 22),
      rsi: u16(sec5, 23),
    });
  } else if (template === 40) {
    if (!jpeg2000) throw Object.assign(new Error('GRIB2 JPEG 2000 packing needs its decoder loaded'), { needsJpeg2000: true });
    // No bits a value: every value is the reference, and there is nothing to decode.
    ints = nbits === 0 ? new Float64Array(npacked) : jpeg2000(data, npacked);
  } else if (template === 41) {
    throw Object.assign(new Error('GRIB2 PNG packing is read by decodeMessageAsync'), { needsAsync: true });
  } else throw new Error(`GRIB2 packing template 5.${template} is not supported`);

  const values = new Float32Array(grid.npts);
  if (bitmap) {
    let k = 0;
    for (let i = 0; i < grid.npts; i++) {
      const on = (bitmap[i >>> 3] >>> (7 - (i & 7))) & 1;
      values[i] = on ? (R + ints[k++] * e2) * d10 : NaN;
    }
  } else {
    for (let i = 0; i < grid.npts; i++) values[i] = i < npacked ? (R + ints[i] * e2) * d10 : NaN;
  }
  // A grid whose rows run in alternate directions (the blend's does) is put back into
  // ordinary rows here, every second one reversed, so nothing after this need know.
  if (grid.scan & ALTERNATE_ROWS) {
    for (let j = 1; j < grid.ny; j += 2) values.subarray(j * grid.nx, (j + 1) * grid.nx).reverse();
  }
  return values;
}

/** The grid as its values now lie: in ordinary rows, whatever the message said. */
const asUnpacked = (grid) => (grid.scan & ALTERNATE_ROWS ? { ...grid, scan: grid.scan & ~ALTERNATE_ROWS } : grid);

/**
 * Decode one field of a GRIB2 message, counting from 1.
 *
 * @param {Uint8Array} msg  the message, from "GRIB" to "7777"
 * @param {number} [which]
 * @returns {{grid: object, values: Float32Array, discipline: number}}
 *   values in the grid's own scanning order, NaN where there is no value
 */
/**
 * A PNG's pixels as the integers GRIB2 packed into it: grey of 1 to 16 bits, or the
 * channels of a colour image read together as one big-endian number (24 or 32 bits).
 */
async function pngInts(png, npacked) {
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 8;
  let type = 0;
  const idat = [];
  while (at + 8 <= png.length) {
    const len = u32(png, at);
    const kind = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const body = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = u32(body, 0); height = u32(body, 4); depth = body[8]; type = body[9]; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  const stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type] || 1;
  const bitsPx = channels * depth;
  const bpp = Math.max(1, bitsPx >> 3); // the filters' unit, at least a byte
  const rowBytes = Math.ceil((width * bitsPx) / 8);
  const rows = new Uint8Array(rowBytes * height);
  // Undo each row's filter (PNG: none, sub, up, average, Paeth) against the row above.
  for (let y = 0; y < height; y++) {
    const f = raw[y * (rowBytes + 1)];
    const src = raw.subarray(y * (rowBytes + 1) + 1, (y + 1) * (rowBytes + 1));
    const out = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    const up = y ? rows.subarray((y - 1) * rowBytes, y * rowBytes) : null;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = v & 255;
    }
  }
  const ints = new Float64Array(npacked);
  const n = Math.min(npacked, width * height);
  if (bitsPx >= 8) {
    const bytes = bitsPx >> 3;
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let k = 0; k < bytes; k++) v = v * 256 + rows[i * bytes + k];
      ints[i] = v;
    }
  } else {
    const mask = (1 << bitsPx) - 1;
    for (let i = 0; i < n; i++) {
      const y = Math.floor(i / width);
      const x = i - y * width;
      const bit = y * rowBytes * 8 + x * bitsPx;
      ints[i] = (rows[bit >> 3] >> (8 - bitsPx - (bit & 7))) & mask;
    }
  }
  return ints;
}

/**
 * One window of a PNG of grey (8 or 16 bits), rows j0 to j1 and columns i0 to i1 in
 * blocks of `stride` a side, as the packed integers (each block's largest). The image is inflated as a
 * stream and its rows unfiltered one at a time, two rows held at once, so a national
 * grid of a hundred million cells costs what the window does in memory; rows past the
 * window are never read.
 */
async function pngWindow(png, { i0, i1, j0, j1, stride }) {
  let at = 8;
  let width = 0;
  let depth = 8;
  let type = 0;
  const idat = [];
  while (at + 8 <= png.length) {
    const len = u32(png, at);
    const kind = String.fromCharCode(png[at + 4], png[at + 5], png[at + 6], png[at + 7]);
    const body = png.subarray(at + 8, at + 8 + len);
    if (kind === 'IHDR') { width = u32(body, 0); depth = body[8]; type = body[9]; }
    else if (kind === 'IDAT') idat.push(body);
    else if (kind === 'IEND') break;
    at += 12 + len;
  }
  if (type !== 0 || (depth !== 8 && depth !== 16)) return null;
  const bpp = depth >> 3;
  const rowBytes = width * bpp;
  const nx = Math.ceil((i1 - i0) / stride);
  const ny = Math.ceil((j1 - j0) / stride);
  const ints = new Float64Array(nx * ny);
  let prev = new Uint8Array(rowBytes);
  let cur = new Uint8Array(rowBytes);
  let pending = new Uint8Array(0);
  let y = 0;
  const reader = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  try {
    while (y < j1) {
      const { done, value } = await reader.read();
      if (done) break;
      let buf = value;
      if (pending.length) {
        buf = new Uint8Array(pending.length + value.length);
        buf.set(pending);
        buf.set(value, pending.length);
      }
      let o = 0;
      while (o + rowBytes + 1 <= buf.length && y < j1) {
        const f = buf[o];
        const src = buf.subarray(o + 1, o + 1 + rowBytes);
        for (let i = 0; i < rowBytes; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          let v = src[i];
          if (f === 1) v += a;
          else if (f === 2) v += b;
          else if (f === 3) v += (a + b) >> 1;
          else if (f === 4) {
            const c = i >= bpp ? prev[i - bpp] : 0;
            const pa = Math.abs(b - c);
            const pb = Math.abs(a - c);
            const pc = Math.abs(a + b - 2 * c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
          cur[i] = v & 255;
        }
        if (y >= j0) {
          // Thinned, each cell keeps the largest of its block, so a narrow swath's peak
          // (a rotation track is a few cells wide) is never stepped over.
          const row = Math.floor((y - j0) / stride) * nx;
          for (let x = i0; x < i1; x++) {
            const v = bpp === 2 ? cur[x * 2] * 256 + cur[x * 2 + 1] : cur[x];
            const k = row + Math.floor((x - i0) / stride);
            if (v > ints[k]) ints[k] = v;
          }
        }
        [prev, cur] = [cur, prev];
        y++;
        o += rowBytes + 1;
      }
      pending = buf.subarray(o);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return { ints, nx, ny };
}

/**
 * The window of a latitude/longitude field nearest a box, as decodeMessageAsync takes
 * it: its rows and columns, every `stride`th, no more than `max` cells a side.
 */
export function windowOf(grid, { south, north, west, east }, max = 1600) {
  const jNorth = !!(grid.scan & 0x40);
  const row = (lat) => (jNorth ? lat - grid.la1 : grid.la1 - lat) / grid.dy;
  const col = (lon) => ((((lon - grid.lo1) % 360) + 540) % 360 - 180) / grid.dx;
  let j0 = Math.floor(Math.min(row(south), row(north)));
  let j1 = Math.ceil(Math.max(row(south), row(north)));
  let i0 = Math.floor(col(west));
  let i1 = Math.ceil(col(east));
  i0 = Math.max(0, i0); i1 = Math.min(grid.nx, i1);
  j0 = Math.max(0, j0); j1 = Math.min(grid.ny, j1);
  if (i1 <= i0 || j1 <= j0) return null;
  const stride = Math.max(1, Math.ceil(Math.max(i1 - i0, j1 - j0) / max));
  return { i0, i1, j0, j1, stride };
}

/**
 * decodeMessage, for any packing, PNG's (5.41) too: its inflating is the browser's
 * DecompressionStream, which only answers asynchronously. With `win` (windowOf), a
 * PNG-packed lat/lon field is read only that far, and comes back as that window alone.
 */
export async function decodeMessageAsync(msg, which = 1, win = null) {
  let seen = 0;
  for (const f of fieldsOf(msg)) {
    if (++seen !== which) continue;
    if (win && u16(f.sec5, 9) === 41 && !f.bitmap && f.grid.kind === 'latlon' && u8(f.sec5, 19) > 0) {
      const got = await pngWindow(f.data, win);
      if (got) {
        const R = f32(f.sec5, 11);
        const e2 = 2 ** s16(f.sec5, 15);
        const d10 = 10 ** -s16(f.sec5, 17);
        const values = new Float32Array(got.ints.length);
        for (let i = 0; i < values.length; i++) values[i] = (R + got.ints[i] * e2) * d10;
        const g = f.grid;
        const jNorth = !!(g.scan & 0x40);
        const iSign = g.scan & 0x80 ? -1 : 1;
        const grid = {
          ...g,
          nx: got.nx,
          ny: got.ny,
          npts: got.nx * got.ny,
          la1: g.la1 + (jNorth ? 1 : -1) * win.j0 * g.dy,
          lo1: g.lo1 + iSign * win.i0 * g.dx,
          dx: g.dx * win.stride,
          dy: g.dy * win.stride,
        };
        return { grid: asUnpacked(grid), values, discipline: f.discipline };
      }
    }
    let given = null;
    if (u16(f.sec5, 9) === 41) {
      const npacked = u32(f.sec5, 5);
      given = u8(f.sec5, 19) === 0 ? new Float64Array(npacked) : await pngInts(f.data, npacked);
    }
    return { grid: asUnpacked(f.grid), values: unpackField(f, given), discipline: f.discipline };
  }
  throw new Error(`GRIB2 message has no field ${which}`);
}

/** A message's grid as it is stored (first field's), without decoding anything. */
export function messageGrid(msg) {
  for (const f of fieldsOf(msg)) return f.grid;
  throw new Error('GRIB2 message has no field');
}

export function decodeMessage(msg, which = 1) {
  let seen = 0;
  for (const f of fieldsOf(msg)) {
    if (++seen === which) return { grid: asUnpacked(f.grid), values: unpackField(f), discipline: f.discipline };
  }
  throw new Error(`GRIB2 message has no field ${which}`);
}

/**
 * What a whole GRIB2 file holds, without unpacking any of it: each field's message (its
 * byte range in the file and which field of the message it is) and what it is —
 * discipline, parameter category and number, first fixed surface and its value. For
 * files published without an index (NAVGEM), so one field can be found and decoded.
 *
 * @returns {Array<{start:number, end:number, sub:number, window:{from:number,to:number}|null,
 *   discipline:number, category:number, number:number, surface:number, level:number}>}
 */
export function messagesOf(bytes) {
  const out = [];
  let p = 0;
  while (p + 16 <= bytes.length) {
    if (bytes[p] !== 0x47 || bytes[p + 1] !== 0x52 || bytes[p + 2] !== 0x49 || bytes[p + 3] !== 0x42) { p++; continue; }
    const len = u32(bytes, p + 12) + u32(bytes, p + 8) * 2 ** 32;
    let sub = 0;
    for (const f of fieldsOf(bytes.subarray(p, p + len))) {
      const s4 = f.sec4;
      const scale = s4 ? (s4[23] & 0x80 ? -(s4[23] & 0x7f) : s4[23]) : 0;
      // A statistic over a time range (template 4.8, as accumulated precipitation is):
      // the hours it runs from and to, where both are given in hours.
      let window = null;
      if (s4 && u16(s4, 7) === 8 && u8(s4, 17) === 1 && u8(s4, 48) === 1) {
        const from = u32(s4, 18);
        window = { from, to: from + u32(s4, 49) };
      }
      out.push({
        start: p,
        end: p + len,
        sub: ++sub,
        window,
        discipline: f.discipline,
        category: s4 ? u8(s4, 9) : -1,
        number: s4 ? u8(s4, 10) : -1,
        surface: s4 ? u8(s4, 22) : -1,
        level: s4 ? u32(s4, 24) / 10 ** scale : NaN,
      });
    }
    p += len;
  }
  return out;
}

/**
 * Every field of a whole GRIB2 file — several messages back to back, as a NOMADS
 * filter returns them — each named by what it is and where: parameter category and
 * number (code table 4.2) and the first fixed surface (table 4.5; 100 is a pressure
 * level, its value in pascals).
 *
 * @returns {Array<{discipline:number, category:number, number:number, surface:number,
 *   level:number, grid:object, values:Float32Array}>}
 */
export function decodeFile(bytes) {
  const out = [];
  let p = 0;
  while (p + 16 <= bytes.length) {
    if (bytes[p] !== 0x47 || bytes[p + 1] !== 0x52 || bytes[p + 2] !== 0x49 || bytes[p + 3] !== 0x42) { p++; continue; }
    // GRIB2 total length is 64-bit; files this size fit in the low half.
    const len = u32(bytes, p + 12) + u32(bytes, p + 8) * 2 ** 32;
    const msg = bytes.subarray(p, p + len);
    for (const f of fieldsOf(msg)) {
      const s4 = f.sec4;
      const scale = s4 ? (s4[23] & 0x80 ? -(s4[23] & 0x7f) : s4[23]) : 0;
      out.push({
        discipline: f.discipline,
        category: s4 ? u8(s4, 9) : -1,
        number: s4 ? u8(s4, 10) : -1,
        surface: s4 ? u8(s4, 22) : -1,
        level: s4 ? u32(s4, 24) / 10 ** scale : NaN,
        grid: asUnpacked(f.grid),
        values: unpackField(f),
      });
    }
    p += len;
  }
  return out;
}
