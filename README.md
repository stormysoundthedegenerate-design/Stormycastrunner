# Stormycast runner

**Stormycast by stormy_sound, Nexradar** is a global severe-weather outlook. For each place and day, it gives the chance of a tornado, hail or damaging wind report within 25 miles (40 km), plus the chance of thunder.

How it's built:
- Gradient-boosted trees learn from the storm environments of US severe days.
- A thunder stage first asks whether there will be thunderstorms at all. It's trained on GOES lightning.
- The trees then run on ECMWF's open forecasts and NOAA's GEFS ensemble worldwide (mixed by how well each has done, hazard by hazard and day by day), and on HRRR over the US for day 1.
- Outside the US, tropical wind chances are scaled by airport gust records.
- Each run is scored once the days are over, against SPC's storm reports and beside SPC's own outlook (`scores.json` on the published site).

This repository runs Stormycast twice a day on GitHub Actions (`.github/workflows/stormycast.yml`). It publishes each run to <https://stormycast.nexradar.pages.dev>, which the Nexradar app (<https://nexradar.pages.dev>) reads.

The files are packed from the Nexradar project by `scripts/stormycast-runner-pack.mjs`, which lists them in `FILES.txt`. Training happens there, not here.

## Using Stormycast

- **Forecasts and model** (`public/js/core/stormycast-model.mjs`, `stormycast-hrrr-model.mjs`, and the published days): CC BY 4.0. See `MODEL_LICENSE`. Credit **"Stormycast by stormy_sound, Nexradar"** with a link to <https://nexradar.pages.dev>.
- **Code:** MIT. See `LICENSE`.

## Data credits

- **ECMWF open data:** IFS forecasts, © ECMWF, CC BY 4.0.
- **ERA5:** contains modified Copernicus Climate Change Service information (training and surface fields).
- **NOAA:** GEFS and HRRR forecasts, the GEFSv12 reforecast (training) and GOES-East GLM lightning (public domain).
- **NOAA Storm Prediction Center:** storm reports, used for training (public domain).
