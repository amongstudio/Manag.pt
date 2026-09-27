import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { env } from "./env.js"

export function applyPendingMigrations(): void {
  const dbPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db")
  const url = `file:${env.dbFile.replaceAll("\\", "/")}`
  // Invoke Prisma directly. `pnpm exec` deadlocks under `pnpm dev` because the
  // parent already holds the pnpm store lock. CI + piped stdio avoid Prisma's
  // interactive spinner hanging when turbo/tsx is the parent.
  const prismaJs = path.join(dbPkg, "node_modules/prisma/build/index.js")
  try {
    const out = execFileSync(process.execPath, [prismaJs, "migrate", "deploy"], {
      cwd: dbPkg,
      env: {
        ...process.env,
        DATABASE_URL: url,
        CI: "1",
        PRISMA_HIDE_UPDATE_MESSAGE: "1",
        NO_COLOR: "1",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    })
    if (out) process.stdout.write(out)
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string }
    if (err.stdout) process.stdout.write(err.stdout)
    if (err.stderr) process.stderr.write(err.stderr)
    if (env.nodeEnv === "production") throw error
    console.error("prisma migrate deploy failed; continuing in development")
  }
}
