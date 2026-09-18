import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatDeviceList,
  formatDeviceStatus,
  messageId,
  thinqBaseUrl,
  toCamel,
  unwrapThinqResponse,
} from "../index";

// Parity suite. The fixtures and golden files below are shared verbatim with
// python/tests/test_parity.py — both implementations are asserted against the
// same expected bytes, so drift on either side fails on both sides.
//
// Only get_device_list and get_device_status are covered here. The other two
// tools intentionally do NOT match the Python server; see "Worker/Python
// divergences" in README.md.

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");

const golden = (name: string) => fixture(`expected/${name}`);

describe("formatDeviceList", () => {
  it("matches the shared golden for a populated device list", () => {
    expect(formatDeviceList(JSON.parse(fixture("devices.json")))).toBe(
      golden("device-list.txt"),
    );
  });

  it("matches the shared golden for an empty device list", () => {
    expect(formatDeviceList(JSON.parse(fixture("devices-empty.json")))).toBe(
      golden("device-list-empty.txt"),
    );
  });

  it("treats a non-array payload as empty rather than throwing", () => {
    expect(formatDeviceList(null)).toBe("Found 0 devices:\n\n");
  });
});

describe("formatDeviceStatus", () => {
  it("matches the shared golden for a device status payload", () => {
    expect(formatDeviceStatus(JSON.parse(fixture("device-status.json")))).toBe(
      golden("device-status.txt"),
    );
  });

  it("keeps non-ASCII characters unescaped, as Python's ensure_ascii=False does", () => {
    expect(formatDeviceStatus({ alias: "거실 에어컨" })).toContain('"거실 에어컨"');
  });
});

// Behavior the two ports do not share. Asserted so it stays visible.
// The matching assertions live in python/tests/test_parity.py.
describe("known divergences from the Python server", () => {
  it("drops the decimal point on whole-number floats", () => {
    // Python emits 23.0 here; JSON.stringify emits 23.
    expect(formatDeviceStatus({ targetTemperature: 23.0 })).toContain(
      '"targetTemperature": 23',
    );
    expect(formatDeviceStatus({ targetTemperature: 23.0 })).not.toContain("23.0");
  });

  it("prints 'undefined' for a missing deviceInfo instead of raising", () => {
    // Python raises AttributeError, which its caller turns into an error string.
    expect(formatDeviceList([{ deviceId: "d1" }])).toContain("Device Name: undefined");
  });
});

describe("thinqBaseUrl", () => {
  it("maps known countries to their region host", () => {
    expect(thinqBaseUrl("KR")).toBe("https://api-kic.lgthinq.com");
    expect(thinqBaseUrl("US")).toBe("https://api-aic.lgthinq.com");
    expect(thinqBaseUrl("DE")).toBe("https://api-eic.lgthinq.com");
  });

  it("is case insensitive", () => {
    expect(thinqBaseUrl("kr")).toBe(thinqBaseUrl("KR"));
  });

  it("falls back to the Korea region for unknown countries", () => {
    expect(thinqBaseUrl("ZZ")).toBe("https://api-kic.lgthinq.com");
  });
});

describe("toCamel", () => {
  it("converts snake_case property names", () => {
    expect(toCamel("air_con_operation_mode")).toBe("airConOperationMode");
    expect(toCamel("cool_target_temperature")).toBe("coolTargetTemperature");
  });

  it("leaves camelCase untouched", () => {
    expect(toCamel("airConOperationMode")).toBe("airConOperationMode");
  });

  it("handles digits after the underscore", () => {
    expect(toCamel("pm_2_5")).toBe("pm25");
  });
});

describe("unwrapThinqResponse", () => {
  it("unwraps the { response: ... } envelope", () => {
    expect(unwrapThinqResponse({ response: { a: 1 } })).toEqual({ a: 1 });
  });

  it("passes through a bare body", () => {
    expect(unwrapThinqResponse({ a: 1 })).toEqual({ a: 1 });
  });

  it("passes through null", () => {
    expect(unwrapThinqResponse(null)).toBeNull();
  });
});

describe("messageId", () => {
  it("is url-safe base64 of 16 bytes with padding stripped", () => {
    const id = messageId();
    expect(id).toHaveLength(22);
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("is not constant", () => {
    expect(messageId()).not.toBe(messageId());
  });
});
