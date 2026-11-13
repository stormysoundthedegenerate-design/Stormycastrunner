// CCSDS 121.0-B lossless decompression ("AEC", "szip"), as GRIB2 template 5.42 uses it.
//
// ECMWF's open data is packed this way. The stream is a run of blocks of `blockSize`
// samples; each starts with an option id saying how it was coded — Rice-split with k
// low bits sent raw, a run of all-zero blocks, the second extension (pairs of small
// values in one code), or raw — and every `rsi` blocks a reference sample restarts the
// predictor. Undoing the preprocessor (a unit-delay predictor whose residuals were
// folded onto the non-negative integers) gives the packed integers back.
//
// Written from the standard and from libaec's decoder, whose behaviour this matches —
// including its zero-block "remainder of segment" rule, which the standard leaves to
// a footnote. Unsigned samples only: GRIB2 never asks for signed.

const AEC_DATA_SIGNED = 1;
const AEC_DATA_PREPROCESS = 8;
const AEC_RESTRICTED = 16;
const AEC_PAD_RSI = 32;
const ROS = 5; // the zero-block code that means "to the end of this 64-block segment"

// The bit reader takes 32 bits at a time: the four bytes under the read position and
// the top of a fifth, shifted so the next unread bit is the highest. The stream is
// copied with 8 bytes of zeros after it, so a window never reads past the end.
// (A byte at a time, and a new array for each block's codes, made ECMWF's fields
// several times slower to unpack: a composite map is some 45 of them.)
class Bits {
  constructor(bytes) {
    this.b = new Uint8Array(bytes.length + 8);
    this.b.set(bytes);
    this.pos = 0;
    this.end = bytes.length * 8;
  }
  /** The 32 bits from `pos` on, as an unsigned integer's bit pattern. */
  win(pos) {
    const b = this.b;
    const i = pos >>> 3;
    const off = pos & 7;
    return (((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) << off) | (b[i + 4] >>> (8 - off));
  }
  /** n bits (1–32), as an unsigned number. */
  read(n) {
    const v = this.win(this.pos) >>> (32 - n);
    this.pos += n;
    return v;
  }
  /** A fundamental sequence: the number of zero bits before the next one. */
  fs() {
    let pos = this.pos;
    let n = 0;
    for (;;) {
      if (pos >= this.end) throw new Error('AEC stream ended inside a code');
      const w = this.win(pos);
      if (w === 0) {
        n += 32;
        pos += 32;
        continue;
      }
      const z = Math.clz32(w);
      this.pos = pos + z + 1;
      return n + z;
    }
  }
  align() { this.pos = (this.pos + 7) & ~7; }
}

// The second-extension table: code m stands for the pair (a, b) with m = (a+b)(a+b+1)/2 + b.
const SE = (() => {
  const t = new Int32Array(2 * 91);
  let k = 0;
  for (let i = 0; i < 13; i++) {
    const ms = k;
    for (let j = 0; j <= i; j++) { t[2 * k] = i; t[2 * k + 1] = ms; k++; }
  }
  return t;
})();

/**
 * @param {Uint8Array} data  the compressed stream (GRIB2 section 7's payload)
 * @param {number} n  how many samples to produce
 * @param {{bitsPerSample:number, flags:number, blockSize:number, rsi:number}} opts
 * @returns {Float64Array}
 */
export function aecDecode(data, n, { bitsPerSample: bps, flags, blockSize, rsi }) {
  const out = new Float64Array(n);
  if (n === 0 || bps === 0) return out;
  if (flags & AEC_DATA_SIGNED) throw new Error('AEC signed samples are not supported');
  if (![8, 16, 32, 64].includes(blockSize)) throw new Error(`AEC block size ${blockSize} is not valid`);

  const pp = !!(flags & AEC_DATA_PREPROCESS);
  let idLen;
  if (bps > 16) idLen = 5;
  else if (bps > 8) idLen = 4;
  else if ((flags & AEC_RESTRICTED) && bps <= 4) idLen = bps <= 2 ? 1 : 2;
  else idLen = 3;
  const uncompId = (1 << idLen) - 1;

  const bits = new Bits(data);
  const fsv = new Float64Array(64); // one block's fundamental sequences, reused
  let k = 0; // samples produced; past `n` (a last block's padding) writes go nowhere

  while (k < n) {
    // One reference sample interval.
    const rsiStart = k;
    for (let block = 0; block < rsi && k < n;) {
      const ref = pp && block === 0 ? 1 : 0;
      const id = bits.read(idLen);
      if (id === 0) {
        const second = bits.read(1);
        if (ref) out[k++] = bits.read(bps);
        if (second) {
          for (let i = ref; i < blockSize;) {
            const m = bits.fs();
            if (m > 90) throw new Error('AEC second-extension code out of range');
            const d1 = m - SE[2 * m + 1];
            if ((i & 1) === 0) { out[k++] = SE[2 * m] - d1; i++; }
            out[k++] = d1;
            i++;
          }
          block++;
        } else {
          let zeroBlocks = bits.fs() + 1;
          if (zeroBlocks === ROS) {
            const b = Math.floor((k - rsiStart) / blockSize);
            zeroBlocks = Math.min(rsi - b, 64 - (b % 64));
          } else if (zeroBlocks > ROS) {
            zeroBlocks--;
          }
          // The array starts as zeros, so these need only be counted.
          k += zeroBlocks * blockSize - ref;
          block += zeroBlocks;
        }
      } else if (id === uncompId) {
        for (let i = 0; i < blockSize; i++) out[k++] = bits.read(bps);
        block++;
      } else {
        const kk = id - 1;
        if (ref) out[k++] = bits.read(bps);
        const count = blockSize - ref;
        for (let i = 0; i < count; i++) fsv[i] = bits.fs();
        if (kk) {
          const scale = 1 << kk;
          for (let i = 0; i < count; i++) out[k++] = fsv[i] * scale + bits.read(kk);
        } else {
          for (let i = 0; i < count; i++) out[k++] = fsv[i];
        }
        block++;
      }
    }
    if (flags & AEC_PAD_RSI) bits.align();

    if (pp) {
      // Undo the predictor over this RSI: the first sample is the reference itself.
      const xmax = 2 ** bps - 1;
      const med = Math.floor(xmax / 2) + 1;
      const end = Math.min(k, n);
      let data0 = out[rsiStart];
      if (bps <= 30) {
        // The same in integer arithmetic, which fits below 2^31.
        for (let i = rsiStart + 1; i < end; i++) {
          const d = out[i];
          const high = data0 >= med;
          const theta = high ? xmax - data0 : data0;
          if ((d + 1) >> 1 <= theta) data0 += d & 1 ? -((d + 1) >> 1) : d >> 1;
          else data0 = high ? xmax - d : d;
          out[i] = data0;
        }
        continue;
      }
      for (let i = rsiStart + 1; i < end; i++) {
        const d = out[i];
        const halfD = Math.floor(d / 2) + (d % 2);
        const high = data0 >= med;
        const theta = high ? xmax - data0 : data0;
        if (halfD <= theta) {
          data0 += d % 2 ? -(d + 1) / 2 : d / 2;
        } else {
          data0 = high ? xmax - d : d;
        }
        out[i] = data0;
      }
    }
  }
  return out;
}
