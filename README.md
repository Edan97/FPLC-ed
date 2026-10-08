# FPLC-ed

Publicly available FPLC data processor. Drop in a Cytiva UNICORN result export (`.zip`) and get a
chromatogram PNG and tidy CSVs. Everything runs in your browser and files are never uploaded.

**Use it:** https://edan97.github.io/FPLC-ed/

## What you get

- **Chromatogram (PNG):** the curves you tick, as a UNICORN-style overlay (default) or stacked panels, with
  method phases and fractions marked. Choose the volume range (or jump to a phase), title and size.
- **Selected curves (CSV):** one `Volume (ml)` column plus a column per ticked curve.
- **All curves (CSV):** the same layout with every curve in the export.
- **Method & run log (TXT):** a lab-book summary. First, every inlet used (A1, B1, A2, sample, ...)
  with a line to write in the buffer (or type it on the page first), then a fraction table (phase,
  volume range, inlets being pumped, max A280), then each phase with what it
  drew from each inlet (e.g. *Column Wash: A1 50.41 ml*), flow, %B, fractions and system washes.
  Followed by method variables, the full method outline and the instrument run log.

Both CSVs use a fixed volume step (default 0.01 ml) like the UNICORN evaluation table. Each row holds
the recorded value nearest that volume, so nothing is interpolated. Cells outside a detector's
recorded range are blank. Optional extra columns: time (min) and column volumes (CV).

## Getting the export out of UNICORN

In UNICORN Evaluation, open the result, then **File › Export › Result** and save the `.zip`.
A zip that contains one or more result zips (e.g. a folder you zipped up) also works; you pick the run.

## Repository layout

| Path | What |
|---|---|
| `index.html`, `css/`, `js/` | The web page (plain JavaScript, no build step) |
| `js/unicorn.js` | Reads the export: curves, events, run info, method |
| `js/table.js` | Fixed-step tables and CSV writing |
| `js/plot.js` | Chromatogram rendering (shared by the preview and the PNG) |
| `js/summary.js` | Inlets used and per-phase volumes, from the run log |
| `vendor/jszip.min.js` | [JSZip](https://stuk.github.io/jszip/) 3.10.1 for reading zips in the browser |
| `python/` | The original Python reader/CLI (`unicorn-export`) and [notes on the file format](python/docs/FILE_FORMAT.md) |

## Running locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server
# open http://localhost:8000
```

## Caveats

Tested on UNICORN 7.12 exports from an ÄKTA pure. The export format is undocumented; check
anything critical against UNICORN.
