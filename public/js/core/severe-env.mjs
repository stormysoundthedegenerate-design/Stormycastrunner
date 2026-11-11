// The storm environment at a point, from a coarse pressure-level profile: the inputs of
// Stormycast, Nexradar's outlook model (scripts/stormycast-*.mjs). Training reads ERA5 and the daily runs
// read ECMWF's open forecasts, so both come here through the same few levels (1000, 925,
// 850, 700, 500, 300, 250 and 200 hPa, temperature to the top, moisture and wind to 300)
// and get the same arithmetic, whatever either model says about its own CAPE.
//
// Heights come from the hypsometric equation upward from the ground (the surface pressure
// and height). Parcels are lifted on a 20 hPa grid: dry to the lifting level (Bolton),
// then along the saturated equivalent potential temperature. Virtual temperature for
// both. The southern hemisphere is mirrored: the left-moving storm and helicity's sign
// turned, so a hemisphere doesn't change what the model has learnt.

const RD = 287.04;
const G = 9.80665;
const KAPPA = 0.2857;
const LEVELS = [1000, 925, 850, 700, 500, 300, 250, 200];
export const OUTLOOK_LEVELS = LEVELS;
export const WIND_LEVELS = [1000, 925, 850, 700, 500, 300];

export const ENV_FEATURES = [
  'sbcape', 'sbcin', 'mlcape', 'mlcin', 'mucape', 'mllcl', 'lapse75', 'lapse03', 'td2', 'pw', 'q850',
  'rh75', 'thetaeDrop', 'frz', 'shr1', 'shr3', 'shr6', 'srh1', 'srh3', 'wind850', 'wind500', 'wind10',
  'storm', 'stp', 'scp', 'elev',
  // Hail (added 2026-11-10; models fitted before then don't read them): the most unstable
  // parcel's CAPE where the air is −10 to −30 °C (the hail-growth layer) and the height of
  // the wet-bulb zero above the ground (hail melts on the way down below it).
  'hgzCape', 'wbz',
];

