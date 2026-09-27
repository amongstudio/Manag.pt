import fs from "node:fs"
import path from "node:path"

import type { NextConfig } from "next"

/** Fill process.env from KEY=VALUE files without clobbering existing vars. Next only auto-loads apps/web/.env. */
function loadEnvFile(file: string): void {
  let text: string
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadEnvFile(path.resolve(__dirname, "../../.env"))
loadEnvFile(path.resolve(__dirname, ".env"))

const repoRoot = path.resolve(__dirname, "../..")
const api = process.env.API_INTERNAL_URL ?? "http://localhost:4000"

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  turbopack: {
    root: repoRoot,
  },
  transpilePackages: ["@workspace/ui", "@workspace/shared"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/ws", destination: `${api}/ws` },
      { source: "/ws/:path*", destination: `${api}/ws/:path*` },
    ]
  },
}

export default nextConfig
