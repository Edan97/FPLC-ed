/* global JSZip */
import { findResults, UnicornResult, methodOutline } from "./unicorn.js";
import { orderCurves, shortName, buildTable, toCsv } from "./table.js";
import { drawChromatogram, curveColor, nearestIndex } from "./plot.js";
import { phaseSummary, phaseHeader, phaseLines, summaryText, inletLine, fractionRows } from "./summary.js";

const DEFAULT_CURVES = ["UV 1_280", "Cond", "Conc B"];
const CSV_STEP = 0.01; // ml per CSV row
const $ = (id) => document.getElementById(id);

let found = []; // [{name, zip}] runs inside the dropped file
let run = null; // current UnicornResult
let curves = []; // run curves in display order
let selected = new Set();
let geom = null; // geometry of the last preview render, for hover
let summary = null; // inlets and per-phase usage
let buffers = {}; // inlet -> buffer name typed by the user

// ------------------------------------------------------------------ loading

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", isError);
}

async function handleFile(file) {
  if (!file) return;
  setStatus(`Reading ${file.name}…`);
  $("pick").hidden = true;
  try {
    found = await findResults(await file.arrayBuffer(), file.name);
    if (!found.length) {
      throw new Error("No UNICORN result found. Export it from UNICORN with File › Export › Result.");
    }
    if (found.length > 1) {
      const sel = $("run-select");
      sel.replaceChildren(...found.map((f, i) => new Option(f.name, i)));
      $("pick").hidden = false;
    }
    await openRun(0);
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err), true);
  }
}

async function openRun(i) {
  setStatus(`Decoding ${found[i].name}…`);
  run = await UnicornResult.open(found[i].zip, found[i].name);
  curves = orderCurves(run.curves);
  const names = new Set(curves.map((c) => c.name));
  selected = new Set(DEFAULT_CURVES.filter((n) => names.has(n)));
  if (!selected.size && curves.length) selected.add(curves[0].name);

  buildCurveList();
  buildRangePresets();
  $("title").value = run.info.Name || run.name;
  fillRunInfo();
  fillMethod();
  $("drop").classList.add("compact");
  $("workspace").hidden = false;
  setStatus(`Loaded ${run.info.Name || run.name}: ${curves.length} curves, ${run.fractions.length} fraction events.`);
  render();
}

// ------------------------------------------------------------------ option panels

function buildCurveList() {
  const list = $("curve-list");
  list.replaceChildren(
    ...curves.map((c) => {
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.value = c.name;
      box.checked = selected.has(c.name);
      box.addEventListener("change", () => {
        box.checked ? selected.add(c.name) : selected.delete(c.name);
        render();
      });
      const sw = document.createElement("span");
      sw.className = "swatch";
      sw.style.background = curveColor(c);
      const name = document.createElement("span");
      name.textContent = shortName(c, run.curves);
      name.title = c.name;
      const unit = document.createElement("span");
      unit.className = "unit";
      unit.textContent = c.unit;
      label.append(box, sw, name, unit);
      return label;
    }),
  );
}

function setCurves(names) {
  selected = new Set(names);
  for (const box of $("curve-list").querySelectorAll("input")) box.checked = selected.has(box.value);
  render();
}

function maxVolume() {
  return Math.max(...run.curves.map((c) => c.volume[c.volume.length - 1]));
}

const fmtMl = (v) => String(Math.round(v));

function buildRangePresets() {
  const end = maxVolume();
  const opts = [new Option(`Whole run (0–${fmtMl(end)} ml)`, `0:${end}`)];
  const phases = run.phases.filter((p) => p.name.toLowerCase() !== "method settings");
  phases.forEach((p, i) => {
    const to = phases[i + 1]?.volume ?? end;
    if (to - p.volume > 0.01) opts.push(new Option(`${p.name} (${fmtMl(p.volume)}–${fmtMl(to)} ml)`, `${p.volume}:${to}`));
  });
  opts.push(new Option("Custom", "custom"));
  $("range-preset").replaceChildren(...opts);
  applyPreset();
}

