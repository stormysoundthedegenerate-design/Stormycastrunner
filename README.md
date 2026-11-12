# Stormycast runner

**Stormycast by stormy_sound, Nexradar** is a global severe-weather outlook. For each place and day, it gives the chance of a tornado, hail or damaging wind report within 25 miles (40 km), the chance of a significant one (EF2+ tornado, 2 in+ hail, 65 kt+ wind), and the chance of thunder. Each day is the place's own: 6 am to 6 am local (solar) time.

Forecasts: <https://stormycast.pages.dev> · Data: <https://stormycast.nexradar.pages.dev> · Also in the Nexradar app: <https://nexradar.pages.dev>

## How it works

- **Learning:** gradient-boosted trees learn from the storm environments of US severe days (ERA5 and the GEFSv12 reforecast, labelled with SPC storm reports). Inputs include CAPE, shear, helicity, moisture, hail-growth-zone CAPE and the wet-bulb zero height, at four times through each day.
- **Thunder first:** a thunder stage, trained on GOES lightning, asks whether there will be storms at all. No severe chance is higher than the thunder chance.
- **Forecasts:** the trees run on ECMWF's open forecasts and on five members of NOAA's GEFS ensemble worldwide. The two are mixed by how well each has done, hazard by hazard and day by day.
- **Day 1:** over the US, HRRR adds storm-scale detail. A consensus model also reads every source's chance for day 1: US hail and wind, and significant hail and wind worldwide.
- **Clean-up:**
  - Chances are smoothed, calibrated for how far ahead the day is, and held under limits set by the day's ingredients.
  - Severe chances are given over land only.
  - Outside the US, wind chances are scaled by how often thunderstorms there bring measured damaging gusts (airport records).
- **Scoring:** each run is scored once its days are over, against SPC's storm reports and beside SPC's own day 1 outlook (`scores.json` on the data site; charts at <https://stormycast.pages.dev/verify>).

The model learnt from US storms. Elsewhere its chances have not been checked against local reports in the same way, so treat them as a rough guide.

## What this repository does

`.github/workflows/stormycast.yml` runs four times a day on GitHub Actions:

| ECMWF run | Data out (UTC) | What it updates |
|---|---|---|
| 00Z | about 07:35 | all five days |
| 06Z | about 12:30 | day 1 only: today across the Americas, Europe and Africa, tomorrow from about 20°E on |
| 12Z | about 19:35 | all five days (from tomorrow) |
| 18Z | about 00:30 | day 1 only: tomorrow everywhere |

A day 1 update redoes, for each place, the next afternoon at least 9 hours after the run starts, so that afternoon hasn't passed by the time the update is published. It leaves the rest of that day, and the later days, as the last full run published them.

Each run is split across several machines:
- One job waits for ECMWF's data and names the run (it stops if that run is already published).
- Five jobs each work out one GEFS member.
- The main job does ECMWF and HRRR, mixes in the members, scores, and publishes to the `stormycast` branch of a Cloudflare Pages project.
- A separate job saves NOAA's new RRFS model and REFS ensemble at the US scoring points to the `rrfs-data` branch, for training later. NOAA keeps only two days of them. This job can never hold up or break the forecast.

The files here are packed from the Nexradar project by `scripts/stormycast-runner-pack.mjs` and listed in `FILES.txt`. Training happens there, not here.

**Secrets:**
- `STORMYCAST_TOKEN`: a Cloudflare API token with Pages: Edit.
- `CLOUDFLARE_ACCOUNT_ID`.

## Using Stormycast

- **Forecasts and models:** CC BY 4.0. See `MODEL_LICENSE`. Credit **"Stormycast by stormy_sound, Nexradar"** with a link to <https://nexradar.pages.dev>. The models are `public/js/core/stormycast-model.mjs`, `stormycast-gefs-model.mjs`, `stormycast-hrrr-model.mjs`, `stormycast-consensus.mjs` and `stormycast-gust.mjs`, and the forecasts are the published days.
- **Code:** MIT. See `LICENSE`. Third-party code keeps its own licence (`THIRD_PARTY.md`).

Stormycast is experimental and automated. It is not an official forecast or warning. For your safety, follow your national weather service.

## Data credits

- **ECMWF open data:** IFS forecasts, © ECMWF, CC BY 4.0.
- **ERA5:** contains modified Copernicus Climate Change Service information (training and surface fields).
- **NOAA:** public domain.
  - GEFS, HRRR, RRFS and REFS forecasts.
  - The GEFSv12 reforecast (training).
  - GOES-East GLM lightning.
- **NOAA Storm Prediction Center:** storm reports and outlooks, used for training and scoring (public domain).
- **Iowa Environmental Mesonet:** airport (METAR) gust records behind the wind scaling.
