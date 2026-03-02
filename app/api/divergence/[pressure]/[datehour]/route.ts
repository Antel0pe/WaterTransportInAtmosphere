import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseDatehour(datehour: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(datehour);
  if (!m) throw new Error("Invalid datehour");

  const year = Number(m[1]);
  const month = Number(m[2]);
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

function toPngFilename(dtHourly: Date): string {
  const y = dtHourly.getUTCFullYear();
  const mo = String(dtHourly.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dtHourly.getUTCDate()).padStart(2, "0");
  const h = String(dtHourly.getUTCHours()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}-00-00.png`;
}

function parsePngName(name: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.png$/.test(name)) return null;
  return name;
}

function parsePressureLevel(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error("Invalid pressure");
  const p = Number(raw);
  if (!Number.isInteger(p)) throw new Error("Invalid pressure");
  if (p !== 250 && p !== 500 && p !== 925) throw new Error("Unsupported pressure");
  return p;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ pressure: string; datehour: string }> }
) {
  const { pressure: pressureRaw, datehour } = await context.params;

  let pressure: number;
  try {
    pressure = parsePressureLevel(pressureRaw);
  } catch {
    return NextResponse.json(
      { error: "Invalid pressure level (allowed: 250, 500, 925)" },
      { status: 400 }
    );
  }

  let target: Date;
  try {
    target = parseDatehour(datehour);
  } catch {
    return NextResponse.json({ error: "Invalid datehour format" }, { status: 400 });
  }

  const hourly = snapToHour(target);
  const filename = toPngFilename(hourly);
  const imgDir = path.join(process.cwd(), "public", "divergence-rg", String(pressure));

  let files: string[];
  try {
    files = await readdir(imgDir);
  } catch {
    return NextResponse.json(
      { error: "image directory missing or unreadable" },
      { status: 500 }
    );
  }

  const keys = files.map(parsePngName).filter((x): x is string => x !== null).sort();

  if (keys.length === 0) {
    return NextResponse.json({ error: "no divergence images available" }, { status: 500 });
  }

  const firstKey = keys[0];
  const lastKey = keys[keys.length - 1];

  if (filename < firstKey || filename > lastKey) {
    return NextResponse.json({ error: "no such hour exists" }, { status: 404 });
  }

  if (!keys.includes(filename)) {
    return NextResponse.json({ error: "no such hour exists" }, { status: 404 });
  }

  const imgPath = path.join(imgDir, filename);

  let buf: Buffer;
  try {
    buf = await readFile(imgPath);
  } catch {
    return NextResponse.json({ error: "image missing or unreadable" }, { status: 500 });
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
    },
  });
}
