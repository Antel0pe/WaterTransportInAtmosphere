import type { NextConfig } from "next";

const configuredDataDir = process.env.DATA_DIR?.trim() || "public";
const normalizedDataDir = configuredDataDir
  .replace(/\\/g, "/")
  .replace(/^\.\/+/, "")
  .replace(/\/+$/, "");

const publicDataBasePath =
  normalizedDataDir === "public"
    ? ""
    : normalizedDataDir.startsWith("public/")
      ? `/${normalizedDataDir.slice("public/".length)}`
      : "";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_DATA_SOURCE_KIND:
      normalizedDataDir === "public" || normalizedDataDir.startsWith("public/")
        ? "public"
        : "api",
    NEXT_PUBLIC_DATA_BASE_PATH: publicDataBasePath,
  },
  outputFileTracingExcludes: {
    "/api/*": ["public/**/*", "data/**/*"],
    "/api/**/*": ["public/**/*", "data/**/*"],
  },
};

export default nextConfig;
