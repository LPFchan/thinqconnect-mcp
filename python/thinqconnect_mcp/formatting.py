"""
    * SPDX-FileCopyrightText: Copyright 2025 LG Electronics Inc.
    * SPDX-License-Identifier: Apache-2.0

Pure output formatters shared by the Python server and parity-tested against
the Cloudflare Worker port in ../../index.ts.

This module deliberately imports nothing beyond the standard library. The rest
of the package pulls in the ``thinqconnect`` SDK at import time, which needs
credentials and a network stack; keeping the formatters here lets the parity
tests run without any of that.

Any change to a function in this file must be mirrored in ``index.ts`` and in
the golden files under ``test/fixtures/expected/``.
"""

import json
from typing import Any, Dict, List


def format_device_list(devices: List[Dict[str, Any]]) -> str:
    """Render the ThinQ ``GET /devices`` payload as the device-list tool output."""
    device_info = []
    for device in devices:
        device_info.append(
            f"Device ID: {device.get('deviceId')}\n"
            f"Device Name: {device.get('deviceInfo').get('alias')}\n"
            f"Device Type: {device.get('deviceInfo').get('deviceType')}\n"
            f"Model Name: {device.get('deviceInfo').get('modelName')}\n"
        )
    header = f"Found {len(devices)} devices:\n\n"
    return header + "\n".join(device_info)


def format_device_status(device_status: Any) -> str:
    """Render the ThinQ ``GET /devices/{id}/state`` payload as tool output.

    The status body is serialized as JSON rather than with ``str()`` so that the
    Worker port can produce a byte-identical string. Python's ``repr`` of a dict
    uses single quotes and ``True``/``None``, which no JSON serializer emits.
    """
    return (
        "Device status information is as follows.\n"
        "Please relay appropriately to the user.\n"
        "## Status Information\n"
        + json.dumps(device_status, indent=2, ensure_ascii=False)
        + "\n"
    )