function applyPreset() {
  const v = $("range-preset").value;
  if (v === "custom") return;
  const [a, b] = v.split(":").map(Number);
  $("xmin").value = fmtMl(a);
  $("xmax").value = fmtMl(b);
}

function range() {
  const end = maxVolume();
  // Presets keep their exact volumes; the fields only show them rounded.
  const preset = $("range-preset").value;
  if (preset !== "custom") return preset.split(":").map(Number);
  let a = parseFloat($("xmin").value);
  let b = parseFloat($("xmax").value);
  if (!Number.isFinite(a)) a = 0;
  if (!Number.isFinite(b)) b = end;
  if (b <= a) return [0, end];
  return [a, b];
}

function chartOptions() {
  const [w, h] = $("size").value.split("x").map(Number);
  const [xmin, xmax] = range();
  return {
    curves: curves.filter((c) => selected.has(c.name)),
    layout: $("layout").value,
    xmin,
    xmax,
    showPhases: $("show-phases").checked,
    showFractions: $("show-fractions").checked,
    title: $("title").value.trim(),
    subtitle: $("show-subtitle").checked ? subtitle() : "",
    width: w,
    height: h,
  };
}

function runDate() {
  const s = run.info.MethodStartTime;
  return s ? s.slice(0, 16).replace("T", " ") : "";
}

function subtitle() {
  return [run.info.ColumnInformation, run.info.SystemName, runDate()].filter(Boolean).join("  ·  ");
}

// ------------------------------------------------------------------ preview

let pending = false;
function render() {
  if (!run || pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const opts = chartOptions();
    const canvas = $("chart");
    const cssW = $("canvas-wrap").clientWidth;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round((cssW * dpr * opts.height) / opts.width);
    geom = drawChromatogram(canvas, run, opts);
    geom && (geom.width = opts.width);
    updateDownloadNote();
  });
}

function hover(ev) {
  const tip = $("tooltip");
  const line = $("crosshair");
  if (!geom) return;
  const rect = $("chart").getBoundingClientRect();
  const k = geom.width / rect.width; // logical units per CSS pixel
  const lx = (ev.clientX - rect.left) * k;
  const ly = (ev.clientY - rect.top) * k;
  if (lx < geom.left || lx > geom.right || ly < geom.top - 30 || ly > geom.bottom) {
    tip.hidden = line.hidden = true;
    return;
  }
  const x = geom.xmin + ((lx - geom.left) / (geom.right - geom.left)) * (geom.xmax - geom.xmin);
  line.style.left = `${lx / k}px`;
  line.style.top = `${geom.top / k}px`;
  line.style.height = `${(geom.bottom - geom.top) / k}px`;

  const phase = [...run.phases].reverse().find((p) => p.volume <= x);
  const head = document.createElement("div");
  head.className = "t-head";
  head.textContent = `${x.toFixed(2)} ml${phase ? ` · ${phase.name}` : ""}`;
  const rows = geom.panels.map((p) => {
    const c = p.curve;
    const v = c.amplitude[nearestIndex(c.volume, x)];
    const row = document.createElement("div");
    row.className = "t-row";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.background = p.color;
    const name = document.createElement("span");
    name.textContent = shortName(c, run.curves);
    const val = document.createElement("span");
    val.className = "t-val";
    val.textContent = `${v.toFixed(Math.min(c.precision, 3))} ${c.unit}`.trim();
    row.append(sw, name, val);
    return row;
  });
  tip.replaceChildren(head, ...rows);
  tip.hidden = line.hidden = false;
  const wrapW = rect.width;
  const tx = ev.clientX - rect.left;
  tip.style.top = `${Math.max(0, ev.clientY - rect.top - tip.offsetHeight - 12)}px`;
  tip.style.left = `${tx + 14 + tip.offsetWidth > wrapW ? tx - tip.offsetWidth - 14 : tx + 14}px`;
}

