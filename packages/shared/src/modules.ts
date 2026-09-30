import { z } from "zod"

export const MODULE_KINDS = ["exe", "dll-plugin"] as const
export type ModuleKind = (typeof MODULE_KINDS)[number]

export const MODULE_PLATFORMS = ["windows"] as const
export const MODULE_ARCHES = ["amd64", "arm64"] as const
export const MODULE_ARGUMENT_TYPES = ["string", "integer", "boolean"] as const

export const MODULE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/
const MODULE_SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/
const MODULE_SHA256_PATTERN = /^[0-9a-f]{64}$/

export const moduleArgumentSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
  type: z.enum(MODULE_ARGUMENT_TYPES),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(1024).default(256),
  choices: z.array(z.string().max(1024)).min(1).max(100).optional(),
})

export const moduleArgumentsSchemaSchema = z
  .array(moduleArgumentSpecSchema)
  .max(32)
  .superRefine((items, ctx) => {
    const names = new Set<string>()
    let optionalSeen = false
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!
      const key = item.name.toLowerCase()
      if (names.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "argument names must be unique",
          path: [index, "name"],
        })
      }
      names.add(key)
      if (!item.required) optionalSeen = true
      if (optionalSeen && item.required) {
        ctx.addIssue({
          code: "custom",
          message: "required arguments must precede optional arguments",
          path: [index],
        })
      }
      if (item.choices?.some((choice) => choice.length > item.maxLength)) {
        ctx.addIssue({
          code: "custom",
          message: "choice exceeds maxLength",
          path: [index, "choices"],
        })
      }
    }
  })

export type ModuleArgumentSpec = z.infer<typeof moduleArgumentSpecSchema>

export const moduleRegistrationSchema = z.object({
  id: z.string().min(3).max(64).regex(MODULE_ID_PATTERN),
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .refine((value) => !/[\r\n\0]/.test(value), "invalid characters"),
  version: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  kind: z.enum(MODULE_KINDS),
  platform: z.enum(MODULE_PLATFORMS),
  arch: z.enum(MODULE_ARCHES),
  entrypoint: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  action: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z][A-Za-z0-9._-]*$/),
  argumentsSchema: moduleArgumentsSchemaSchema.default([]),
  timeoutSec: z.number().int().min(1).max(900).default(60),
  maxOutputBytes: z.number().int().min(1024).max(1_048_576).default(65_536),
})

export const modulePatchSchema = z
  .object({
    displayName: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => !/[\r\n\0]/.test(value), "invalid characters")
      .optional(),
    action: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z][A-Za-z0-9._-]*$/)
      .optional(),
    argumentsSchema: moduleArgumentsSchemaSchema.optional(),
    timeoutSec: z.number().int().min(1).max(900).optional(),
    maxOutputBytes: z.number().int().min(1024).max(1_048_576).optional(),
    enabled: z.boolean().optional(),
  })
  .refine(
    (value) => Object.keys(value).length > 0,
    "at least one field required"
  )

export const moduleGrantsSchema = z.object({
  deviceIds: z.array(z.string().min(1).max(128)).max(10_000),
})

export const runModulePayloadSchema = z.object({
  moduleId: z.string().min(3).max(64).regex(MODULE_ID_PATTERN),
  expectedSignature: z.string().regex(MODULE_SIGNATURE_PATTERN),
  args: z.array(z.string().max(1024)).max(32).default([]),
})

export const moduleRunRequestSchema = z.object({
  deviceIds: z.array(z.string().min(1).max(128)).min(1).max(500),
  args: z.array(z.string().max(1024)).max(32).default([]),
})

export type ModuleManifestInput = {
  id: string
  displayName: string
  version: string
  kind: ModuleKind
  platform: string
  arch: string
  sha256: string
  size: number
  entrypoint: string
  action: string
  argumentsSchema: ModuleArgumentSpec[]
  timeoutSec: number
  maxOutputBytes: number
  networkAllowed: boolean
}

export function canonicalModuleManifest(input: ModuleManifestInput): string {
  if (!MODULE_SHA256_PATTERN.test(input.sha256))
    throw new Error("invalid module sha256")
  const args = moduleArgumentsSchemaSchema
    .parse(input.argumentsSchema)
    .map((arg) => ({
      name: arg.name,
      type: arg.type,
      required: arg.required,
      maxLength: arg.maxLength,
      ...(arg.choices ? { choices: arg.choices } : {}),
    }))
  return [
    "pc-manager-module-v1",
    input.id,
    input.displayName,
    input.version,
    input.kind,
    input.platform,
    input.arch,
    input.sha256,
    String(input.size),
    input.entrypoint,
    input.action,
    JSON.stringify(args),
    String(input.timeoutSec),
    String(input.maxOutputBytes),
    input.networkAllowed ? "1" : "0",
  ].join("\n")
}

export function validateModuleArguments(
  schema: readonly ModuleArgumentSpec[],
  args: readonly string[]
): { ok: true } | { ok: false; error: string } {
  const parsed = moduleArgumentsSchemaSchema.safeParse(schema)
  if (!parsed.success) return { ok: false, error: "invalid_arguments_schema" }
  if (args.length > parsed.data.length)
    return { ok: false, error: "too_many_arguments" }
  for (let index = 0; index < parsed.data.length; index += 1) {
    const spec = parsed.data[index]!
    const value = args[index]
    if (value == null) {
      if (spec.required)
        return { ok: false, error: `missing_argument:${spec.name}` }
      continue
    }
    if (value.length > spec.maxLength)
      return { ok: false, error: `argument_too_long:${spec.name}` }
    if (spec.choices && !spec.choices.includes(value)) {
      return { ok: false, error: `argument_not_allowed:${spec.name}` }
    }
    if (spec.type === "integer" && !/^-?(?:0|[1-9]\d*)$/.test(value)) {
      return { ok: false, error: `argument_not_integer:${spec.name}` }
    }
    if (spec.type === "boolean" && value !== "true" && value !== "false") {
      return { ok: false, error: `argument_not_boolean:${spec.name}` }
    }
  }
  return { ok: true }
}
