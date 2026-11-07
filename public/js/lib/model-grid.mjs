// Where a latitude and longitude fall on a model's grid.
//
// A decoded GRIB2 field is a flat array in the grid's own scanning order; drawing it
// on the map means asking, for every output pixel, which grid point lies under it. The
// grids in use answer that differently — a regular latitude/longitude grid by division,
// a rotated one by turning the sphere first, a Lambert conformal or polar stereographic
// one by projecting first — so each gets a locator that returns fractional column and
// row, and `sampler` turns those into a value.

const RAD = Math.PI / 180;

/** Scanning-mode flags (GRIB2 table 3.4). */
const I_NEGATIVE = 0x80;
const J_POSITIVE = 0x40;
const J_CONSECUTIVE = 0x20;

/** Bring a longitude into [-180, 180). */
const wrap180 = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;

/**
 * A conic grid's cone: Lambert's constant `n` and scale `F` from its two standard
 * parallels. Polar stereographic is the same projection with the cone pressed flat into
 * a plane — n is 1, and F is set by the latitude its spacing is true at.
 */
export function cone(grid) {
  if (grid.kind === 'polar') return { n: 1, F: 1 + Math.sin(grid.lad * RAD) };
  const p1 = grid.latin1 * RAD;
  const p2 = grid.latin2 * RAD;
  const t = (p) => Math.tan(Math.PI / 4 + p / 2);
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  return { n, F: (Math.cos(p1) * t(p1) ** n) / n };
}

const conic = (grid) => grid.kind === 'lambert' || grid.kind === 'polar';

/** Mercator's stretched latitude. */
const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));

/**
 * A Mercator grid placed by its corners: the fractional column of a longitude and row
 * of a latitude, and back. Taken from the corners rather than the spacing, so the
 * radius and the true-scale latitude cannot put it a cell out.
 */
export function mercator(grid) {
  const span = ((((grid.lo2 - grid.lo1) % 360) + 360) % 360) || 360;
  const y1 = mercY(grid.la1);
  const y2 = mercY(grid.la2);
  const cols = grid.nx - 1;
  const rows = grid.ny - 1;
  return {
    col: (lon) => ((((lon - grid.lo1) % 360) + 540) % 360 - 180) / span * cols,
    row: (lat) => ((mercY(lat) - y1) / (y2 - y1)) * rows,
    lon: (i) => wrap180(grid.lo1 + (i / cols) * span),
    lat: (j) => (2 * Math.atan(Math.exp(y1 + (j / rows) * (y2 - y1))) - Math.PI / 2) / RAD,
  };
}

/**
 * A rotated grid's turn of the sphere, both ways. GRIB2 names it by where the turn
 * moved the south pole: first round the polar axis by that pole's longitude, then
 * down the turned Greenwich meridian by 90° plus its latitude.
 */
export function rotation(grid) {
  const b = (90 + grid.spLat) * RAD;
  const cb = Math.cos(b);
  const sb = Math.sin(b);
  const lp = grid.spLon;
  const clamp = (v) => Math.max(-1, Math.min(1, v));
  return {
    /** The grid's own [latitude, longitude] of a place. */
    to(lat, lon) {
      const p = lat * RAD;
      const l = (lon - lp) * RAD;
      const x = Math.cos(p) * Math.cos(l);
      const y = Math.cos(p) * Math.sin(l);
      const z = Math.sin(p);
      return [Math.asin(clamp(-sb * x + cb * z)) / RAD, Math.atan2(y, cb * x + sb * z) / RAD];
    },
    /** And back: the place at the grid's own latitude and longitude. */
    from(latr, lonr) {
      const p = latr * RAD;
      const l = lonr * RAD;
      const x = Math.cos(p) * Math.cos(l);
      const y = Math.cos(p) * Math.sin(l);
      const z = Math.sin(p);
      return [Math.asin(clamp(sb * x + cb * z)) / RAD, wrap180(Math.atan2(y, cb * x - sb * z) / RAD + lp)];
    },
  };
}

/**
 * @returns {(lat:number, lon:number) => [number, number]}  fractional [col, row] in the
 *   array's own order, possibly outside 0..n-1 when the point is off the grid
 */
