// Reader for Cytiva UNICORN 6/7 result exports (the .zip from Export > Result).
// Port of python/unicorn_export; see python/docs/FILE_FORMAT.md for the format notes.
/* global JSZip */

const HEADER_LEN = 17;
const REC_OBJECT_STRING = 0x06;
const REC_ARRAY_SINGLE_PRIMITIVE = 0x0f;

// MS-NRBF PrimitiveTypeEnumeration -> [bytes, DataView getter]
const PRIMITIVES = {
  6: [8, "getFloat64"],
  8: [4, "getInt32"],
  11: [4, "getFloat32"],
};

function checkHeader(buf) {
  if (buf.length < HEADER_LEN + 1 || buf[0] !== 0x00) {
    throw new Error("Not a BinaryFormatter stream (missing serialization header)");
  }
}

/** Decode an ArraySinglePrimitive record (e.g. System.Single[]) into a Float64Array. */
export function readPrimitiveArray(buf) {
  checkHeader(buf);
  if (buf[HEADER_LEN] !== REC_ARRAY_SINGLE_PRIMITIVE) {
    throw new Error(`Expected ArraySinglePrimitive record, got 0x${buf[HEADER_LEN].toString(16)}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const length = dv.getInt32(HEADER_LEN + 5, true);
  const ptype = buf[HEADER_LEN + 9];
  if (!(ptype in PRIMITIVES)) throw new Error(`Unsupported primitive type ${ptype}`);
  const [size, getter] = PRIMITIVES[ptype];
  const start = HEADER_LEN + 10;
  if (start + length * size > buf.length) throw new Error("Array length exceeds buffer size");
  const out = new Float64Array(length);
  for (let i = 0; i < length; i++) out[i] = dv[getter](start + i * size, true);
  return out;
}

/** Decode a BinaryObjectString record (7-bit length-prefixed UTF-8). */
export function readString(buf) {
  checkHeader(buf);
  if (buf[HEADER_LEN] !== REC_OBJECT_STRING) {
    throw new Error(`Expected BinaryObjectString record, got 0x${buf[HEADER_LEN].toString(16)}`);
  }
  let pos = HEADER_LEN + 5; // skip record type + int32 object id
  let length = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos++];
    length |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return new TextDecoder("utf-8").decode(buf.subarray(pos, pos + length));
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ""), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Could not parse XML");
  return doc.documentElement;
}

// Direct-child helpers; UNICORN nests same-named tags, so avoid deep lookups unless intended.
const child = (el, tag) => (el ? Array.from(el.children).find((c) => c.tagName === tag) : undefined);
const children = (el, tag) => (el ? Array.from(el.children).filter((c) => !tag || c.tagName === tag) : []);
const text = (el, tag) => child(el, tag)?.textContent ?? null;
const deepText = (el, tag) => el?.getElementsByTagName(tag)[0]?.textContent ?? null;

function b64utf8(s) {
  const bin = atob(s.replace(/\s+/g, ""));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Find UNICORN result exports in a dropped zip: the zip itself, or zips nested inside it. */
export async function findResults(bytes, name) {
  const zip = await JSZip.loadAsync(bytes);
  if (zip.file("Result.xml") && zip.file(/^Chrom\.\d+\.Xml$/).length) {
    return [{ name: name.replace(/\.zip$/i, ""), zip }];
  }
  const found = [];
  for (const entry of zip.file(/\.zip$/i)) {
    if (entry.name.startsWith("__MACOSX/")) continue;
    try {
      const inner = await JSZip.loadAsync(await entry.async("uint8array"));
      if (inner.file("Result.xml")) {
        const base = entry.name.split("/").pop().replace(/\.zip$/i, "");
        found.push({ name: base, zip: inner });
      }
    } catch {
      // not a zip we can read; ignore
    }
  }
  return found;
}

export class UnicornResult {
  constructor(zip, name) {
    this.zip = zip;
    this.name = name;
  }

  static async open(zip, name) {
    const r = new UnicornResult(zip, name);
    await r.load();
    return r;
  }

  async innerZip(name) {
    const f = this.zip.file(name);
    if (!f) throw new Error(`Missing ${name} in export`);
    const z = await JSZip.loadAsync(await f.async("uint8array"));
    const out = {};
    for (const n of Object.keys(z.files)) out[n] = await z.files[n].async("uint8array");
    return out;
  }

  async blobXml(name) {
    if (!this.zip.file(name)) return "";
    const raw = (await this.innerZip(name)).Xml;
    return raw ? readString(raw) : "";
  }

  async load() {
    const resultRoot = parseXml(await this.zip.file("Result.xml").async("string"));
    this.info = this._info(resultRoot);
    this.variables = this._variables(resultRoot);

    const chromFile = this.zip.file(/^Chrom\.\d+\.Xml$/).map((f) => f.name).sort()[0];
    const chromRoot = parseXml(await this.zip.file(chromFile).async("string"));
    // ISO timestamp, unambiguous unlike RunStartDate's locale-dependent format.
    const start = deepText(chromRoot, "MethodStartTime");
    if (start) this.info.MethodStartTime = start;
    this.curves = await this._curves(chromRoot);
    this.events = this._events(chromRoot);
    this.runLog = Object.entries(this.events).find(([k]) => k.toLowerCase().includes("log"))?.[1] ?? [];
    this.fractions = Object.entries(this.events).find(([k]) => k.toLowerCase().includes("fraction"))?.[1] ?? [];
    this.phases = this.runLog
      .filter((e) => e.text.startsWith("Phase ") && e.text.includes("(Issued)"))
      .map((e) => ({ volume: e.volume, time: e.time, name: e.text.slice(6, e.text.indexOf("(Issued)")).trim() }));

    try {
      const m = await this.blobXml("MethodData");
      this.methodXml = m.includes("<Method") ? m.slice(m.indexOf("<Method")) : m;
    } catch {
      this.methodXml = "";
    }
  }

  _info(root) {
    const info = {};
    for (const tag of ["Name", "SystemName", "ResultState", "FolderPath", "BatchId"]) {
      const v = text(root, tag);
      if (v) info[tag] = v;
    }
    info.UNICORNVersion = root.getAttribute("UNICORNVersion");
    for (const ri of children(root, "ResultRunInformation")) {
      try {
        info[ri.getAttribute("RunInformationType")] = b64utf8(text(ri, "RunInformation") || "");
      } catch {
        // leave undecodable fields out
      }
    }
    const col = info.ColumnInformation || "";
    if (col.startsWith("<?xml")) {
      try {
        const croot = parseXml(col.split("?>").slice(1).join("?>"));
        info.ColumnInformation = children(croot, "column")
          .map((c) => `${text(c, "name").replace(/\s+/g, " ")} (${text(c, "volume")} ${text(c, "volumeUnit")})`)
          .join("; ");
        const cv = parseFloat(text(children(croot, "column")[0], "volume"));
        if (cv > 0) info.ColumnVolume = cv;
      } catch {
        // keep raw value
      }
    }
    return info;
  }

  _variables(root) {
    return Array.from(root.getElementsByTagName("ResultSearchCriteria"))
      .filter((sc) => (text(sc, "Name") ?? text(sc, "n")) === "VariableValue")
      .map((sc) => ({
        name: text(sc, "Keyword1") || "",
        value: text(sc, "Keyword2") || "",
        unit: (text(sc, "Keyword3") || text(sc, "ExtraDisplayInformation") || "").replace("{base}", ""),
      }));
  }

  async _curves(root) {
    const curves = [];
    for (const cv of children(child(root, "Curves"), "Curve")) {
      const fname = deepText(cv, "BinaryCurvePointsFileName");
      if (!fname || !this.zip.file(fname)) continue;
      const members = await this.innerZip(fname);
      const amplitude = readPrimitiveArray(members["CoordinateData.Amplitudes"]);
      const volume = members["CoordinateData.Volumes"]
        ? readPrimitiveArray(members["CoordinateData.Volumes"])
        : null;
      const origin = child(cv, "DerivedCurveOrigin");
      const dt = parseFloat(text(cv, "DistanceBetweenPoints"));
      const t0 = parseFloat(text(cv, "DistanceToStartPoint"));
      curves.push({
        name: text(cv, "Name") ?? text(cv, "n"),
        unit: text(cv, "AmplitudeUnit") || "",
        dataType: cv.getAttribute("CurveDataType") || "",
        number: parseInt(text(cv, "CurveNumber") || "0", 10),
        precision: parseInt(text(cv, "AmplitudePrecision") || "3", 10),
        derivedFrom: origin ? parseInt(deepText(origin, "CurveNumber"), 10) : null,
        derivedOperation: origin ? text(origin, "CurveOperation") : null,
        timeStep: dt > 0 && !origin ? dt : null,
        timeStart: dt > 0 && !origin ? t0 : null,
        volume,
        amplitude,
      });
    }
    // Derived curves (e.g. baselines) share the x-axis of their source curve.
    const byNumber = new Map(curves.map((c) => [c.number, c]));
    for (const c of curves) {
      if (c.derivedFrom == null) continue;
      const src = byNumber.get(c.derivedFrom);
      if (src && src.amplitude.length === c.amplitude.length) {
        c.volume = src.volume;
        c.timeStep = src.timeStep;
        c.timeStart = src.timeStart;
      }
    }
    return curves.filter((c) => c.volume && c.volume.length === c.amplitude.length);
  }

  _events(root) {
    const out = {};
    for (const ec of children(child(root, "EventCurves"), "EventCurve")) {
      const name = text(ec, "Name") ?? text(ec, "n") ?? ec.getAttribute("EventCurveType");
      out[name] = children(child(ec, "Events"), "Event").map((e) => ({
        volume: parseFloat(text(e, "EventVolume")),
        time: parseFloat(text(e, "EventTime")),
        text: text(e, "EventText") || "",
      }));
    }
    return out;
  }
}

// ------------------------------------------------------------------ method outline

function params(instr) {
  const out = [];
  for (const p of instr.getElementsByTagName("*")) {
    if (p.tagName !== "GenericCommandParameter" && p.tagName !== "StrategyParameter") continue;
    const v = text(p, "ParameterReadableValue") || text(p, "ParameterValue");
    if (!v || v === "None") continue;
    out.push(`${v} ${text(p, "ParameterUnit") || ""}`.trim());
  }
  return out;
}

/** Nested text outline of the method, starting from the main block and expanding called blocks. */
export function methodOutline(methodXml) {
  if (!methodXml) return "";
  const root = parseXml(methodXml);
  const blocks = {};
  for (const b of children(child(root, "Blocks"), "Block")) {
    blocks[text(b, "BlockName")] = {
      main: text(b, "IsMainBlock") === "true",
      instructions: children(child(b, "BlockInstructions")).map((bi) => ({
        breakpoint: parseFloat(text(bi, "BreakPointValue") || "0"),
        name: text(bi, "ReadableName"),
        params: params(bi),
        calls: deepText(bi, "CalledBlockName"),
      })),
    };
  }
  const main = Object.keys(blocks).find((n) => blocks[n].main);
  const lines = [
    `Method: ${text(root, "Description") ?? ""}`,
    `System: ${text(root, "SystemName") ?? ""}   Technique: ${text(root, "TechniqueName") ?? ""}`,
    `Created: ${text(root, "Created") ?? ""}   Last modified: ${text(root, "LastModified") ?? ""}`,
    "",
  ];
  const walk = (name, depth, seen) => {
    const pad = "  ".repeat(depth);
    for (const ins of blocks[name].instructions) {
      const bp = ins.breakpoint.toFixed(2).padStart(6);
      if (ins.name === "Block" && blocks[ins.calls] && !seen.has(ins.calls)) {
        lines.push(`${pad}${bp}  Block: ${ins.calls}`);
        walk(ins.calls, depth + 1, new Set([...seen, ins.calls]));
      } else if (ins.name === "Watch" && blocks[ins.calls]) {
        lines.push(`${pad}${bp}  Watch: ${ins.params.join(", ")}`);
      } else {
        lines.push(`${pad}${bp}  ${ins.name}${ins.params.length ? ": " + ins.params.join(", ") : ""}`);
      }
    }
  };
  if (main) walk(main, 0, new Set([main]));
  return lines.join("\n");
}
