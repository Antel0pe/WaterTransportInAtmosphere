// app/api/evaporation/[datehour]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Parse a datehour string in the format: "YYYY-MM-DDTHH:mm"
 * Interprets the input as UTC.
 */
function parseDatehour(datehour: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(datehour);
  if (!m) throw new Error("Invalid datehour");

  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("Invalid datehour ranges");
  }

  const dt = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  // Validate normalization didn’t occur (e.g., Feb 30)
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day ||
    dt.getUTCHours() !== hour ||
    dt.getUTCMinutes() !== minute
  ) {
    throw new Error("Invalid datehour calendar");
  }

  return dt;
}

/** Snap to hour since files are hourly. */
function snapToHour(dt: Date): Date {
  return new Date(
    Date.UTC(
      dt.getUTCFullYear(),
      dt.getUTCMonth(),
      dt.getUTCDate(),
      dt.getUTCHours(),
      0,
      0,
      0
    )
  );
}

/**
 * Files look like: "2021-11-01T00-00-00.json"
 * We accept datehour to minute, but snap to hour and format to filename.
 */
function toJsonFilename(dtHourly: Date): string {
  const y = dtHourly.getUTCFullYear();
  const mo = String(dtHourly.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtHourly.getUTCDate()).padStart(2, "0");
  const h = String(dtHourly.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}-00-00.json`;
}

/**
 * Extract a comparable key from a filename, or null if it doesn't match.
 * Comparable key is the filename itself (lexicographic sort works for this pattern).
 */
function parseContourJsonName(name: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/.test(name)) return null;
  return name;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ datehour: string }> }
) {
  const { datehour } = await context.params;

  let target: Date;
  try {
    target = parseDatehour(datehour);
  } catch {
    return NextResponse.json(
      { error: "Invalid datehour format" },
      { status: 400 }
    );
  }

  const hourly = snapToHour(target);
  const filename = toJsonFilename(hourly);

  const jsonDir = path.join(process.cwd(), "public", "msl_contours");

  let files: string[];
  try {
    files = await readdir(jsonDir);
  } catch {
    return NextResponse.json(
      { error: "contour directory missing or unreadable" },
      { status: 500 }
    );
  }

  const keys = files
    .map(parseContourJsonName)
    .filter((x): x is string => x !== null)
    .sort();

  if (keys.length === 0) {
    return NextResponse.json(
      { error: "no contour json files available" },
      { status: 500 }
    );
  }

  const firstKey = keys[0];
  const lastKey = keys[keys.length - 1];

  // Out of bounds => 404
  if (filename < firstKey || filename > lastKey) {
    return NextResponse.json({ error: "no such hour exists" }, { status: 404 });
  }

  // In bounds but missing specific hour => 404
  if (!keys.includes(filename)) {
    return NextResponse.json({ error: "no such hour exists" }, { status: 404 });
  }

  const jsonPath = path.join(jsonDir, filename);

  let buf: Buffer;
  try {
    buf = await readFile(jsonPath);
  } catch {
    return NextResponse.json(
      { error: "contour json missing or unreadable" },
      { status: 500 }
    );
  }

  // Return JSON bytes exactly as stored (no gz, no transform)
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