export function locator(grid) {
  if (grid.scan & J_CONSECUTIVE) throw new Error('column-major GRIB2 grids are not supported');
  const iSign = grid.scan & I_NEGATIVE ? -1 : 1;
  const jNorth = !!(grid.scan & J_POSITIVE);

  if (grid.kind === 'latlon') {
    const global = Math.abs(grid.nx * grid.dx - 360) < grid.dx / 2;
    // A regional grid's columns counted from its first, within half a turn of its
    // middle: a grid wider than half the globe (ICON's lattice, -180° to 65°) keeps its
    // eastern part, which counting within half a turn of its first column would lose.
    const mid = ((grid.nx - 1) * grid.dx) / 2;
    return (lat, lon) => {
      let dl = (lon - grid.lo1) * iSign;
      if (global) dl = ((dl % 360) + 360) % 360;
      else dl -= 360 * Math.round((dl - mid) / 360);
      const i = dl / grid.dx;
      const j = (jNorth ? lat - grid.la1 : grid.la1 - lat) / grid.dy;
      return [i, j];
    };
  }

  if (grid.kind === 'rotated') {
    // A regular lattice in the turned sphere's own latitude and longitude.
    const rot = rotation(grid);
    const flat = locator({ ...grid, kind: 'latlon' });
    return (lat, lon) => {
      const [a, b] = rot.to(lat, lon);
      return flat(a, b);
    };
  }

  if (grid.kind === 'mercator') {
    const m = mercator(grid);
    return (lat, lon) => [m.col(lon), m.row(lat)];
  }

  if (conic(grid)) {
    const R = grid.radius;
    const { n, F } = cone(grid);
    const t = (p) => Math.tan(Math.PI / 4 + p / 2);
    const lov = grid.lov * RAD;
    const xy = (lat, lon) => {
      const rho = (R * F) / t(lat * RAD) ** n;
      let dl = lon * RAD - lov;
      dl = ((dl + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      const th = n * dl;
      return [rho * Math.sin(th), -rho * Math.cos(th)];
    };
    const [x1, y1] = xy(grid.la1, grid.lo1);
    return (lat, lon) => {
      const [x, y] = xy(lat, lon);
      return [((x - x1) * iSign) / grid.dx, (jNorth ? y - y1 : y1 - y) / grid.dy];
    };
  }
  throw new Error(`no locator for a ${grid.kind} grid`);
}

/** The latitude of grid point k, counted in the field's flat (row-major) order. */
export function latitudeOf(grid) {
  const jNorth = !!(grid.scan & J_POSITIVE);
  if (grid.kind === 'latlon') return (k) => grid.la1 + (jNorth ? 1 : -1) * Math.floor(k / grid.nx) * grid.dy;
  const back = inverse(grid);
  return (k) => back(k % grid.nx, Math.floor(k / grid.nx))[0];
}

/** The [latitude, longitude] of grid point k, counted in the field's flat (row-major) order. */
export function placeOf(grid) {
  if (grid.kind === 'latlon') {
    const jNorth = !!(grid.scan & J_POSITIVE);
    return (k) => [grid.la1 + (jNorth ? 1 : -1) * Math.floor(k / grid.nx) * grid.dy, grid.lo1 + (k % grid.nx) * grid.dx];
  }
  const back = inverse(grid);
  return (k) => back(k % grid.nx, Math.floor(k / grid.nx));
}

/** Grid position back to [latitude, longitude], exactly. */
function inverse(grid) {
  const iSign = grid.scan & I_NEGATIVE ? -1 : 1;
  const jNorth = !!(grid.scan & J_POSITIVE);
  if (grid.kind === 'rotated') {
    const rot = rotation(grid);
    return (i, j) => rot.from(grid.la1 + (jNorth ? j : -j) * grid.dy, grid.lo1 + iSign * i * grid.dx);
  }
  if (grid.kind === 'mercator') {
    const m = mercator(grid);
    return (i, j) => [m.lat(j), m.lon(i)];
  }
  const R = grid.radius;
  const { n, F } = cone(grid);
  const t = (p) => Math.tan(Math.PI / 4 + p / 2);
  const lov = wrap180(grid.lov);
  let dl = (grid.lo1 - lov) * RAD;
  dl = ((dl + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const rho1 = (R * F) / t(grid.la1 * RAD) ** n;
  const x1 = rho1 * Math.sin(n * dl);
  const y1 = -rho1 * Math.cos(n * dl);
  return (i, j) => {
    const x = x1 + iSign * i * grid.dx;
    const y = jNorth ? y1 + j * grid.dy : y1 - j * grid.dy;
    const rho = Math.sign(n) * Math.hypot(x, y);
    const th = n > 0 ? Math.atan2(x, -y) : Math.atan2(-x, y);
    const lat = 2 * Math.atan(((R * F) / rho) ** (1 / n)) - Math.PI / 2;
    return [lat / RAD, lov + th / n / RAD];
  };
}

/**
 * The latitude/longitude box a grid covers, found by walking its edge — a Lambert
 * grid's corners alone miss the bulge of its northern edge. Each longitude is carried
 * on from the one before, so a grid across the date line stays one piece (Alaska's
 * reach from -195° to -105°); a grid with a pole inside it comes back round a whole
 * turn of longitude and says so with `pole`.
 */
export function bounds(grid) {
  if (grid.kind === 'latlon') {
    const south = Math.min(grid.la1, grid.la1 + (grid.scan & J_POSITIVE ? 1 : -1) * (grid.ny - 1) * grid.dy);
    const north = Math.max(grid.la1, grid.la1 + (grid.scan & J_POSITIVE ? 1 : -1) * (grid.ny - 1) * grid.dy);
    const global = Math.abs(grid.nx * grid.dx - 360) < grid.dx / 2;
    if (global) return { west: -180, east: 180, south, north, global: true };
    let west = grid.lo1 > 180 ? grid.lo1 - 360 : grid.lo1;
    const east = west + (grid.nx - 1) * grid.dx;
    return { west, east, south, north, global: false };
  }
  const inv = inverse(grid);
  const { nx, ny } = grid;
  const steps = 64;
  const edge = [];
  for (let s = 0; s < steps; s++) edge.push([(s / steps) * (nx - 1), 0]);
  for (let s = 0; s < steps; s++) edge.push([nx - 1, (s / steps) * (ny - 1)]);
  for (let s = 0; s < steps; s++) edge.push([(1 - s / steps) * (nx - 1), ny - 1]);
  for (let s = 0; s < steps; s++) edge.push([0, (1 - s / steps) * (ny - 1)]);
  const near = (lon, ref) => ref + wrap180(lon - ref);
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  let first = null;
  let prev = null;
  for (const [i, j] of edge) {
    const [lat, raw] = inv(i, j);
    const lon = prev == null ? raw : near(raw, prev);
    if (first == null) first = lon;
    prev = lon;
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  if (Math.abs(near(first, prev) - first) > 180) return { west: -180, east: 180, south, north: 90, global: false, pole: true };
  // Centred on the map's own longitudes, whichever turn the walk ended up on.
  const shift = Math.round((west + east) / 2 / 360) * 360;
  return { west: west - shift, east: east - shift, south, north, global: false };
}

/**
 * A value at a latitude/longitude: bilinear between the four surrounding points, or
 * the nearest one where `nearest` is asked for (categories, which do not average).
 * NaN off the grid or where any neighbour is missing.
 */
export function sampler(grid, values, { nearest = false } = {}) {
  const loc = locator(grid);
  const { nx, ny } = grid;
  const wrap = grid.kind === 'latlon' && Math.abs(nx * grid.dx - 360) < grid.dx / 2;
  return (lat, lon) => {
    const [fi, fj] = loc(lat, lon);
    return valueAt(values, nx, ny, wrap, fi, fj, nearest);
  };
}

export function valueAt(values, nx, ny, wrap, fi, fj, nearest) {
  if (fj < 0 || fj > ny - 1) return NaN;
  if (!wrap && (fi < 0 || fi > nx - 1)) return NaN;
  if (nearest) {
    let i = Math.round(fi);
    const j = Math.round(fj);
    if (wrap) i = ((i % nx) + nx) % nx;
    return values[j * nx + i];
  }
  let i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const di = fi - i0, dj = fj - j0;
  let i1 = i0 + 1;
  const j1 = Math.min(j0 + 1, ny - 1);
  if (wrap) { i0 = ((i0 % nx) + nx) % nx; i1 = (i0 + 1) % nx; } else if (i1 > nx - 1) i1 = nx - 1;
  const a = values[j0 * nx + i0], b = values[j0 * nx + i1];
  const c = values[j1 * nx + i0], d = values[j1 * nx + i1];
  return (a * (1 - di) + b * di) * (1 - dj) + (c * (1 - di) + d * di) * dj;
}

/**
 * How far a grid's winds are turned from true north where they run along the grid's
 * own axes: the bearing of its "up" at a place, clockwise from north. A conic grid's
 * turn depends on longitude alone; a rotated one's is found by stepping a little up
 * its own meridian and taking the bearing of the step.
 *
 * @returns {((lat:number, lon:number) => number) | null}  radians, or null for winds
 *   already along east and north
 */
export function gridTurn(grid) {
  if (!grid.uvGrid) return null;
  if (conic(grid)) {
    const { n } = cone(grid);
    return (lat, lon) => {
      let dl = lon - grid.lov;
      dl = ((dl + 540) % 360) - 180;
      return n * dl * RAD;
    };
  }
  if (grid.kind === 'rotated') {
    const rot = rotation(grid);
    return (lat, lon) => {
      const [a, b] = rot.to(lat, lon);
      const [lat2, lon2] = rot.from(a + 0.01, b);
      const p1 = lat * RAD;
      const p2 = lat2 * RAD;
      const dl = (lon2 - lon) * RAD;
      return Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
    };
  }
  return null;
}

/**
 * The horizontal divergence of a wind (∂u/∂x + ∂v/∂y), in 10⁻⁵ s⁻¹, at every point of its
 * grid, smoothed over about `smoothKm`. Worked out from where each point's neighbours
 * really are (east and west of it along the row, north and south along the column), so a
 * grid of any projection, and its map factor, are taken as they come; winds given along
 * the grid are turned to east and north first. The edges, and within 5° of a pole, are NaN.
 */
export function divergence(grid, u, v, smoothKm = 40) {
  const { nx, ny } = grid;
  const N = nx * ny;
  const place = placeOf(grid);
  const turn = gridTurn(grid);
  const wrap = grid.kind === 'latlon' && Math.abs(nx * grid.dx - 360) < grid.dx / 2;
  const lat = new Float32Array(N);
  const lon = new Float32Array(N);
  const ue = new Float32Array(N);
  const ve = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    const [la, lo] = place(k);
    lat[k] = la;
    lon[k] = lo;
    let a = u[k];
    let b = v[k];
    if (turn) {
      const t = turn(la, lo);
      [a, b] = [Math.cos(t) * a + Math.sin(t) * b, -Math.sin(t) * a + Math.cos(t) * b];
    }
    ue[k] = a;
    ve[k] = b;
  }
  const div = new Float32Array(N).fill(NaN);
  // Metres east and north from one point to another, near enough at a grid's spacing.
  const east = (p, q) => {
    let dl = lon[q] - lon[p];
    if (dl > 180) dl -= 360; else if (dl < -180) dl += 360;
    return dl * 111320 * Math.cos(((lat[p] + lat[q]) / 2) * RAD);
  };
  const north = (p, q) => (lat[q] - lat[p]) * 110540;
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (Math.abs(lat[k]) > 85) continue;
      let w = i - 1;
      let e = i + 1;
      if (w < 0) { if (!wrap) continue; w = nx - 1; }
      if (e >= nx) { if (!wrap) continue; e = 0; }
      const kw = j * nx + w;
      const ke = j * nx + e;
      const ks = k - nx;
      const kn = k + nx;
      // Two steps across the point, and the wind's change along each.
      const ax = east(kw, ke); const ay = north(kw, ke);
      const bx = east(ks, kn); const by = north(ks, kn);
      const det = ax * by - ay * bx;
      if (!det) continue;
      const dua = ue[ke] - ue[kw]; const dub = ue[kn] - ue[ks];
      const dva = ve[ke] - ve[kw]; const dvb = ve[kn] - ve[ks];
      const ux = (dua * by - ay * dub) / det;
      const vy = (ax * dvb - dva * bx) / det;
      const d = (ux + vy) * 1e5;
      if (d === d) div[k] = d;
    }
  }
  // Smoothed: a box mean twice over (near a Gaussian), its width the grid's points in smoothKm.
  const cellKm = grid.kind === 'latlon' || grid.kind === 'rotated' ? grid.dx * 111 : grid.dx / 1000;
  const r = Math.max(0, Math.round(smoothKm / Math.max(cellKm, 0.1) / 2));
  return r ? boxMean(boxMean(div, nx, ny, r, wrap), nx, ny, r, wrap) : div;
}

/** A NaN-aware box mean `r` points each way, along rows then columns. */
function boxMean(values, nx, ny, r, wrap) {
  const tmp = new Float32Array(values.length);
  const out = new Float32Array(values.length);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let s = 0; let n = 0;
      for (let d = -r; d <= r; d++) {
        let ii = i + d;
        if (ii < 0 || ii >= nx) { if (!wrap) continue; ii = (ii + nx) % nx; }
        const x = values[j * nx + ii];
        if (x === x) { s += x; n++; }
      }
      tmp[j * nx + i] = n ? s / n : NaN;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      let s = 0; let n = 0;
      for (let d = -r; d <= r; d++) {
        const jj = j + d;
        if (jj < 0 || jj >= ny) continue;
        const x = tmp[jj * nx + i];
        if (x === x) { s += x; n++; }
      }
      // Kept empty where the field itself is (an edge, a pole), not filled from beside it.
      out[j * nx + i] = n && values[j * nx + i] === values[j * nx + i] ? s / n : NaN;
    }
  }
  return out;
}
