import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getDataRootPath } from "@/app/api/_lib/dataRoot";
import { noDataForDateResponse } from "@/app/api/_lib/noDataResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseHourKey(hour: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(hour)) {
    throw new Error("Invalid hour key");
  }
  return hour;
}

function toFrameFilename(hourKey: string): string {
  return `${hourKey.replace(":", "-")}.json`;
}

function parseFrameFilename(name: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}\.json$/.test(name)) return null;
  return name;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ hour: string }> }
) {
  const { hour } = await context.params;

  let hourKey: string;
  try {
    hourKey = parseHourKey(hour);
  } catch {
    return NextResponse.json(
      { error: "Invalid hour format (expected YYYY-MM-DDTHH:00)" },
      { status: 400 }
    );
  }

  const framesDir = path.join(getDataRootPath(), "upper_air_support", "frames");
  const jsonPath = path.join(framesDir, toFrameFilename(hourKey));

  let buf: Buffer;
  try {
    buf = await readFile(jsonPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      try {
        const keys = (await readdir(framesDir))
          .map(parseFrameFilename)
          .filter((x): x is string => x !== null)
          .sort();

        if (keys.length > 0) {
          return noDataForDateResponse(keys[0], keys[keys.length - 1]);
        }
      } catch {
        // fall through to the generic 404 below.
      }
      return NextResponse.json({ error: "no such hour exists" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "upper air support frame missing or unreadable" },
      { status: 500 }
    );
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
