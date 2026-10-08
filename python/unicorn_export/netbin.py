"""Minimal reader for the .NET BinaryFormatter payloads used inside UNICORN exports.

UNICORN 6/7 stores each data curve and each settings blob as a small zip whose
members are serialized with Microsoft's BinaryFormatter (MS-NRBF). Only two
record shapes are needed here:

* ``ArraySinglePrimitive`` (record type 0x0F) holding ``System.Single[]``
  -> curve amplitudes and volumes (little-endian float32).
* ``BinaryObjectString`` (record type 0x06) -> the XML documents
  (MethodData, SystemData, ColumnTypeData, ...).

Layout of the files handled here::

    17 bytes  SerializationHeaderRecord (0x00, rootId, headerId, major, minor)
    1 byte    record type
    ...       record body
    1 byte    MessageEnd (0x0B)
"""
from __future__ import annotations

import struct

import numpy as np

HEADER_LEN = 17
REC_OBJECT_STRING = 0x06
REC_ARRAY_SINGLE_PRIMITIVE = 0x0F
MESSAGE_END = 0x0B

# MS-NRBF PrimitiveTypeEnumeration -> numpy dtype
_PRIMITIVE_DTYPES = {
    6: "<f8",   # Double
    8: "<i4",   # Int32
    9: "<i8",   # Int64
    11: "<f4",  # Single
}


class NetBinError(ValueError):
    pass


def _check_header(buf: bytes) -> None:
    if len(buf) < HEADER_LEN + 1 or buf[0] != 0x00:
        raise NetBinError("Not a BinaryFormatter stream (missing serialization header)")


def read_primitive_array(buf: bytes) -> np.ndarray:
    """Decode an ArraySinglePrimitive record (e.g. System.Single[]) into a numpy array."""
    _check_header(buf)
    pos = HEADER_LEN
    if buf[pos] != REC_ARRAY_SINGLE_PRIMITIVE:
        raise NetBinError(f"Expected ArraySinglePrimitive record, got 0x{buf[pos]:02x}")
    _obj_id, length = struct.unpack_from("<ii", buf, pos + 1)
    ptype = buf[pos + 9]
    if ptype not in _PRIMITIVE_DTYPES:
        raise NetBinError(f"Unsupported primitive type {ptype}")
    dtype = np.dtype(_PRIMITIVE_DTYPES[ptype])
    start = pos + 10
    end = start + length * dtype.itemsize
    if end > len(buf):
        raise NetBinError("Array length exceeds buffer size")
    return np.frombuffer(buf[start:end], dtype=dtype).astype(float)


def _read_7bit_int(buf: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, pos
        shift += 7


def read_string(buf: bytes) -> str:
    """Decode a BinaryObjectString record (length-prefixed UTF-8)."""
    _check_header(buf)
    pos = HEADER_LEN
    if buf[pos] != REC_OBJECT_STRING:
        raise NetBinError(f"Expected BinaryObjectString record, got 0x{buf[pos]:02x}")
    length, pos = _read_7bit_int(buf, pos + 5)  # skip record type + int32 object id
    return buf[pos:pos + length].decode("utf-8")
