"""Integration tests against a real export.

Point UNICORN_SAMPLE_ZIP at a result .zip, or drop one in tests/data/.
Skipped automatically if no sample is available.
"""
import os
from pathlib import Path

import numpy as np
import pytest

from unicorn_export import UnicornResult, method_outline, to_dataframe

DATA = Path(__file__).parent / "data"
SAMPLE = os.environ.get("UNICORN_SAMPLE_ZIP") or next(iter(sorted(DATA.glob("*.zip"))), None)
pytestmark = pytest.mark.skipif(not SAMPLE, reason="no sample UNICORN export available")


@pytest.fixture(scope="module")
def result():
    return UnicornResult(SAMPLE)


def test_curves_have_matching_axes(result):
    curves = result.curves()
    assert "UV 1_280" in curves
    for c in curves.values():
        assert c.volume is not None and len(c.volume) == len(c.amplitude)
        assert np.all(np.diff(c.volume) >= 0)


def test_dataframe_single_volume_column(result):
    df = to_dataframe(result)
    assert df.columns[0] == "Volume (ml)"
    assert df.columns[1].startswith("A280")
    assert len(df) == len(result.curves()["UV 1_280"])


def test_method_outline(result):
    text = method_outline(result.method_xml())
    assert text.startswith("Method:")
    assert "Block:" in text


def test_events_and_phases(result):
    assert result.run_log()
    assert result.phases()
