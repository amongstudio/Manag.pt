import { spawn } from "node:child_process"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const nextBin = require.resolve("next/dist/bin/next")
const useWebpack = process.platform === "win32"
const args = useWebpack ? ["dev", "--webpack"] : ["dev"]
const child = spawn(process.execPath, [nextBin, ...args], {
  stdio: "inherit",
  env: process.env,
})
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
