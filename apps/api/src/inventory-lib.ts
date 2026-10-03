const OEM_SERIAL = /^(to be filled by o\.?e\.?m\.?|default string|none|not specified|system serial number|0+|n\/a|unknown)$/i

export function cleanSerial(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text || OEM_SERIAL.test(text)) return ""
  return text.slice(0, 128)
}

export function cleanText(value: unknown, max = 256): string {
  if (typeof value !== "string") return ""
  return value.replace(/\u0000/g, "").trim().slice(0, max)
}

export function redactConfig(value: string): string {
  return value.replace(/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

function list(value: unknown, cap: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object").slice(0, cap)
}

export type InventoryReport = {
  hardware: { manufacturer: string; model: string; serial: string; chassis: string; biosVendor: string; biosVersion: string }
  os: {
    name: string
    version: string
    build: string
    arch: string
    hostname: string
    fqdn: string
    kernel: string
    bootTime: string
    timezone: string
    domain: string
    gateway: string
    dnsServers: string
    agentVersion: string
    helperVersion: string
    roles: string
    primaryIps: string
    uptimeSec: number
  }
  cpus: Array<{ name: string; cores: number; threads: number; mhz: number }>
  memory: Array<{ bank: string; sizeBytes: number; speedMhz: number; manufacturer: string; serial: string }>
  disks: Array<{ name: string; model: string; serial: string; sizeBytes: number }>
  volumes: Array<{ mount: string; fs: string; sizeBytes: number; freeBytes: number }>
  gpus: Array<{ name: string; driver: string; memoryBytes: number }>
  adapters: Array<{ name: string; mac: string; ips: string[] }>
  monitors: Array<{ name: string; width: number; height: number; primary: boolean }>
  printers: Array<{ name: string; driver: string; port: string }>
  usb: Array<{ name: string; vendorId: string; productId: string }>
  software: Array<{ name: string; version: string; publisher: string; source: string; installDate: string; installPath: string }>
  drivers: Array<{ name: string; version: string; provider: string }>
  certificates: Array<{ subject: string; issuer: string; thumbprint: string; store: string; notAfter: string }>
  services: Array<{ name: string; displayName: string; state: string; startType: string; account: string; binaryPath: string; listenPorts: string; configNote: string }>
  processes: Array<{ pid: number; name: string; userName: string; cpu: number; ram: number; rssBytes: number }>
  startup: Array<{ name: string; command: string; location: string }>
  browsers: Array<{ name: string; version: string; path: string }>
  users: Array<{ name: string; sid: string; local: boolean; disabled: boolean }>
  updates: Array<{ kb: string; title: string; severity: string; sizeBytes: number }>
}

export function normalizeInventory(raw: unknown): InventoryReport | null {
  if (!raw || typeof raw !== "object") return null
  const body = raw as Record<string, unknown>
  const hardware = (body.hardware ?? {}) as Record<string, unknown>
  const os = (body.os ?? {}) as Record<string, unknown>
  return {
    hardware: {
      manufacturer: cleanText(hardware.manufacturer),
      model: cleanText(hardware.model),
      serial: cleanSerial(hardware.serial),
      chassis: cleanText(hardware.chassis),
      biosVendor: cleanText(hardware.biosVendor),
      biosVersion: cleanText(hardware.biosVersion),
    },
    os: {
      name: cleanText(os.name),
      version: cleanText(os.version, 128),
      build: cleanText(os.build, 128),
      arch: cleanText(os.arch, 32),
      hostname: cleanText(os.hostname, 256),
      fqdn: cleanText(os.fqdn, 256),
      kernel: cleanText(os.kernel, 128),
      bootTime: cleanText(os.bootTime, 40),
      timezone: cleanText(os.timezone, 64),
      domain: cleanText(os.domain, 256),
      gateway: cleanText(os.gateway, 64),
      dnsServers: cleanText(os.dnsServers, 256),
      agentVersion: cleanText(os.agentVersion, 64),
      helperVersion: cleanText(os.helperVersion, 64),
      roles: cleanText(os.roles, 256),
      primaryIps: cleanText(os.primaryIps, 512),
      uptimeSec: num(os.uptimeSec),
    },
    cpus: list(body.cpus, 32).map((row) => ({
      name: cleanText(row.name),
      cores: num(row.cores),
      threads: num(row.threads),
      mhz: num(row.mhz),
    })),
    memory: list(body.memory, 64).map((row) => ({
      bank: cleanText(row.bank, 64),
      sizeBytes: num(row.sizeBytes),
      speedMhz: num(row.speedMhz),
      manufacturer: cleanText(row.manufacturer),
      serial: cleanSerial(row.serial),
    })),
    disks: list(body.disks, 64).map((row) => ({
      name: cleanText(row.name),
      model: cleanText(row.model),
      serial: cleanSerial(row.serial),
      sizeBytes: num(row.sizeBytes),
    })),
    volumes: list(body.volumes, 64).map((row) => ({
      mount: cleanText(row.mount),
      fs: cleanText(row.fs, 64),
      sizeBytes: num(row.sizeBytes),
      freeBytes: num(row.freeBytes),
    })),
    gpus: list(body.gpus, 16).map((row) => ({
      name: cleanText(row.name),
      driver: cleanText(row.driver),
      memoryBytes: num(row.memoryBytes),
    })),
    adapters: list(body.adapters, 32).map((row) => ({
      name: cleanText(row.name),
      mac: cleanText(row.mac, 32),
      ips: Array.isArray(row.ips) ? row.ips.filter((ip): ip is string => typeof ip === "string").slice(0, 16) : [],
    })),
    monitors: list(body.monitors, 8).map((row) => ({
      name: cleanText(row.name, 64),
      width: num(row.width),
      height: num(row.height),
      primary: row.primary === true,
    })),
    printers: list(body.printers, 50).map((row) => ({
      name: cleanText(row.name),
      driver: cleanText(row.driver),
      port: cleanText(row.port, 128),
    })),
    usb: list(body.usb, 100).map((row) => ({
      name: cleanText(row.name),
      vendorId: cleanText(row.vendorId, 8),
      productId: cleanText(row.productId, 8),
    })),
    software: list(body.software, 400)
      .map((row) => ({
        name: cleanText(row.name),
        version: cleanText(row.version, 128),
        publisher: cleanText(row.publisher),
        source: cleanText(row.source, 32),
        installDate: cleanText(row.installDate, 32),
        installPath: cleanText(redactConfig(cleanText(row.installPath, 1024)), 1024),
      }))
      .filter((row) => row.name),
    drivers: list(body.drivers, 100).map((row) => ({
      name: cleanText(row.name),
      version: cleanText(row.version, 128),
      provider: cleanText(row.provider),
    })),
    certificates: list(body.certificates, 100).map((row) => ({
      subject: cleanText(row.subject, 512),
      issuer: cleanText(row.issuer, 512),
      thumbprint: cleanText(row.thumbprint, 128),
      store: cleanText(row.store, 64),
      notAfter: cleanText(row.notAfter, 40),
    })),
    services: list(body.services, 300)
      .map((row) => ({
        name: cleanText(row.name, 256),
        displayName: cleanText(row.displayName),
        state: cleanText(row.state, 32),
        startType: cleanText(row.startType, 32),
        account: cleanText(row.account, 128),
        binaryPath: cleanText(redactConfig(cleanText(row.binaryPath, 1024)), 1024),
        listenPorts: cleanText(row.listenPorts, 128),
        configNote: cleanText(redactConfig(cleanText(row.configNote, 512)), 512),
      }))
      .filter((row) => row.name),
    processes: list(body.processes, 120)
      .map((row) => ({
        pid: num(row.pid),
        name: cleanText(row.name, 256),
        userName: cleanText(row.user ?? row.userName, 128),
        cpu: num(row.cpu),
        ram: num(row.ram),
        rssBytes: num(row.rssBytes),
      }))
      .filter((row) => row.pid > 0),
    startup: list(body.startup, 100).map((row) => ({
      name: cleanText(row.name),
      command: cleanText(row.command, 1024),
      location: cleanText(row.location),
    })),
    browsers: list(body.browsers, 20).map((row) => ({
      name: cleanText(row.name, 64),
      version: cleanText(row.version, 64),
      path: cleanText(row.path, 1024),
    })),
    users: list(body.users, 200)
      .map((row) => ({
        name: cleanText(row.name, 128),
        sid: cleanText(row.sid, 128),
        local: row.local !== false,
        disabled: row.disabled === true,
      }))
      .filter((row) => row.name),
    updates: list(body.updates, 200)
      .map((row) => ({
        kb: cleanText(row.kb, 32).toUpperCase(),
        title: cleanText(row.title, 512),
        severity: cleanText(row.severity, 32),
        sizeBytes: num(row.sizeBytes),
      }))
      .filter((row) => row.kb || row.title),
  }
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`)
}

export function softwareFleetArgs(name: string, version: string, limit: number): { name: string; like: string; version: string; limit: number } {
  const trimmed = name.trim().slice(0, 128)
  return {
    name: trimmed,
    like: `%${escapeLike(trimmed)}%`,
    version: version.trim().slice(0, 128),
    limit: Math.min(Math.max(limit, 1), 500),
  }
}
