// Stormycast's shading: each hazard's levels (percent) and colours, as the website draws
// them and the GeoJSON outlooks (scripts/stormycast-geojson.mjs) carry them. One place for
// both: stormycast-site/app.mjs imports this (its build copies it), the runner too.
// Tornado's ladder follows SPC's tornado probabilities; the rest SPC's hail and wind.

export const FAINT = '#6f7479'; // 1%: possible, but low
const TOR_UP = [[2, '#008b00'], [5, '#8b4726'], [10, '#ffc800'], [15, '#ff0000'], [30, '#ff00ff'], [45, '#912cee'], [60, '#104e8b']];
export const TOR = [[1, FAINT], ...TOR_UP];
export const SEVERE = [[1, FAINT], [5, '#8b4726'], [15, '#ffc800'], [30, '#ff0000'], [45, '#ff00ff'], [60, '#912cee']];
export const SIG = [[1, '#5fb85f'], ...TOR_UP];
// Wind's faint level from 2%: at 1% it covers much of the tropics, where storms are near daily.
export const WIND = [[2, FAINT], ...SEVERE.slice(1)];
export const THUNDER = [[10, '#c1e9c1'], [40, '#66c57d'], [70, '#2e8b57']];

/** Each hazard in the day files: its levels and what it is a chance of. */
export const HAZARD_LEVELS = {
  tor: { levels: TOR, name: 'Tornado' },
  sigtor: { levels: SIG, name: 'EF2+ tornado' },
  hail: { levels: SEVERE, name: 'Hail 1 in+' },
  sighail: { levels: SIG, name: 'Hail 2 in+' },
  wind: { levels: WIND, name: 'Wind 50 kt+' },
  sigwind: { levels: SIG, name: 'Wind 65 kt+' },
  thunder: { levels: THUNDER, name: 'Thunder' },
};
