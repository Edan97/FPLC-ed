"""Command-line interface: ``unicorn-export <command> RESULT.zip``."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .result import UnicornResult


def _out(args, suffix):
    return Path(args.output) if args.output else Path(args.zip).with_suffix("").with_name(
        Path(args.zip).stem + suffix)


def cmd_info(args):
    r = UnicornResult(args.zip)
    for k, v in r.info().items():
        print(f"{k:32s} {v}")
    print(f"\nChromatograms: {', '.join(r.chromatograms())}\n")
    print(f"{'Curve':32s} {'Unit':8s} {'Points':>7s}  Volume range (ml)      Min / Max")
    for c in r.curves().values():
        vr = f"{c.volume[0]:7.2f} - {c.volume[-1]:7.2f}" if c.volume is not None else "n/a"
        print(f"{c.name:32s} {c.unit:8s} {len(c):7d}  {vr:22s} {c.amplitude.min():.3f} / {c.amplitude.max():.3f}")
    print("\nPhases:")
    for x, name in r.phases():
        print(f"  {x:8.2f} ml  {name}")


def cmd_csv(args):
    from .export import write_csv
    out = _out(args, "_all_curves.csv")
    df = write_csv(UnicornResult(args.zip), out, axis_curve=args.axis, include_time=args.time)
    print(f"Wrote {out} ({df.shape[0]} rows x {df.shape[1]} columns)")


def cmd_plot(args):
    import matplotlib
    matplotlib.use("Agg")
    from .plotting import plot_chromatogram
    out = _out(args, f"_{args.curve.replace(' ', '_')}.png")
    plot_chromatogram(UnicornResult(args.zip), curve=args.curve, path=out, title=args.title,
                      show_fractions=not args.no_fractions, show_phases=not args.no_phases)
    print(f"Wrote {out}")


def cmd_method(args):
    from .method import method_outline
    r = UnicornResult(args.zip)
    text = method_outline(r.method_xml())
    text += "\n\nRun variables:\n" + "\n".join(
        f"  {k:50s} {v} {u}".rstrip() for k, v, u in r.method_variables())
    _emit(args, text)


def cmd_log(args):
    lines = [f"{e.volume:9.3f} ml  {e.time:8.3f} min  {e.text}" for e in UnicornResult(args.zip).run_log()]
    _emit(args, "\n".join(lines))


def cmd_fractions(args):
    fr = UnicornResult(args.zip).fractions()
    lines = ["fraction,start_ml,end_ml,start_min"]
    for a, b in zip(fr, fr[1:] + [None]):
        lines.append(f"{a.text},{a.volume:.3f},{'' if b is None else f'{b.volume:.3f}'},{a.time:.3f}")
    _emit(args, "\n".join(lines))


def cmd_peaks(args):
    tables = UnicornResult(args.zip).peak_tables()
    if not tables:
        print("No peak tables (result not evaluated).")
        return
    if args.json:
        _emit(args, json.dumps(tables, indent=2))
        return
    keys = ["StartPeakRetention", "MaxPeakRetention", "EndPeakRetention", "Height", "Area",
            "PercentOfTotalArea", "WidthAtHalfHeight", "StartPeakVial", "EndPeakVial"]
    out = []
    for t in tables:
        out.append(f"# {t.get('Name')}")
        out.append(",".join(keys))
        for p in t["Peaks"]:
            out.append(",".join(str(p.get(k, "")) for k in keys))
    _emit(args, "\n".join(out))


def cmd_dump(args):
    r = UnicornResult(args.zip)
    outdir = Path(args.output or Path(args.zip).stem + "_xml")
    outdir.mkdir(parents=True, exist_ok=True)
    for name, text in r.xml_blobs().items():
        p = outdir / (name if name.lower().endswith(".xml") else name + ".xml")
        p.write_text(text, encoding="utf-8")
    print(f"Wrote decoded XML to {outdir}/")


def _emit(args, text):
    if getattr(args, "output", None):
        Path(args.output).write_text(text, encoding="utf-8")
        print(f"Wrote {args.output}")
    else:
        sys.stdout.write(text + "\n")


def main(argv=None):
    p = argparse.ArgumentParser(prog="unicorn-export",
                                description="Extract data from Cytiva UNICORN 6/7 result exports (.zip)")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_):
        s = sub.add_parser(name, help=help_)
        s.add_argument("zip", help="UNICORN result export (.zip)")
        s.add_argument("-o", "--output", help="output path")
        s.set_defaults(fn=fn)
        return s

    add("info", cmd_info, "summary of run, curves and phases")
    s = add("csv", cmd_csv, "all curves on one volume axis as CSV")
    s.add_argument("--axis", default="UV 1_280", help="curve whose volume axis is used")
    s.add_argument("--time", action="store_true", help="also include a time column")
    s = add("plot", cmd_plot, "plot a chromatogram (default A280)")
    s.add_argument("--curve", default="UV 1_280")
    s.add_argument("--title")
    s.add_argument("--no-fractions", action="store_true")
    s.add_argument("--no-phases", action="store_true")
    add("method", cmd_method, "readable method outline + run variables")
    add("log", cmd_log, "run log")
    add("fractions", cmd_fractions, "fraction table as CSV")
    s = add("peaks", cmd_peaks, "peak table(s) from UNICORN evaluation")
    s.add_argument("--json", action="store_true")
    add("dump-xml", cmd_dump, "write every embedded XML document to a folder")

    args = p.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
