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

class Bits {
  constructor(bytes) { this.b = bytes; this.pos = 0; this.end = bytes.length * 8; }
  read(n) {
    let v = 0;
    let pos = this.pos;
    const b = this.b;
    for (let left = n; left > 0;) {
      const off = pos & 7;
      const take = Math.min(8 - off, left);
      v = v * (1 << take) + ((b[pos >>> 3] >>> (8 - off - take)) & ((1 << take) - 1));
      pos += take;
      left -= take;
    }
    this.pos = pos;
    return v;
  }
  /** A fundamental sequence: the number of zero bits before the next one. */
  fs() {
    const b = this.b;
    let pos = this.pos;
    let n = 0;
    for (;;) {
      if (pos >= this.end) throw new Error('AEC stream ended inside a code');
      const off = pos & 7;
      const rest = (b[pos >>> 3] << off) & 0xff; // the unread bits of this byte, left-aligned
      if (rest === 0) {
        n += 8 - off;
        pos += 8 - off;
        continue;
      }
      const z = Math.clz32(rest) - 24;
      n += z;
      pos += z + 1;
      this.pos = pos;
      return n;
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
  const rsiSamples = rsi * blockSize;
  let k = 0; // samples written to `out`

  while (k < n) {
    // One reference sample interval.
    const rsiStart = k;
    let used = 0; // samples produced in this RSI
    const put = (v) => { if (k < n) out[k] = v; k++; used++; };
    for (let block = 0; block < rsi && k < n;) {
      const ref = pp && block === 0 ? 1 : 0;
      const id = bits.read(idLen);
      if (id === 0) {
        const second = bits.read(1);
        if (ref) put(bits.read(bps));
        if (second) {
          for (let i = ref; i < blockSize;) {
            const m = bits.fs();
            if (m > 90) throw new Error('AEC second-extension code out of range');
            const d1 = m - SE[2 * m + 1];
            if ((i & 1) === 0) { put(SE[2 * m] - d1); i++; }
            put(d1);
            i++;
          }
          block++;
        } else {
          let zeroBlocks = bits.fs() + 1;
          if (zeroBlocks === ROS) {
            const b = Math.floor(used / blockSize);
            zeroBlocks = Math.min(rsi - b, 64 - (b % 64));
          } else if (zeroBlocks > ROS) {
            zeroBlocks--;
          }
          const zeros = zeroBlocks * blockSize - ref;
          for (let i = 0; i < zeros; i++) put(0);
          block += zeroBlocks;
        }
      } else if (id === uncompId) {
        for (let i = 0; i < blockSize; i++) put(bits.read(bps));
        block++;
      } else {
        const kk = id - 1;
        if (ref) put(bits.read(bps));
        const count = blockSize - ref;
        const start = k;
        const fsv = new Float64Array(count);
        for (let i = 0; i < count; i++) fsv[i] = bits.fs();
        for (let i = 0; i < count; i++) put(kk ? fsv[i] * (1 << kk) + bits.read(kk) : fsv[i]);
        void start;
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
    void rsiSamples;
  }
  return out;
}