const es = (t) => 6.112 * Math.exp((17.67 * (t - 273.15)) / (t - 29.65)); // hPa
const mix = (e, p) => (0.622 * e) / Math.max(1e-3, p - e);
const tdOfE = (e) => { const l = Math.log(Math.max(1e-6, e) / 6.112); return (243.5 * l) / (17.67 - l) + 273.15; };
const tLcl = (t, td) => 1 / (1 / (td - 56) + Math.log(t / td) / 800) + 56;
function thetaE(t, p, r, tl) {
  const rg = r * 1000;
  return t * (1000 / p) ** (0.2854 * (1 - 0.00028 * rg)) * Math.exp((3.376 / tl - 0.00254) * rg * (1 + 0.00081 * rg));
}
const thetaES = (t, p) => thetaE(t, p, mix(es(t), p), t);
/** The saturated parcel's temperature at p for a given θe (bisection). */
function moistT(te, p) {
  let lo = 150;
  let hi = 340;
  for (let k = 0; k < 18; k++) {
    const mid = (lo + hi) / 2;
    if (thetaES(mid, p) > te) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The environment at a point. `c` = { ps (hPa), zs (m), t2, d2 (K), u10, v10 (m/s),
 * t: {hPa: K}, q: {hPa: kg/kg}, u, v: {hPa: m/s}, lat }. Returns an object keyed by
 * ENV_FEATURES (NaN where it can't be said).
 */
export function environment(c) {
  const ps = c.ps;
  // The known points from the ground up: [p, T, q, z]. q above its top level is ~0.
  const e2 = es(c.d2);
  const q2 = (0.622 * e2) / (ps - 0.378 * e2);
  const pts = [[ps, c.t2, q2, c.zs]];
  for (const p of LEVELS) {
    if (p >= ps - 5) continue;
    const [pp, tp, qp, zp] = pts.at(-1);
    const q = c.q[p] ?? 0;
    const tv = (c.t[p] * (1 + 0.608 * q) + tp * (1 + 0.608 * qp)) / 2;
    pts.push([p, c.t[p], q, zp + ((RD * tv) / G) * Math.log(pp / p)]);
  }
  const top = pts.at(-1)[0];
  const atP = (p, k) => {
    for (let i = 1; i < pts.length; i++) {
      if (p >= pts[i][0]) {
        const a = pts[i - 1];
        const b = pts[i];
        const f = Math.log(a[0] / p) / Math.log(a[0] / b[0]);
        return a[k] + f * (b[k] - a[k]);
      }
    }
    return pts.at(-1)[k];
  };
  const zAgl = (p) => atP(p, 3) - c.zs;
  const pAtZ = (h) => {
    const z = c.zs + h;
    for (let i = 1; i < pts.length; i++) {
      if (pts[i][3] >= z) {
        const a = pts[i - 1];
        const b = pts[i];
        const f = (z - a[3]) / (b[3] - a[3]);
        return Math.exp(Math.log(a[0]) + f * (Math.log(b[0]) - Math.log(a[0])));
      }
    }
    return NaN;
  };
  // The 20 hPa column.
  const col = [];
  for (let p = ps; p >= Math.max(top, 150); p -= 20) {
    const t = atP(p, 1);
    const q = atP(p, 2);
    col.push({ p, t, q, r: q / (1 - q), tv: t * (1 + 0.608 * q), z: atP(p, 3) - c.zs });
  }
  if (col.length < 5) return null;

  // A parcel lifted from column level i0 with (t0, r0) at p0.
  const lift = (i0, p0, t0, r0) => {
    const td = Math.min(t0, tdOfE((r0 * p0) / (0.622 + r0)));
    const tl = tLcl(t0, td);
    const pl = p0 * (tl / t0) ** (1 / KAPPA);
    const te = thetaE(t0, p0, r0, tl);
    let cape = 0;
    let cin = 0;
    let hgz = 0; // the part of the CAPE where the air is −10 to −30 °C
    let lfc = false;
    let prev = null;
    for (let i = i0; i < col.length; i++) {
      const { p, tv, t } = col[i];
      let tvp;
      if (p >= pl) tvp = t0 * (p / p0) ** KAPPA * (1 + 0.608 * r0);
      else { const tp = moistT(te, p); tvp = tp * (1 + 0.608 * mix(es(tp), p)); }
      const b = tvp - tv;
      if (prev) {
        const area = RD * ((b + prev.b) / 2) * Math.log(prev.p / p);
        if (!lfc && p < pl && b > 0) lfc = true;
        if (lfc) {
          if (area > 0) {
            cape += area;
            const tm = (t + prev.t) / 2;
            if (tm <= 263.15 && tm >= 243.15) hgz += area;
          }
        } else if (area < 0) cin += area;
      }
      prev = { p, b, t };
    }
    return { cape, hgz, cin: lfc ? Math.max(-500, cin) : -500, lcl: Math.max(0, zAgl(Math.min(p0, pl))) };
  };
  const sb = lift(0, ps, c.t2, q2 / (1 - q2));
  // Mixed layer: the lowest 100 hPa, θ and mixing ratio averaged.
  let th = 0; let rr = 0; let n = 0;
  for (const l of col) { if (l.p < ps - 100) break; th += l.t * (1000 / l.p) ** KAPPA; rr += l.r; n++; }
  const ml = lift(0, ps, (th / n) * (ps / 1000) ** KAPPA, rr / n);
  // Most unstable: the level of highest θe in the lowest 300 hPa.
  let mi = 0; let best = -1;
  for (let i = 0; i < col.length && col[i].p >= ps - 300; i++) {
    const l = col[i];
    const tdl = Math.min(l.t, tdOfE((l.r * l.p) / (0.622 + l.r)));
    const te = thetaE(l.t, l.p, l.r, tLcl(l.t, tdl));
    if (te > best) { best = te; mi = i; }
  }
  const mu = lift(mi, col[mi].p, col[mi].t, col[mi].r);

  // Lapse rates, moisture.
  const lapse75 = ps > 720 ? ((atP(700, 1) - atP(500, 1)) / (atP(500, 3) - atP(700, 3))) * 1000 : NaN;
  const p3 = pAtZ(3000);
  const lapse03 = Number.isFinite(p3) ? ((c.t2 - atP(p3, 1)) / 3) : NaN;
  let pw = 0;
  for (let i = 1; i < col.length; i++) pw += (((col[i - 1].q + col[i].q) / 2) * (col[i - 1].p - col[i].p) * 100) / G;
  const rhAt = (p) => { const t = atP(p, 1); const q = atP(p, 2); return Math.min(1, (q * p) / (0.622 + 0.378 * q) / es(t)); };
  const rh75 = ps > 720 ? (rhAt(700) + rhAt(600) + rhAt(500)) / 3 : NaN;
  const teAt = (p) => { const t = atP(p, 1); const q = atP(p, 2); const r = q / (1 - q); const td = Math.min(t, tdOfE((r * p) / (0.622 + r))); return thetaE(t, p, r, tLcl(t, td)); };
  let teMin = Infinity;
  for (let p = Math.min(700, ps - 50); p >= 500; p -= 25) teMin = Math.min(teMin, teAt(p));
  const thetaeDrop = teAt(ps) - teMin;
  // The wet-bulb zero: the lowest height where the wet-bulb temperature (Stull 2011, from
  // temperature and relative humidity) falls below 0 °C; 0 where it is below at the ground.
  const wetBulb = (l) => {
    const tc = l.t - 273.15;
    const rh = Math.max(5, Math.min(99, 100 * Math.min(1, (l.q * l.p) / (0.622 + 0.378 * l.q) / es(l.t))));
    return tc * Math.atan(0.151977 * Math.sqrt(rh + 8.313659)) + Math.atan(tc + rh) - Math.atan(rh - 1.676331)
      + 0.00391838 * rh ** 1.5 * Math.atan(0.023101 * rh) - 4.686035;
  };
  let wbz = NaN;
  let twPrev = wetBulb(col[0]);
  if (twPrev <= 0) wbz = 0;
  for (let i = 1; i < col.length && !Number.isFinite(wbz); i++) {
    const tw = wetBulb(col[i]);
    if (tw <= 0) wbz = col[i - 1].z + (twPrev / (twPrev - tw)) * (col[i].z - col[i - 1].z);
    twPrev = tw;
  }
  let frz = 0;
  for (let i = 1; i < col.length; i++) {
    if (col[i].t < 273.15) {
      const a = col[i - 1];
      const b = col[i];
      frz = a.t <= 273.15 ? 0 : a.z + ((a.t - 273.15) / (a.t - b.t)) * (b.z - a.z);
      break;
    }
  }

  // Winds by height above ground: 10 m, then each wind level above the ground.
  const wpts = [[10, c.u10, c.v10]];
  for (const p of WIND_LEVELS) if (p < ps - 5 && c.u[p] != null) wpts.push([zAgl(p), c.u[p], c.v[p]]);
  const windAt = (h) => {
    if (h <= wpts[0][0]) return [wpts[0][1], wpts[0][2]];
    for (let i = 1; i < wpts.length; i++) {
      if (wpts[i][0] >= h) {
        const a = wpts[i - 1];
        const b = wpts[i];
        const f = (h - a[0]) / (b[0] - a[0]);
        return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
      }
    }
    return [wpts.at(-1)[1], wpts.at(-1)[2]];
  };
  const prof = [];
  for (let h = 0; h <= 6000; h += 250) prof.push(windAt(h));
  const mean = (a, b) => { let u = 0; let v = 0; for (let k = a; k <= b; k++) { u += prof[k][0]; v += prof[k][1]; } return [u / (b - a + 1), v / (b - a + 1)]; };
  const m06 = mean(0, 24);
  const lo = mean(0, 2);
  const hi = mean(22, 24);
  const sx = hi[0] - lo[0];
  const sy = hi[1] - lo[1];
  const sm = Math.hypot(sx, sy) || 1;
  const hemi = c.lat < 0 ? -1 : 1;
  // Bunkers: the right-mover north of the equator, the left-mover south.
  const cx = m06[0] + (7.5 * hemi * sy) / sm;
  const cy = m06[1] - (7.5 * hemi * sx) / sm;
  const srh = (k1) => {
    let s = 0;
    for (let k = 0; k < k1; k++) s += (prof[k + 1][0] - cx) * (prof[k][1] - cy) - (prof[k][0] - cx) * (prof[k + 1][1] - cy);
    return hemi * s;
  };
  const shr = (k) => Math.hypot(prof[k][0] - prof[0][0], prof[k][1] - prof[0][1]);
  const srh1 = srh(4);
  const srh3 = srh(12);
  const shr6 = shr(24);
  const sp = (p) => (c.u[p] != null && p < ps - 5 ? Math.hypot(c.u[p], c.v[p]) : NaN);

  const lclTerm = ml.lcl < 1000 ? 1 : ml.lcl > 2000 ? 0 : (2000 - ml.lcl) / 1000;
  const shrTerm = shr6 < 12.5 ? 0 : Math.min(1.5, shr6 / 20);
  const cinTerm = ml.cin > -50 ? 1 : ml.cin < -200 ? 0 : (200 + ml.cin) / 150;
  const stp = (ml.cape / 1500) * lclTerm * (Math.max(0, srh1) / 150) * shrTerm * cinTerm;
  const scp = (mu.cape / 1000) * (Math.max(0, srh3) / 50) * (shr6 < 10 ? 0 : Math.min(1, shr6 / 20));

  return {
    sbcape: sb.cape, sbcin: sb.cin, mlcape: ml.cape, mlcin: ml.cin, mucape: mu.cape, mllcl: ml.lcl,
    lapse75, lapse03, td2: c.d2 - 273.15, pw, q850: ps > 870 ? atP(850, 2) * 1000 : NaN,
    rh75, thetaeDrop, frz, shr1: shr(4), shr3: shr(12), shr6, srh1, srh3,
    wind850: sp(850), wind500: sp(500), wind10: Math.hypot(c.u10, c.v10), storm: Math.hypot(cx, cy),
    stp, scp, elev: c.zs,
    hgzCape: mu.hgz, wbz,
  };
}
