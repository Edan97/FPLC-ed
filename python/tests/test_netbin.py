"""Format-level tests that need no instrument data."""
import struct

import numpy as np
import pytest

from unicorn_export.netbin import NetBinError, read_primitive_array, read_string

HEADER = bytes([0x00]) + struct.pack("<iiii", 1, -1, 1, 0)  # 17-byte SerializationHeaderRecord


def make_single_array(values):
    arr = np.asarray(values, dtype="<f4")
    return HEADER + bytes([0x0F]) + struct.pack("<ii", 1, len(arr)) + bytes([11]) + arr.tobytes() + b"\x0b"


def make_string(text):
    data = text.encode("utf-8")
    n, enc = len(data), bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        enc.append(b | (0x80 if n else 0))
        if not n:
            break
    return HEADER + bytes([0x06]) + struct.pack("<i", 1) + bytes(enc) + data + b"\x0b"


def test_float_array_roundtrip():
    vals = [0.0, 1.5, -2.25, 1715.926]
    out = read_primitive_array(make_single_array(vals))
    assert np.allclose(out, vals, atol=1e-3)
    assert len(out) == 4  # no leading values skipped


def test_long_string_uses_multibyte_length():
    text = "<Method>" + "x" * 1000 + "</Method>"
    assert read_string(make_string(text)) == text


def test_rejects_garbage():
    with pytest.raises(NetBinError):
        read_primitive_array(b"PK\x03\x04 not a netbin stream")
