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
  Sample pump loading (e.g. desalting) shows the sample inlet split into prime to waste and injected
  volume, the air-sensor stop, and pump washes; peak fractionation shows its detection settings,
  collected peaks and where fractionation stopped.
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
| `tests/` | Tests for the lab-book summary on a Protein A purification and two desalting runs, plus edge cases |
| `python/` | The original Python reader/CLI (`unicorn-export`) and [notes on the file format](python/docs/FILE_FORMAT.md) |

## Running locally

ES modules don't load from `file://`, so serve the folder:

```bash
python3 -m http.server
# open http://localhost:8000
```

## Tests

The tests need [Node.js](https://nodejs.org/) 22 or later (`brew install node`) and nothing else:

```bash
npm test
```

They check the method & run log summary on anonymised copies of real runs in `tests/fixtures/`:
a Protein A purification and two desalting runs (sample pump loading, peak fractionation), plus
hand-written run logs for edge cases. `tests/snapshots/` holds the full expected text for each run.

- **Before every push:** run `git config core.hooksPath .githooks` once per clone. The pre-push hook
  then runs the tests and stops the push if any fail.
- **On GitHub:** the *Tests* workflow runs them on every push and pull request.
- **After an intended change to the output:** `npm run test:update` rewrites the snapshots; read the
  diff before committing.
- **Adding a run:** `npm install` once, then
  `npm run fixture -- "Result.zip" tests/fixtures/name.json --redact "Your Name" --redact "sample ID"`.
  It keeps only what the summary reads, blanks result folders, computer, sample marks and batch IDs,
  and refuses to write if a `--redact` string is still there. The repo is public, so look over the
  fixture before committing it.

## Caveats

Tested on UNICORN 7.12 exports from an ÄKTA pure. The export format is undocumented; check
anything critical against UNICORN.
