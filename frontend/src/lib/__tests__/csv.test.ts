import { describe, it, expect } from "vitest";
import { parseDeviceCsv } from "@/lib/csv";

describe("parseDeviceCsv", () => {
  it("parses addr and hostname columns", () => {
    const { rows, errors } = parseDeviceCsv(
      "addr,hostname\n10.0.1.1,floor-1-switch\n10.0.1.2,floor-2-switch"
    );
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { addr: "10.0.1.1", hostname: "floor-1-switch" },
      { addr: "10.0.1.2", hostname: "floor-2-switch" },
    ]);
  });

  it("is case-insensitive on headers and trims whitespace", () => {
    const { rows, errors } = parseDeviceCsv("ADDR, Hostname \n 10.0.1.1 , floor-1-switch ");
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ addr: "10.0.1.1", hostname: "floor-1-switch" }]);
  });

  it("supports optional mac and timezone columns", () => {
    const { rows } = parseDeviceCsv(
      "addr,hostname,mac,timezone\n10.0.1.1,floor-1-switch,AA:BB:CC:DD:EE:01,America/New_York"
    );
    expect(rows).toEqual([
      {
        addr: "10.0.1.1",
        hostname: "floor-1-switch",
        mac: "AA:BB:CC:DD:EE:01",
        timezone: "America/New_York",
      },
    ]);
  });

  it("allows hostname to be omitted from a row when the column exists", () => {
    const { rows } = parseDeviceCsv("addr,hostname\n10.0.1.1,\n10.0.1.2,floor-2-switch");
    expect(rows).toEqual([{ addr: "10.0.1.1" }, { addr: "10.0.1.2", hostname: "floor-2-switch" }]);
  });

  it("skips blank lines", () => {
    const { rows } = parseDeviceCsv("addr,hostname\n10.0.1.1,a\n\n10.0.1.2,b\n");
    expect(rows).toHaveLength(2);
  });

  it("reports a row missing its address as an error without dropping other rows", () => {
    const { rows, errors } = parseDeviceCsv(
      "addr,hostname\n10.0.1.1,a\n,no-addr-here\n10.0.1.2,b"
    );
    expect(rows).toEqual([
      { addr: "10.0.1.1", hostname: "a" },
      { addr: "10.0.1.2", hostname: "b" },
    ]);
    expect(errors).toEqual([{ line: 3, message: "Missing address" }]);
  });

  it("errors the whole file when the addr column is missing", () => {
    const { rows, errors } = parseDeviceCsv("hostname\nfloor-1-switch");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 1, message: 'Missing required "addr" column' }]);
  });

  it("errors on an empty file", () => {
    const { rows, errors } = parseDeviceCsv("");
    expect(rows).toEqual([]);
    expect(errors).toEqual([{ line: 0, message: "CSV is empty" }]);
  });

  it("supports quoted fields containing commas", () => {
    const { rows } = parseDeviceCsv('addr,hostname\n10.0.1.1,"lobby, main entrance"');
    expect(rows).toEqual([{ addr: "10.0.1.1", hostname: "lobby, main entrance" }]);
  });
});
