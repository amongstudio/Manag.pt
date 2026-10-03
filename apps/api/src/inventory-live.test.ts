import "./env.ts"

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { test } from "node:test"

import { prisma } from "@workspace/db"

import { redactConfig } from "./inventory-lib.ts"
import { deviceInventory, upsertInventory } from "./inventory-store.ts"

const DEVICE = "11111111-1111-4111-8111-111111111111"

test("config text redacts passwords before storage", () => {
  const text = redactConfig("listen 0.0.0.0 password=hunter2 token=abc")
  assert.equal(text.includes("hunter2"), false)
  assert.equal(text.includes("abc"), false)
  assert.match(text, /password=\[redacted\]/)
})

test("a real Linux sample is stored and returned without invented serials", async () => {
  await prisma.device.upsert({
    where: { id: DEVICE },
    create: {
      id: DEVICE,
      hostname: "inventory-live",
      platform: "linux",
      arch: "amd64",
      agentVersion: "test",
      enrollmentKeyHash: "inventory-live",
    },
    update: {},
  })
  const hostname = execFileSync("uname", ["-n"], { encoding: "utf8" }).trim()
  const release = fs.readFileSync("/etc/os-release", "utf8")
  const pretty = release.match(/PRETTY_NAME="([^"]+)"/)?.[1] ?? "linux"
  const dpkg = execFileSync("dpkg-query", ["-W", "-f", "${Package}\t${Version}\t${Maintainer}\n"], { encoding: "utf8" })
  const [name, version, publisher] = dpkg.split("\n")[0]?.split("\t") ?? []
  assert.ok(name)
  const saved = await upsertInventory(DEVICE, {
    hardware: { manufacturer: "", model: "", serial: "To be filled by O.E.M.", chassis: "", biosVendor: "", biosVersion: "" },
    os: {
      name: pretty,
      version: "",
      build: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
      arch: execFileSync("uname", ["-m"], { encoding: "utf8" }).trim(),
      hostname,
      fqdn: hostname,
      kernel: execFileSync("uname", ["-r"], { encoding: "utf8" }).trim(),
      timezone: "UTC",
      domain: "",
      gateway: "",
      dnsServers: "",
      agentVersion: "test",
      helperVersion: "",
      roles: "",
      primaryIps: "",
      uptimeSec: 1,
    },
    software: [{ name, version: version ?? "", publisher: publisher ?? "", source: "dpkg", installDate: "", installPath: "" }],
    services: [
      {
        name: "ssh",
        displayName: "ssh",
        state: "active",
        startType: "enabled",
        account: "",
        binaryPath: "/usr/sbin/sshd password=nope",
        listenPorts: "22",
        configNote: "",
      },
    ],
    cpus: [{ name: "local", cores: 1, threads: 1, mhz: 1 }],
  })
  assert.equal(saved, true)
  const rows = await deviceInventory(DEVICE)
  assert.equal(rows.os?.hostname, hostname)
  assert.equal(rows.hardware?.serial, "")
  assert.equal(rows.software.some((row) => row.name === name && row.source === "dpkg"), true)
  const ssh = rows.services.find((row) => row.name === "ssh")
  assert.ok(ssh)
  assert.equal(ssh.binaryPath.includes("nope"), false)
  assert.equal(JSON.stringify(rows).includes("nope"), false)
})
