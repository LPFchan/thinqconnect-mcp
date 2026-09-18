"""
    * SPDX-FileCopyrightText: Copyright 2025 LG Electronics Inc.
    * SPDX-License-Identifier: Apache-2.0

Parity suite. The fixtures and golden files read below are shared verbatim with
../../test/logic.test.ts — both implementations are asserted against the same
expected bytes, so drift on either side fails on both sides.

Only get_device_list and get_device_status are covered. The other two tools
intentionally do NOT match the Worker port; see "Worker/Python divergences" in
README.md.

These tests import only thinqconnect_mcp.formatting, which has no dependency on
the thinqconnect SDK, so the suite runs without LG credentials installed.
"""

import json
from pathlib import Path

import pytest

from thinqconnect_mcp.formatting import format_device_list, format_device_status

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def golden(name: str) -> str:
    return (FIXTURES / "expected" / name).read_text(encoding="utf-8")


class TestFormatDeviceList:
    def test_matches_golden_for_populated_list(self):
        devices = json.loads(fixture("devices.json"))
        assert format_device_list(devices) == golden("device-list.txt")

    def test_matches_golden_for_empty_list(self):
        devices = json.loads(fixture("devices-empty.json"))
        assert format_device_list(devices) == golden("device-list-empty.txt")


class TestFormatDeviceStatus:
    def test_matches_golden_for_status_payload(self):
        status = json.loads(fixture("device-status.json"))
        assert format_device_status(status) == golden("device-status.txt")

    def test_keeps_non_ascii_unescaped(self):
        assert '"거실 에어컨"' in format_device_status({"alias": "거실 에어컨"})


class TestKnownDivergences:
    """Behavior the two ports do not share. Asserted so it stays visible."""

    def test_whole_number_floats_keep_their_decimal_point(self):
        # Python emits 23.0; JSON.stringify in the Worker emits 23. A device
        # status carrying a whole-number float therefore renders differently on
        # the two ports. The matching assertion lives in test/logic.test.ts.
        assert '"targetTemperature": 23.0' in format_device_status(
            {"targetTemperature": 23.0}
        )

    def test_missing_device_info_raises_rather_than_printing_undefined(self):
        # Python raises AttributeError, which the caller in tools.py turns into
        # "An error occurred while retrieving device list: ...". The Worker uses
        # optional chaining and prints the string "undefined" instead.
        with pytest.raises(AttributeError):
            format_device_list([{"deviceId": "d1"}])
