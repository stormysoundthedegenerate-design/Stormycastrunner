// JPEG 2000, for GRIB2's packing 5.40: RAP and the Canadian models pack their fields
// this way. Two decoders, both loaded only the first time a message needs one, so no
// other model pays for them, and handed to the GRIB2 reader, which from then on decodes
// such a field as it does any other:
//
//   OpenJPEG built to WebAssembly (vendor/openjpeg), a quarter of a megabyte, for most
//   fields: a 2400 × 1201 global grid in about a fifth of a second. Its wrapper keeps an
//   image's width and its samples to 16 bits each, though.
//
//   pdf.js's decoder made exact (vendor/jpx, see scripts/vendor.mjs), about half as
//   fast, for the fields past either: the Canadian models code precipitation, CAPE and
//   helicity at 24 bits, and a field with gaps in it as one row a million values long.

import { setJpeg2000 } from './grib2.mjs';

let ready = null;

/** The image a codestream holds, from its SIZ marker: size, and bits a sample. */
function shapeOf(cs) {
  if (cs[0] !== 0xff || cs[1] !== 0x4f || cs[2] !== 0xff || cs[3] !== 0x51) return null;
  const u32 = (o) => ((cs[o] << 24) | (cs[o + 1] << 16) | (cs[o + 2] << 8) | cs[o + 3]) >>> 0;
  return { width: u32(8) - u32(16), height: u32(12) - u32(20), bits: (cs[42] & 0x7f) + 1 };
}

/** Load the decoders, once, and give them to the GRIB2 reader. */
export function loadJpeg2000() {
  ready ||= (async () => {
    const [{ default: factory }, { JpxImage }] = await Promise.all([
      import('../../vendor/openjpeg/openjpegwasm_decode.js'),
      import('../../vendor/jpx/jpx.mjs'),
    ]);
    const openjpeg = await factory({
      locateFile: (file) => new URL(`../../vendor/openjpeg/${file}`, import.meta.url).href,
      // It narrates every header it reads; nobody is listening.
      print() {},
      printErr() {},
    });

    const viaWasm = (codestream, n) => {
      const decoder = new openjpeg.J2KDecoder();
      try {
        decoder.getEncodedBuffer(codestream.length).set(codestream);
        decoder.decode();
        const { bitsPerSample } = decoder.getFrameInfo();
        const raw = decoder.getDecodedBuffer();
        // Copied out: the decoder's memory is its own and is let go of below.
        return bitsPerSample > 8
          ? new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + n * 2))
          : raw.slice(0, n);
      } finally {
        decoder.delete();
      }
    };

    const viaJpx = (codestream, n) => {
      const image = new JpxImage();
      image.parse(codestream);
      const { tiles } = image;
      if (tiles.length === 1) return tiles[0].items.subarray(0, n);
      // In several tiles: each laid into its place in the whole.
      const out = new Float64Array(image.width * image.height);
      for (const t of tiles) {
        for (let y = 0; y < t.height; y++) out.set(t.items.subarray(y * t.width, (y + 1) * t.width), (t.top + y) * image.width + t.left);
      }
      return out.subarray(0, n);
    };

    setJpeg2000((codestream, n) => {
      const shape = shapeOf(codestream);
      const big = shape && (shape.width > 0xffff || shape.height > 0xffff || shape.bits > 16);
      return big ? viaJpx(codestream, n) : viaWasm(codestream, n);
    });
  })();
  ready.catch(() => { ready = null; });
  return ready;
}