// ------------------------------------------------------------------ run info & method

function runRows() {
  const i = run.info;
  return [
    ["Result", i.Name],
    ["Method", methodName()],
    ["Column", i.ColumnInformation],
    ["System", i.SystemName],
    ["Started", runDate()],
    ["Folder", i.FolderPath],
    ["UNICORN", i.UNICORNVersion],
  ].filter(([, v]) => v);
}

function fillRunInfo() {
  $("run-info").replaceChildren(
    ...runRows().flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function methodName() {
  const first = run.runLog.find((e) => e.text.includes("Method:"));
  const m = first?.text.match(/Method:\s*(.*?)\s+Result:/);
  return m ? m[1] : "";
}

function cells(tr, values, numeric = []) {
  for (const [j, v] of values.entries()) {
    const td = document.createElement("td");
    td.textContent = v;
    if (numeric.includes(j)) td.className = "num";
    tr.append(td);
  }
  return tr;
}

function fillInlets() {
  $("inlet-table").tBodies[0].replaceChildren(
    ...summary.inlets.map((i) => {
      const tr = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = i.inlet;
      const bufCell = document.createElement("td");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "e.g. 20 mM Tris pH 7.4, 150 mM NaCl";
      input.value = buffers[i.inlet] || "";
      input.setAttribute("aria-label", `Buffer on ${i.inlet}`);
      input.addEventListener("input", () => {
        buffers[i.inlet] = input.value.trim();
        fillInletList();
        fillPhases();
      });
      bufCell.append(input);
      tr.append(name, bufCell);
      return tr;
    }),
  );
}

function fillInletList() {
  $("inlet-list").replaceChildren(
    ...summary.inlets.map((i) => {
      const li = document.createElement("li");
      const line = inletLine(i, buffers);
      const cut = line.indexOf("): ") + 2;
      if (buffers[i.inlet] && cut > 1) {
        const buf = document.createElement("span");
        buf.className = "buf";
        buf.textContent = line.slice(cut + 1);
        li.append(line.slice(0, cut + 1), buf);
      } else {
        li.textContent = line;
      }
      return li;
    }),
  );
}

function fillFractions() {
  const rows = fractionRows(summary);
  $("fractions-block").hidden = !rows.length;
  if (!rows.length) return;
  const cols = Object.keys(rows[0]).filter((c) => rows.some((r) => r[c]));
  const numeric = new Set(["Size (ml)", "Max A280 (mAU)"]);
  const head = document.createElement("tr");
  for (const c of cols) {
    const th = document.createElement("th");
    th.textContent = c;
    if (numeric.has(c)) th.className = "num";
    head.append(th);
  }
  $("fraction-table").tHead.replaceChildren(head);
  $("fraction-table").tBodies[0].replaceChildren(
    ...rows.map((r) => cells(document.createElement("tr"), cols.map((c) => r[c]),
      cols.map((c, j) => (numeric.has(c) ? j : -1)).filter((j) => j >= 0))),
  );
}

function fillPhases() {
  $("phase-list").replaceChildren(
    ...summary.phases.map((ph) => {
      const li = document.createElement("li");
      const head = document.createElement("div");
      head.className = "ph-head";
      const [title, ...meta] = phaseHeader(ph).split("  ·  ");
      head.textContent = title;
      if (meta.length) {
        const m = document.createElement("span");
        m.className = "ph-meta";
        m.textContent = meta.join(" · ");
        head.append(m);
      }
      const ul = document.createElement("ul");
      phaseLines(ph, buffers).forEach((line, k) => {
        const item = document.createElement("li");
        item.textContent = line;
        if (k < ph.uses.length) item.className = "use";
        ul.append(item);
      });
      li.append(head, ul);
      return li;
    }),
  );
}

function fillMethod() {
  summary = phaseSummary(run);
  buffers = {};
  fillInlets();
  fillInletList();
  fillFractions();
  fillPhases();
  $("var-count").textContent = run.variables.length;
  $("var-table").tBodies[0].replaceChildren(
    ...run.variables.map((v) => cells(document.createElement("tr"), [v.name, `${v.value} ${v.unit}`.trim()])),
  );
  $("log-count").textContent = run.runLog.length;
  $("log-table").tBodies[0].replaceChildren(
    ...run.runLog.map((e) => cells(document.createElement("tr"), [e.volume.toFixed(2), e.time.toFixed(2), e.text], [0, 1])),
  );
  let outline = "";
  try {
    outline = methodOutline(run.methodXml);
  } catch (err) {
    console.warn("Method outline failed", err);
  }
  run.outline = outline;
  $("method-outline").textContent = outline || "No method definition found in this export.";
}

function methodText() {
  const i = run.info;
  const lines = [
    `Result:   ${i.Name || run.name}`,
    `Method:   ${methodName()}`,
    `Column:   ${i.ColumnInformation || ""}`,
    `System:   ${i.SystemName || ""}`,
    `Started:  ${runDate()}`,
    `Folder:   ${i.FolderPath || ""}`,
    `UNICORN:  ${i.UNICORNVersion || ""}`,
    "",
    ...summaryText(summary, buffers),
    "METHOD VARIABLES",
    ...run.variables.map((v) => `  ${v.name}: ${v.value} ${v.unit}`.trimEnd()),
    "",
    "METHOD OUTLINE (breakpoints in the block's base unit)",
    run.outline || "  (not found in export)",
    "",
    "RUN LOG",
    "        ml       min  Entry",
    ...run.runLog.map((e) => `${e.volume.toFixed(3).padStart(10)}${e.time.toFixed(3).padStart(10)}  ${e.text}`),
    "",
  ];
  return lines.join("\r\n");
}

// ------------------------------------------------------------------ downloads

function baseName() {
  return (run.info.Name || run.name).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_");
}

function tableOptions() {
  const [xmin, xmax] = range();
  const limit = $("csv-range").checked;
  return {
    step: CSV_STEP,
    xmin: limit ? xmin : null,
    xmax: limit ? xmax : null,
    addTime: $("add-time").checked,
    addCV: $("add-cv").checked,
  };
}

function wantedOutputs() {
  return [...document.querySelectorAll('input[name="out"]:checked')].map((b) => b.value);
}

function updateDownloadNote() {
  const outs = wantedOutputs();
  const o = tableOptions();
  const [a, b] = o.xmin != null ? [o.xmin, o.xmax] : [0, maxVolume()];
  const rows = Math.floor((b - a) / o.step) + 1;
  const parts = [];
  if (outs.includes("selected") || outs.includes("all")) parts.push(`CSVs: about ${rows.toLocaleString()} rows at ${o.step} ml.`);
  if (outs.includes("selected") && !selected.size) parts.push("No curves selected for the selected-curves CSV.");
  if (outs.length > 1) parts.push("Files come as one zip.");
  $("download-note").textContent = parts.join(" ");
  $("download").disabled = !outs.length;
}

async function makeFiles() {
  const outs = wantedOutputs();
  const base = baseName();
  const files = [];
  if (outs.includes("png")) {
    const opts = chartOptions();
    const res = parseFloat($("res").value);
    const canvas = document.createElement("canvas");
    canvas.width = opts.width * res;
    canvas.height = opts.height * res;
    drawChromatogram(canvas, run, opts);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    files.push({ name: `${base}_chromatogram.png`, blob });
  }
  const tOpts = tableOptions();
  if (outs.includes("selected") && selected.size) {
    const t = buildTable(run, curves.filter((c) => selected.has(c.name)), tOpts);
    files.push({ name: `${base}_selected_curves.csv`, blob: new Blob([toCsv(t)], { type: "text/csv" }) });
  }
  if (outs.includes("all")) {
    const t = buildTable(run, curves, tOpts);
    files.push({ name: `${base}_all_curves.csv`, blob: new Blob([toCsv(t)], { type: "text/csv" }) });
  }
  if (outs.includes("method")) {
    files.push({ name: `${base}_method.txt`, blob: new Blob([methodText()], { type: "text/plain" }) });
  }
  return files;
}

function save(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function download() {
  const btn = $("download");
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const files = await makeFiles();
    if (files.length === 1) {
      save(files[0].blob, files[0].name);
    } else if (files.length > 1) {
      const zip = new JSZip();
      for (const f of files) zip.file(f.name, f.blob);
      save(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `${baseName()}_summary.zip`);
    }
  } catch (err) {
    console.error(err);
    setStatus(`Download failed: ${err.message || err}`, true);
  } finally {
    btn.textContent = "Download";
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ clipboard

function flash(btn, ok) {
  const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
  btn.textContent = ok ? "Copied" : "Copy failed";
  btn.classList.toggle("done", ok);
  clearTimeout(btn._timer);
  btn._timer = setTimeout(() => {
    btn.textContent = label;
    btn.classList.remove("done");
  }, 1600);
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, true);
  } catch (err) {
    console.error(err);
    flash(btn, false);
  }
}

async function copyChart() {
  const btn = $("copy-chart");
  try {
    const opts = chartOptions();
    const res = parseFloat($("res").value);
    const canvas = document.createElement("canvas");
    canvas.width = opts.width * res;
    canvas.height = opts.height * res;
    drawChromatogram(canvas, run, opts);
    // Pass a promise so the write starts inside the click (Safari requires that).
    const png = new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    flash(btn, true);
  } catch (err) {
    console.error(err);
    flash(btn, false);
    setStatus("This browser blocked copying the image. Use Download for the PNG instead.", true);
  }
}

// ------------------------------------------------------------------ wiring

const drop = $("drop");
drop.addEventListener("click", (e) => {
  if (e.target.id !== "browse") $("file").click();
});
$("browse").addEventListener("click", () => $("file").click());
// Navigate rather than reload so browsers don't restore the previous form state.
$("reset").addEventListener("click", () => location.replace(location.pathname));
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("file").click();
  }
});
$("file").addEventListener("change", (e) => {
  handleFile(e.target.files[0]);
  e.target.value = "";
});
for (const t of ["dragenter", "dragover"]) {
  drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
}
for (const t of ["dragleave", "drop"]) drop.addEventListener(t, () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  handleFile(e.dataTransfer.files[0]);
});
// Don't let a near-miss drop navigate away from the page.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("run-select").addEventListener("change", (e) => openRun(Number(e.target.value)).catch((err) => setStatus(err.message, true)));
$("curves-default").addEventListener("click", () => setCurves(DEFAULT_CURVES));
$("curves-none").addEventListener("click", () => setCurves([]));
$("range-preset").addEventListener("change", () => {
  applyPreset();
  render();
});
for (const id of ["xmin", "xmax"]) {
  $(id).addEventListener("input", () => {
    $("range-preset").value = "custom";
    render();
  });
}
for (const id of ["layout", "show-phases", "show-fractions", "title", "show-subtitle", "size"]) {
  $(id).addEventListener("input", render);
}
for (const id of ["add-time", "add-cv", "csv-range"]) $(id).addEventListener("input", updateDownloadNote);
for (const box of document.querySelectorAll('input[name="out"]')) box.addEventListener("change", updateDownloadNote);
$("download").addEventListener("click", download);
$("copy-chart").addEventListener("click", copyChart);
$("copy-run").addEventListener("click", (e) =>
  copyText(e.currentTarget, runRows().map(([k, v]) => `${k}: ${v}`).join("\n")));
$("copy-method").addEventListener("click", (e) =>
  copyText(e.currentTarget, summaryText(summary, buffers).join("\n").trimEnd()));

const wrap = $("canvas-wrap");
wrap.addEventListener("mousemove", hover);
wrap.addEventListener("mouseleave", () => {
  $("tooltip").hidden = $("crosshair").hidden = true;
});
new ResizeObserver(render).observe(wrap);
