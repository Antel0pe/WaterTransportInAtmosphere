import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_DATASET = "era5_2021-nov_250-500-925_uv_pv_gph.nc";
const DEFAULT_PYTHON =
  "/home/dmmsp/anaconda3/envs/water-transport-in-atmosphere/bin/python";

type Params = { pressure: string; datehour: string };

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

function toIsoSecondUtc(dt: Date): string {
  const y = dt.getUTCFullYear();
  const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  const h = String(dt.getUTCHours()).padStart(2, "0");
  const mi = String(dt.getUTCMinutes()).padStart(2, "0");
  const s = String(dt.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function parsePressureLevel(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error("Invalid pressure");
  const p = Number(raw);
  if (!Number.isInteger(p)) throw new Error("Invalid pressure");
  if (p !== 250 && p !== 500 && p !== 925) throw new Error("Unsupported pressure");
  return p;
}

function parseFiniteOptional(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("Invalid numeric query parameter");
  return n;
}

function parseBoolOptional(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  const value = raw.trim().toLowerCase();
  if (value === "1" || value === "true" || value === "yes") return true;
  if (value === "0" || value === "false" || value === "no") return false;
  throw new Error("Invalid boolean query parameter");
}

function parseDatasetBasename(raw: string | null): string {
  const fallback = DEFAULT_DATASET;
  if (!raw) return fallback;
  if (!/^[A-Za-z0-9._-]+$/.test(raw)) {
    throw new Error("Invalid source filename");
  }
  return raw;
}

async function runPythonPng(
  pythonBin: string,
  scriptPath: string,
  args: string[]
): Promise<{ stdout: Buffer; stderr: string; code: number | null }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, [scriptPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    let stderrText = "";

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr: stderrText.trim(),
        code,
      });
    });
  });
}

function summarizePythonError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return "No stderr output from Python renderer.";

  const explicit = lines.find((line) => line.startsWith("wind_uv_dynamic_png error:"));
  if (explicit) return explicit.replace(/^wind_uv_dynamic_png error:\s*/, "");

  return lines[lines.length - 1];
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<Params> }
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

  let hourly: Date;
  try {
    hourly = snapToHour(parseDatehour(datehour));
  } catch {
    return NextResponse.json({ error: "Invalid datehour format" }, { status: 400 });
  }

  const url = new URL(req.url);

  let sourceName: string;
  let uvMin: number | null;
  let uvMax: number | null;
  let lonHalfRoll: boolean;

  try {
    sourceName = parseDatasetBasename(url.searchParams.get("source"));
    uvMin = parseFiniteOptional(
      url.searchParams.get("min") ?? url.searchParams.get("uvMin")
    );
    uvMax = parseFiniteOptional(
      url.searchParams.get("max") ?? url.searchParams.get("uvMax")
    );
    lonHalfRoll = parseBoolOptional(url.searchParams.get("roll"), true);

    if (uvMin !== null && uvMax !== null && uvMax <= uvMin) {
      return NextResponse.json({ error: "max must be greater than min" }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid query parameters" },
      { status: 400 }
    );
  }

  const pythonBin = process.env.WIND_DYNAMIC_PYTHON ?? DEFAULT_PYTHON;
  const scriptPath = path.join(process.cwd(), "scripts", "wind_uv_dynamic_png.py");
  const dataPath = path.join(process.cwd(), "data", sourceName);

  try {
    await access(scriptPath);
    await access(dataPath);
  } catch {
    return NextResponse.json(
      { error: "Server is missing script or source dataset path." },
      { status: 500 }
    );
  }

  const pyArgs = [
    "--in-path",
    dataPath,
    "--datehour",
    toIsoSecondUtc(hourly),
    "--pressure-level",
    String(pressure),
    lonHalfRoll ? "--lon-half-roll" : "--no-lon-half-roll",
  ];

  if (uvMin !== null) {
    pyArgs.push("--uv-min", String(uvMin));
  }
  if (uvMax !== null) {
    pyArgs.push("--uv-max", String(uvMax));
  }

  let result: { stdout: Buffer; stderr: string; code: number | null };
  try {
    result = await runPythonPng(pythonBin, scriptPath, pyArgs);
  } catch (err) {
    return NextResponse.json(
      {
        error: "Failed to spawn Python wind renderer.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  if (result.code !== 0) {
    const details = summarizePythonError(result.stderr);
    const status =
      details.includes("Requested time") && details.includes("not found") ? 404 : 500;

    return NextResponse.json(
      {
        error: "Dynamic wind rendering failed.",
        details,
      },
      { status }
    );
  }

  return new NextResponse(new Uint8Array(result.stdout), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Wind-UV-Source": "dynamic-netcdf",
      "X-Wind-UV-Datehour": toIsoSecondUtc(hourly),
      "X-Wind-UV-Pressure": String(pressure),
      ...(uvMin !== null ? { "X-Wind-UV-Min": String(uvMin) } : {}),
      ...(uvMax !== null ? { "X-Wind-UV-Max": String(uvMax) } : {}),
    },
  });
}
