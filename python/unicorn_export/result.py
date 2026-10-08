"""Reader for Cytiva UNICORN 6/7 result exports (the ``.zip`` produced by *Export > Result*)."""
from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
import base64
import xml.etree.ElementTree as ET

import numpy as np

from .netbin import read_primitive_array, read_string


@dataclass
class Curve:
    name: str
    unit: str
    data_type: str
    number: int
    volume: np.ndarray
    amplitude: np.ndarray
    time: Optional[np.ndarray] = None
    precision: int = 3
    derived_from: Optional[int] = None
    derived_operation: Optional[str] = None
    meta: dict = field(default_factory=dict)

    def __len__(self) -> int:
        return len(self.amplitude)

    @property
    def label(self) -> str:
        return f"{self.name} ({self.unit})" if self.unit else self.name


@dataclass
class Event:
    volume: float
    time: float
    text: str


def _float(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return s


class UnicornResult:
    """Open a UNICORN result export and expose its curves, events, peaks and method.

    >>> r = UnicornResult("run.zip")
    >>> r.curves()["UV 1_280"].amplitude
    """

    def __init__(self, path):
        self.path = Path(path)
        self._zip = zipfile.ZipFile(self.path)
        self._names = set(self._zip.namelist())
        self.manifest = self._read_manifest()

    # ------------------------------------------------------------------ basics
    def close(self):
        self._zip.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def _read_manifest(self) -> list[dict]:
        if "Manifest.xml" not in self._names:
            return [{"FileName": n, "FileType": ""} for n in sorted(self._names)]
        root = ET.fromstring(self._zip.read("Manifest.xml"))
        return [{c.tag: c.text for c in d} for d in root.findall("Details")]

    def files_of_type(self, file_type: str) -> list[str]:
        return [m["FileName"] for m in self.manifest if m.get("FileType") == file_type]

    def inner_zip(self, name: str) -> dict[str, bytes]:
        """Return the members of one of the nested zip files."""
        with zipfile.ZipFile(io.BytesIO(self._zip.read(name))) as z:
            return {n: z.read(n) for n in z.namelist()}

    def blob_xml(self, name: str) -> str:
        """Decode an XML settings blob such as ``MethodData`` or ``SystemData``."""
        raw = self.inner_zip(name).get("Xml", b"")
        return read_string(raw) if raw else ""

    def xml_blobs(self) -> dict[str, str]:
        out = {}
        for m in self.manifest:
            n = m["FileName"]
            if m.get("FileType") == "ResultAuditTrail":
                try:
                    out[n] = self.blob_xml(n)
                except Exception:  # e.g. NextFracData is a PNG
                    continue
            elif n.lower().endswith(".xml"):
                out[n] = self._zip.read(n).decode("utf-8-sig")
        return out

    # ------------------------------------------------------------ result info
    def info(self) -> dict:
        root = ET.fromstring(self._zip.read("Result.xml"))
        info = {tag: root.findtext(tag) for tag in (
            "Name", "n", "SystemName", "ResultState", "FolderPath", "BatchId",
            "Created", "CreatedBy", "LastModified")}
        if not info.get("Name"):
            info["Name"] = info.pop("n", None)
        else:
            info.pop("n", None)
        info["UNICORNVersion"] = root.get("UNICORNVersion")
        for ri in root.findall("ResultRunInformation"):
            try:
                info[ri.get("RunInformationType")] = base64.b64decode(
                    ri.findtext("RunInformation")).decode("utf-8", "replace")
            except Exception:
                pass
        col = info.get("ColumnInformation", "")
        if col.startswith("<?xml"):
            try:
                croot = ET.fromstring(col.split("?>", 1)[1])
                info["ColumnInformation"] = "; ".join(
                    f"{c.findtext('name')} ({c.findtext('volume')} {c.findtext('volumeUnit')})"
                    for c in croot.findall("column"))
            except ET.ParseError:
                pass
        return {k: v for k, v in info.items() if v is not None}

    def method_variables(self) -> list[tuple[str, str, str]]:
        """(variable, value, unit) as recorded for this run in Result.xml."""
        root = ET.fromstring(self._zip.read("Result.xml"))
        out = []
        for sc in root.iter("ResultSearchCriteria"):
            if sc.findtext("Name", sc.findtext("n")) == "VariableValue":
                out.append((sc.findtext("Keyword1") or "", sc.findtext("Keyword2") or "",
                            sc.findtext("Keyword3") or ""))
        return out

    # ----------------------------------------------------------- chromatogram
    def chromatograms(self) -> list[str]:
        return [f[:-4] for f in self.files_of_type("Chromatogram")] or ["Chrom.1"]

    def _chrom_root(self, chrom: str):
        return ET.fromstring(self._zip.read(f"{chrom}.Xml"))

    def curves(self, chrom: Optional[str] = None) -> dict[str, Curve]:
        """All curves in a chromatogram, keyed by UNICORN curve name, in file order."""
        chrom = chrom or self.chromatograms()[0]
        root = self._chrom_root(chrom)
        curves, by_number = {}, {}
        for cv in root.find("Curves"):
            name = cv.findtext("Name", cv.findtext("n"))
            fname = cv.findtext(".//BinaryCurvePointsFileName")
            members = self.inner_zip(fname)
            amp = read_primitive_array(members["CoordinateData.Amplitudes"])
            vol = (read_primitive_array(members["CoordinateData.Volumes"])
                   if "CoordinateData.Volumes" in members else None)
            origin = cv.find("DerivedCurveOrigin")
            derived = int(origin.findtext("FirstCurve/CurveNumber")) if origin is not None else None
            operation = origin.findtext("CurveOperation") if origin is not None else None
            dt, t0 = _float(cv.findtext("DistanceBetweenPoints")), _float(cv.findtext("DistanceToStartPoint"))
            time = None
            if isinstance(dt, float) and isinstance(t0, float) and dt > 0:
                time = t0 + dt * np.arange(len(amp))
            c = Curve(
                name=name,
                unit=cv.findtext("AmplitudeUnit") or "",
                data_type=cv.get("CurveDataType", ""),
                number=int(cv.findtext("CurveNumber") or 0),
                volume=vol,
                amplitude=amp,
                time=time,
                precision=int(cv.findtext("AmplitudePrecision") or 3),
                derived_from=derived,
                derived_operation=operation,
                meta={c.tag: c.text for c in cv if len(c) == 0},
            )
            curves[name] = c
            by_number[c.number] = c
        # Derived curves (e.g. baselines) share the x-axis of their source curve.
        for c in curves.values():
            if c.derived_from is None:
                continue
            src = by_number.get(c.derived_from)
            if src is not None and len(src) == len(c):
                # Derived curves store their spacing in volume units, so borrow both
                # axes from the source curve rather than trusting their own header.
                c.volume, c.time = src.volume, src.time
            elif c.volume is None:
                c.time = None
        return curves

    def events(self, chrom: Optional[str] = None) -> dict[str, list[Event]]:
        """Event curves keyed by name (typically 'Fraction', 'Run Log', 'Injection')."""
        root = self._chrom_root(chrom or self.chromatograms()[0])
        out = {}
        for ec in root.find("EventCurves"):
            name = ec.findtext("Name", ec.findtext("n")) or ec.get("EventCurveType")
            out[name] = [Event(float(e.findtext("EventVolume")), float(e.findtext("EventTime")),
                               e.findtext("EventText") or "") for e in ec.find("Events")]
        return out

    def run_log(self, chrom=None) -> list[Event]:
        ev = self.events(chrom)
        return next((v for k, v in ev.items() if "log" in k.lower()), [])

    def fractions(self, chrom=None) -> list[Event]:
        ev = self.events(chrom)
        return next((v for k, v in ev.items() if "fraction" in k.lower()), [])

    def phases(self, chrom=None) -> list[tuple[float, str]]:
        """(start volume, phase name) parsed from the run log."""
        out = []
        for e in self.run_log(chrom):
            t = e.text
            if t.startswith("Phase ") and "(Issued)" in t:
                out.append((e.volume, t[6:t.index("(Issued)")].strip()))
        return out

    def peak_tables(self, chrom=None) -> list[dict]:
        root = self._chrom_root(chrom or self.chromatograms()[0])
        tables = []
        for pt in root.iter("PeakTable"):
            t = {c.tag: _float(c.text) for c in pt if len(c) == 0}
            t["Peaks"] = [{c.tag: _float(c.text) for c in p if len(c) == 0} for p in pt.iter("Peak")]
            tables.append(t)
        return tables

    # ------------------------------------------------------------------ method
    def method_xml(self) -> str:
        txt = self.blob_xml("MethodData")
        return txt[txt.index("<Method"):] if "<Method" in txt else txt
