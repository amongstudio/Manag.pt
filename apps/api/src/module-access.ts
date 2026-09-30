import {
  prisma,
  type ModuleArtifact,
  type ModuleDeviceGrant,
} from "@workspace/db"
import {
  moduleArgumentsSchemaSchema,
  validateModuleArguments,
} from "@workspace/shared"

import { verifyStoredModule } from "./module-signing.js"

export type ModuleWithGrants = ModuleArtifact & { grants: ModuleDeviceGrant[] }
export type ModuleSkip = { deviceId: string; reason: string }

export function deviceHasModuleGrant(
  module: Pick<ModuleArtifact, "allDevices"> & {
    grants: Array<{ deviceId: string }>
  },
  deviceId: string
): boolean {
  return (
    module.allDevices ||
    module.grants.some((grant) => grant.deviceId === deviceId)
  )
}

export async function moduleGrantedToDevice(
  moduleId: string,
  deviceId: string
): Promise<boolean> {
  const count = await prisma.moduleArtifact.count({
    where: {
      id: moduleId,
      enabled: true,
      revokedAt: null,
      OR: [{ allDevices: true }, { grants: { some: { deviceId } } }],
    },
  })
  return count > 0
}

export async function filterModuleTargets(input: {
  moduleId: string
  expectedSignature?: string
  args: string[]
  deviceIds: string[]
}): Promise<
  | {
      ok: true
      module: ModuleWithGrants
      deviceIds: string[]
      skipped: ModuleSkip[]
    }
  | { ok: false; status: number; error: string; details?: unknown }
> {
  const module = await prisma.moduleArtifact.findUnique({
    where: { id: input.moduleId },
    include: { grants: true },
  })
  if (!module) return { ok: false, status: 404, error: "module_not_found" }
  if (module.revokedAt)
    return { ok: false, status: 410, error: "module_revoked" }
  if (!module.enabled)
    return { ok: false, status: 409, error: "module_disabled" }
  if (!verifyStoredModule(module))
    return { ok: false, status: 409, error: "module_signature_invalid" }
  if (input.expectedSignature && input.expectedSignature !== module.signature) {
    return { ok: false, status: 409, error: "module_version_changed" }
  }
  if (module.kind !== "exe") {
    return { ok: false, status: 409, error: "dll_plugin_host_pending" }
  }
  let argumentSchema
  try {
    argumentSchema = moduleArgumentsSchemaSchema.parse(
      JSON.parse(module.argumentsSchema) as unknown
    )
  } catch {
    return { ok: false, status: 409, error: "module_arguments_schema_invalid" }
  }
  const args = validateModuleArguments(argumentSchema, input.args)
  if (!args.ok)
    return {
      ok: false,
      status: 400,
      error: "invalid_module_arguments",
      details: args.error,
    }

  const unique = [...new Set(input.deviceIds)]
  const devices = await prisma.device.findMany({
    where: { id: { in: unique } },
    select: { id: true, platform: true, arch: true },
  })
  const byId = new Map(devices.map((device) => [device.id, device]))
  const accepted: string[] = []
  const skipped: ModuleSkip[] = []
  for (const deviceId of unique) {
    if (!deviceHasModuleGrant(module, deviceId)) {
      skipped.push({ deviceId, reason: "grant_denied" })
      continue
    }
    const device = byId.get(deviceId)
    if (!device) {
      skipped.push({ deviceId, reason: "not_found" })
      continue
    }
    if (module.platform !== device.platform) {
      skipped.push({ deviceId, reason: "platform_mismatch" })
      continue
    }
    if (module.arch !== device.arch) {
      skipped.push({ deviceId, reason: "arch_mismatch" })
      continue
    }
    accepted.push(deviceId)
  }
  return { ok: true, module, deviceIds: accepted, skipped }
}
