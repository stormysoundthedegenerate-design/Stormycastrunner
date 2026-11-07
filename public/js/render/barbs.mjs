// Wind barbs, drawn rather than shipped.
//
// A barb is read by counting: a pennant is fifty knots, a full barb ten, a half barb
// five, and the staff points into the wind. That is a fixed vocabulary, so one sprite
// per five knots covers every speed a surface station will report, and the map rotates
// whichever one it needs.
//
// The staff runs up the sprite from the station at the bottom, which is what lets the
// renderer rotate by the wind direction and have the staff end up pointing at where
// the wind is coming from.

const STEP = 5;        // knots per sprite
const MAX = 120;       // beyond this the barb stops gaining feathers
const W = 44;          // sprite, at the 2x it is registered with
const H = 60;
const STAFF = 46;      // length of the staff in sprite pixels

let sheet = null;

/** Every sprite name the map may ask for, and the speed each stands for. */
export function barbSpeeds() {
  const out = [];
  for (let kt = 0; kt <= MAX; kt += STEP) out.push(kt);
  return out;
}

/** The sprite name for a speed, rounded to the nearest five knots. */
export const barbName = (kt) => {
  const n = Math.max(0, Math.min(MAX, Math.round((Number(kt) || 0) / STEP) * STEP));
  return `barb-${n}`;
};

/**
 * One barb, as image data ready for addImage.
 *
 * @param {number} kt Wind speed in knots.
 * @param {string} colour
 * @param {string} [outline]  drawn first and wider, so the barb reads over colour as
 *   well as over the dark basemap (the model barbs ask for it; METARs do not)
 */
export function barbSprite(kt, colour = '#eaf8ff', outline = null) {
  // One canvas for them all, kept in memory rather than on the GPU: each sprite is read
  // back, and reading a GPU canvas back waits for the GPU (some 30 ms a sprite).
  sheet ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const g = sheet;
  g.canvas.width = W; // and cleared, with its state
  g.canvas.height = H;
  if (outline) drawBarb(g, kt, outline, 2.6);
  drawBarb(g, kt, colour, 0);
  return image(g);
}

function drawBarb(g, kt, colour, widen) {
  g.strokeStyle = colour;
  g.fillStyle = colour;
  g.lineWidth = 2.4 + widen;
  g.lineCap = 'round';
  g.lineJoin = 'round';

  const x = W / 2;
  const base = H - 4;            // the station end
  const tip = base - STAFF;      // the far end, where the feathers go

  // Calm is a ring, not a staff: there is no direction to point.
  if (kt < 3) {
    g.lineWidth = 2.2 + widen;
    g.beginPath();
    g.arc(x, base - 8, 6, 0, Math.PI * 2);
    g.stroke();
    return;
  }

  g.beginPath();
  g.moveTo(x, base);
  g.lineTo(x, tip);
  g.stroke();

  let left = Math.round(kt / STEP) * STEP;
  let at = tip;
  const gap = 5.5;
  const span = 15;               // how far a full barb reaches from the staff
  const lean = 5;                // and how far along it, so it rakes back

  // Pennants first, then full barbs, then a half: the order they are read in.
  while (left >= 50) {
    g.beginPath();
    g.moveTo(x, at);
    g.lineTo(x + span, at + lean);
    g.lineTo(x, at + gap * 1.6);
    g.closePath();
    g.fill();
    if (widen) g.stroke();
    at += gap * 1.9;
    left -= 50;
  }
  // A pennant and a barb should not touch.
  if (at > tip && left > 0) at += 1.5;

  while (left >= 10) {
    g.beginPath();
    g.moveTo(x, at);
    g.lineTo(x + span, at + lean);
    g.stroke();
    at += gap;
    left -= 10;
  }
  if (left >= 5) {
    // A lone half barb sits one place in from the end, or it reads as a full one.
    if (at === tip) at += gap;
    g.beginPath();
    g.moveTo(x, at);
    g.lineTo(x + span * 0.55, at + lean * 0.55);
    g.stroke();
  }
}

function image(g) {
  const { data, width, height } = g.getImageData(0, 0, W, H);
  return { width, height, data: new Uint8Array(data.buffer) };
}
