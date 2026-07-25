// Client-side CSV parsing for bulk device import (plan/device-naming-and-
// bulk-import-v1.md §2.6) -- keeps the backend accepting pre-parsed JSON
// rows rather than needing its own CSV dependency.

export interface ParsedCsvRow {
  addr: string;
  hostname?: string;
  mac?: string;
  timezone?: string;
}

export interface CsvParseError {
  line: number;
  message: string;
}

export interface CsvParseResult {
  rows: ParsedCsvRow[];
  errors: CsvParseError[];
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

export function parseDeviceCsv(text: string): CsvParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { rows: [], errors: [{ line: 0, message: "CSV is empty" }] };
  }

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const addrIdx = header.indexOf("addr");
  if (addrIdx === -1) {
    return { rows: [], errors: [{ line: 1, message: 'Missing required "addr" column' }] };
  }
  const hostnameIdx = header.indexOf("hostname");
  const macIdx = header.indexOf("mac");
  const timezoneIdx = header.indexOf("timezone");

  const rows: ParsedCsvRow[] = [];
  const errors: CsvParseError[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    const addr = cols[addrIdx];
    if (!addr) {
      errors.push({ line: i + 1, message: "Missing address" });
      continue;
    }
    rows.push({
      addr,
      ...(hostnameIdx !== -1 && cols[hostnameIdx] ? { hostname: cols[hostnameIdx] } : {}),
      ...(macIdx !== -1 && cols[macIdx] ? { mac: cols[macIdx] } : {}),
      ...(timezoneIdx !== -1 && cols[timezoneIdx] ? { timezone: cols[timezoneIdx] } : {}),
    });
  }

  return { rows, errors };
}
