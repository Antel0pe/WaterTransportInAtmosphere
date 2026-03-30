import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getFilesystemDataRootPath } from "@/app/api/_lib/filesystemDataRoot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const dataRootPath = getFilesystemDataRootPath();

export async function GET() {
  if (!dataRootPath) {
    return NextResponse.json(
      { error: "This endpoint is disabled when DATA_DIR points inside public/." },
      { status: 404 }
    );
  }

  const jsonPath = path.join(dataRootPath, "trajectory_steering", "current.json");

  let buf: Buffer;
  try {
    buf = await readFile(jsonPath);
  } catch {
    return NextResponse.json(
      { error: "trajectory steering json missing or unreadable" },
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
