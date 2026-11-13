# Stormycast archive

Every Stormycast run, kept for the record (not shown on the website). One folder a run:
`runs/YYYY/MM/YYYYMMDDHH/`, holding

- `run.json`: the run (UTC), whether it is a day 1 update (and the run it updated), the
  hazards in each file, the grid, and one entry a day file;
- `<date>-<run>.bin.gz`: a day's chances (the place's own 6 am–6 am day), gzipped bytes of
  percent, one 720 × 361 grid a hazard in the order `hazards` gives: rows from 90°N, columns
  from 180°W, 0.5°.

A day 1 update's file is that day whole: the updated places merged into the run it updated.

`runs/index.json` lists every run here (its folder and the dates it has), for the archive
viewer on https://stormycast.pages.dev.

Forecasts © Stormycast by stormy_sound, Nexradar, CC BY 4.0 (see MODEL_LICENSE on main).
