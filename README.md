# Stormycast runner

**Stormycast by stormy_sound, Nexradar** is a global severe-weather outlook. For each place and day, it gives the chance of a tornado, hail or damaging wind report within 25 miles (40 km), plus the chance of thunder.

How it's built:
- Gradient-boosted trees learn from the storm environments of US severe days.
- A thunder stage first asks whether there will be thunderstorms at all, in the style of ASTORP. It's trained on GOES lightning.
- The trees then run on ECMWF's open forecasts worldwide and HRRR's over the US.

This repository runs Stormycast twice a day on GitHub Actions (`.github/workflows/stormycast.yml`). It publishes each run to <https://stormycast.nexradar.pages.dev>, which the Nexradar app (<https://nexradar.pages.dev>) reads.

The files are packed from the Nexradar project by `scripts/stormycast-runner-pack.mjs`, which lists them in `FILES.txt`. Training happens there, not here.

## Using Stormycast

- **Forecasts and model** (`public/js/core/stormycast-model.mjs`, `stormycast-hrrr-model.mjs`, and the published days): CC BY 4.0. See `MODEL_LICENSE`. Credit **"Stormycast by stormy_sound, Nexradar"** with a link to <https://nexradar.pages.dev>.
- **Code:** MIT. See `LICENSE`.

## Data credits

- **ECMWF open data:** IFS forecasts, © ECMWF, CC BY 4.0.
- **ERA5:** contains modified Copernicus Climate Change Service information (training and surface fields).
- **NOAA:** HRRR forecasts and GOES-East GLM lightning (public domain).
- **NOAA Storm Prediction Center:** storm reports, used for training (public domain).
