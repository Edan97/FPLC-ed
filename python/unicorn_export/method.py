"""Turn the method XML stored in a result export into a readable outline."""
from __future__ import annotations

import xml.etree.ElementTree as ET


def _params(instr) -> list[str]:
    out = []
    for p in instr.iter():
        if p.tag in ("GenericCommandParameter", "StrategyParameter"):
            v = p.findtext("ParameterReadableValue") or p.findtext("ParameterValue")
            if not v or v == "None":
                continue
            unit = p.findtext("ParameterUnit") or ""
            out.append(f"{v} {unit}".strip())
    return out


def method_blocks(method_xml: str) -> dict[str, list[dict]]:
    root = ET.fromstring(method_xml)
    blocks = {}
    for b in root.find("Blocks"):
        name = b.findtext("BlockName")
        instrs = []
        for bi in b.find("BlockInstructions"):
            instrs.append({
                "breakpoint": float(bi.findtext("BreakPointValue") or 0),
                "name": bi.findtext("ReadableName"),
                "params": _params(bi),
                "calls": bi.findtext(".//CalledBlockName"),
            })
        blocks[name] = {"main": b.findtext("IsMainBlock") == "true", "instructions": instrs}
    return blocks


def method_outline(method_xml: str) -> str:
    """Nested text outline starting from the main block, expanding called blocks in place."""
    root = ET.fromstring(method_xml)
    blocks = method_blocks(method_xml)
    main = next((n for n, b in blocks.items() if b["main"]), None)
    lines = [f"Method: {root.findtext('Description')}",
             f"System: {root.findtext('SystemName')}   Technique: {root.findtext('TechniqueName')}",
             f"Created: {root.findtext('Created')}   Last modified: {root.findtext('LastModified')}", ""]

    def walk(name, depth, seen):
        for ins in blocks[name]["instructions"]:
            if ins["name"] == "Block" and ins["calls"] in blocks and ins["calls"] not in seen:
                lines.append(f"{'  ' * depth}{ins['breakpoint']:6.2f}  Block: {ins['calls']}")
                walk(ins["calls"], depth + 1, seen | {ins["calls"]})
            elif ins["name"] == "Watch" and ins["calls"] in blocks:
                lines.append(f"{'  ' * depth}{ins['breakpoint']:6.2f}  Watch: {', '.join(ins['params'])}")
            else:
                lines.append(f"{'  ' * depth}{ins['breakpoint']:6.2f}  {ins['name']}"
                             + (f": {', '.join(ins['params'])}" if ins["params"] else ""))

    if main:
        walk(main, 0, {main})
    return "\n".join(lines)
