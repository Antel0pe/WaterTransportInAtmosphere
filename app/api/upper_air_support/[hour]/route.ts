import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

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

  const jsonPath = path.join(
    process.cwd(),
    "public",
    "upper_air_support",
    "frames",
    toFrameFilename(hourKey)
  );

  let buf: Buffer;
  try {
    buf = await readFile(jsonPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
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
