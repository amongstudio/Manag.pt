import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto"

import {
  canonicalModuleManifest,
  moduleArgumentsSchemaSchema,
  type ModuleManifestInput,
} from "@workspace/shared"

import { env } from "./env.js"

const ED25519_PKCS8_PREFIX = Buffer.from(
  "302e020100300506032b657004220420",
  "hex"
)

type SigningMaterial = {
  privateKey: KeyObject
  publicKey: KeyObject
  publicKeyRaw: Buffer
  signer: string
}

let cached: SigningMaterial | null = null

function signingMaterial(): SigningMaterial {
  if (cached) return cached
  const seed = createHash("sha256")
    .update("pc-manager-module-signing-v1\0")
    .update(env.updateSigningSecret)
    .digest()
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  })
  const publicKey = createPublicKey(privateKey)
  const der = publicKey.export({ format: "der", type: "spki" })
  const publicKeyRaw = Buffer.from(der).subarray(-32)
  const signer = `ed25519:${createHash("sha256").update(publicKeyRaw).digest("hex")}`
  cached = { privateKey, publicKey, publicKeyRaw, signer }
  return cached
}

export function moduleSigner(): { signer: string; publicKey: string } {
  const material = signingMaterial()
  return {
    signer: material.signer,
    publicKey: material.publicKeyRaw.toString("base64"),
  }
}

export function signModuleManifest(input: ModuleManifestInput): {
  signer: string
  signature: string
} {
  const material = signingMaterial()
  const message = canonicalModuleManifest(input)
  return {
    signer: material.signer,
    signature: sign(
      null,
      Buffer.from(message, "utf8"),
      material.privateKey
    ).toString("base64"),
  }
}

export function moduleManifestFromRow(row: {
  id: string
  displayName: string
  version: string
  kind: string
  platform: string
  arch: string
  sha256: string
  size: number
  entrypoint: string
  action: string
  argumentsSchema: string
  timeoutSec: number
  maxOutputBytes: number
  networkAllowed: boolean
}): ModuleManifestInput {
  const argumentsSchema = moduleArgumentsSchemaSchema.parse(
    JSON.parse(row.argumentsSchema) as unknown
  )
  if (row.kind !== "exe" && row.kind !== "dll-plugin")
    throw new Error("invalid module kind")
  return {
    id: row.id,
    displayName: row.displayName,
    version: row.version,
    kind: row.kind,
    platform: row.platform,
    arch: row.arch,
    sha256: row.sha256,
    size: row.size,
    entrypoint: row.entrypoint,
    action: row.action,
    argumentsSchema,
    timeoutSec: row.timeoutSec,
    maxOutputBytes: row.maxOutputBytes,
    networkAllowed: row.networkAllowed,
  }
}

export function verifyStoredModule(
  row: Parameters<typeof moduleManifestFromRow>[0] & {
    signer: string
    signature: string
  }
): boolean {
  try {
    const material = signingMaterial()
    if (row.signer !== material.signer) return false
    const message = canonicalModuleManifest(moduleManifestFromRow(row))
    return verify(
      null,
      Buffer.from(message, "utf8"),
      material.publicKey,
      Buffer.from(row.signature, "base64")
    )
  } catch {
    return false
  }
}
