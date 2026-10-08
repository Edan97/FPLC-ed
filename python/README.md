# unicorn-export

Read Cytiva **UNICORN 6/7 result exports** (the `.zip` from *Export > Result*) in Python,
without needing UNICORN. Gets out:

- every data curve (UV, conductivity, %B, pH, pressures, flows, temperature, ...) at native resolution
- a combined CSV with one volume column and all detectors, in order of relevance
- a clean chromatogram plot with phases and fractions marked
- the full method as a readable outline, plus the variable values used for the run
- run log, fraction table, UNICORN peak tables, and all embedded XML

Tested on UNICORN 7.12 exports from an ÄKTA pure 25.

## Install

```bash
pip install .            # or: pip install -e ".[test]"
```

Requires Python 3.9+, numpy, pandas, matplotlib.

## Command line

```bash
unicorn-export info      run.zip                 # run summary, curves, phases
unicorn-export csv       run.zip -o run.csv      # all curves on one volume axis
unicorn-export plot      run.zip -o a280.png     # A280 chromatogram
unicorn-export plot      run.zip --curve "UV 3_214" --no-fractions
unicorn-export method    run.zip -o method.txt   # method outline + run variables
unicorn-export log       run.zip                 # run log
unicorn-export fractions run.zip -o fractions.csv
unicorn-export peaks     run.zip                 # peak table(s), if the result was evaluated
unicorn-export dump-xml  run.zip -o run_xml/     # every embedded XML document
```

`python -m unicorn_export ...` works too.

## Python

```python
from unicorn_export import UnicornResult, to_dataframe

r = UnicornResult("run.zip")
uv = r.curves()["UV 1_280"]          # .volume, .amplitude, .time, .unit
df = to_dataframe(r)                 # pandas DataFrame, one volume column
r.phases()                           # [(start_ml, "Column Wash"), ...]
r.fractions()                        # Event(volume, time, text)
r.peak_tables()
print(r.method_xml()[:200])
```

## How the combined CSV is built

- The x-axis is taken from A280 (UV 1, the most finely sampled detector). Curves that
  share that axis are copied exactly.
- Smooth signals (conductivity, pH, A214, pressures, temperature) are linearly interpolated.
- Set-point signals (Conc B, flows, UV path length) use the last recorded value, so steps stay sharp.
- Cells outside a detector's recorded range are left blank.
- Columns: A280, Cond, Conc B, A214, pH, pressures, flows, then everything else. Change
  `DEFAULT_ORDER` / `STEP_CURVES` in `unicorn_export/export.py` to adjust.
- Written as UTF-8 with BOM so Excel shows `°C` correctly.

## Notes and caveats

- The format is undocumented; see [docs/FILE_FORMAT.md](docs/FILE_FORMAT.md) for what is known.
- UV values are as stored by UNICORN (normalised to nominal path length when the system says so).
  Flat-topped peaks usually mean detector saturation; the data can't recover that.
- Time is reconstructed from each curve's stored sampling interval and excludes pauses.

## Tests

```bash
pytest                                   # format tests always run
UNICORN_SAMPLE_ZIP=run.zip pytest        # plus integration tests on a real export
```

Instrument data is git-ignored by default (`tests/data/*.zip`).
