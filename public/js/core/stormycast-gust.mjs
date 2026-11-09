// Stormycast's gust factors, written by scripts/stormycast-gust-factor.mjs (2026-11-09).
// Airports outside the US: their share of thunderstorm days with a measured 40 kt+ gust over
// the US Southeast summer share (2.62%), at most 1. The wind models learned from US
// reports; where thunderstorms seldom make damaging outflow the runner scales them down.
// Each [station, lat, lon, factor, thunder days].
export const GUST_STATIONS = [["WSSS",1.37,103.98,0.092,1489],["WMKK",2.72,101.7,0.102,2071],["WIII",-6.13,106.66,0.104,1655],["WARR",-7.38,112.79,0.113,1181],["WBKK",5.94,116.05,0.119,1437],["FKKD",4.01,9.72,0.127,2356],["VCBI",7.18,79.88,0.134,1259],["FKYS",3.83,11.52,0.147,1993],["WAAA",-5.06,119.55,0.159,1269],["FOOL",0.46,9.41,0.166,1503],["SBBE",-1.38,-48.48,0.168,1652],["MROC",9.99,-84.21,0.189,1253],["VYYY",16.91,96.14,0.207,575],["FEFF",4.4,18.52,0.21,1677],["WIMM",3.56,98.67,0.217,1256],["MHTG",14.06,-87.22,0.239,798],["RPLL",14.51,121,0.246,614],["MPTO",9.05,-79.37,0.253,888],["RPVM",10.31,123.98,0.261,850],["FMMI",-18.8,47.48,0.264,1142],["VDPP",11.55,104.85,0.266,702],["SKBO",4.7,-74.15,0.277,783],["FCBB",-4.25,15.25,0.278,1467],["DIAP",5.26,-3.93,0.28,1316],["VOMM",12.99,80.18,0.281,655],["VVTS",10.82,106.67,0.295,1136],["SBPV",-8.77,-63.92,0.302,1578],["HRYR",-1.97,30.13,0.308,1204],["SBRB",-10,-67.8,0.32,1152],["VTBS",13.36,100.98,0.328,1006],["DGAA",5.61,-0.17,0.365,627],["SBBR",-15.87,-47.93,0.367,1194],["SBEG",-3.04,-60.05,0.371,1901],["MMUN",21.05,-86.87,0.391,331],["HUEN",0.04,32.44,0.396,1385],["HKJK",-1.33,36.92,0.403,222],["FVRG",-17.93,31.09,0.429,200],["SPQT",-3.78,-73.31,0.439,973],["MMMX",19.44,-99.07,0.446,1043],["YBCS",-16.87,145.75,0.476,245],["VECC",22.65,88.45,0.48,961],["DNMM",6.58,3.32,0.483,1268],["MUHA",22.99,-82.41,0.491,855],["VABB",19.1,72.86,0.521,358],["VTCC",18.77,98.97,0.522,641],["MKJP",17.94,-76.79,0.537,1112],["TJSJ",18.43,-66.01,0.574,377],["SBCF",-19.93,-43.94,0.586,888],["VIDP",28.57,77.12,0.619,585],["FBSK",-24.56,25.92,0.687,513],["NFFN",-17.76,177.44,0.713,495],["SBSV",-12.91,-38.33,0.729,164],["YBTL",-19.25,146.77,0.818,220],["FTTJ",12.13,15.03,0.839,939],["DFFD",12.35,-1.51,0.879,1106],["SBGR",-23.43,-46.47,0.933,829],["SBCY",-15.65,-56.1,0.974,748],["DRRN",13.48,2.17,1,849],["YPDN",-12.42,130.89,1,748],["VOBL",13.2,77.71,1,401],["FQMA",-25.92,32.57,1,302],["FAOR",-26.13,28.24,1,750],["SLVR",-17.64,-63.14,1,397],["SGAS",-25.27,-57.63,1,1041],["SBFI",-25.52,-54.58,1,1016],["YPKU",-15.78,128.71,1,305]];

const R = 6371;
const rad = Math.PI / 180;
const km = (la1, lo1, la2, lo2) => {
  const a = Math.sin(((la2 - la1) * rad) / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(((lo2 - lo1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/**
 * The gust factor at a point (0–1): the stations within 1,200 km weighted by distance (on
 * the log of their factors), faded to 1 with fewer of them near, between 25° and 35° of
 * latitude, and over the US (where the models were trained).
 */
export function gustFactorAt(lat, lon) {
  if (lat > 24 && lat < 50 && lon > -126 && lon < -66) return 1;
  const band = Math.abs(lat) <= 25 ? 1 : Math.abs(lat) >= 35 ? 0 : (35 - Math.abs(lat)) / 10;
  if (!band) return 1;
  let s = 0;
  let w = 0;
  for (const [, la, lo, f] of GUST_STATIONS) {
    if (Math.abs(la - lat) > 11) continue;
    const d = km(lat, lon, la, lo);
    if (d > 1200) continue;
    const g = 1 / (d * d + 150 * 150);
    s += g * Math.log(f);
    w += g;
  }
  if (!w) return 1;
  // How much the stations know here: full with one within ~300 km, none at 1,200 km.
  const near = Math.min(1, w * (300 * 300 + 150 * 150));
  return Math.exp((s / w) * near * band);
}
