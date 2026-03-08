import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const jsonPath = path.join(
    process.cwd(),
    "public",
    "backward_trajectory",
    "current.json"
  );

  let buf: Buffer;
  try {
    buf = await readFile(jsonPath);
  } catch {
    return NextResponse.json(
      { error: "backward trajectory json missing or unreadable" },
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
