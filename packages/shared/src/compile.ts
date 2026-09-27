import { z } from "zod"

import { APP_VERSION } from "./constants.ts"
import { STAMP_ARCHES, STAMP_PLATFORMS } from "./schemas.ts"

export const COMPILE_JOB_STATUSES = ["queued", "running", "success", "failed"] as const

export const compileRequestSchema = z.object({
  platform: z.enum(STAMP_PLATFORMS),
  arch: z.enum(STAMP_ARCHES),
  version: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._+-]+$/, "invalid version")
    .optional()
    .default(APP_VERSION),
  lite: z.boolean().optional().default(false),
})

export const compileJobViewSchema = z.object({
  id: z.string().min(1),
  status: z.enum(COMPILE_JOB_STATUSES),
  log: z.string(),
  error: z.string().nullable(),
  updateId: z.string().nullable(),
})

export type CompileRequest = z.infer<typeof compileRequestSchema>
export type CompileJobView = z.infer<typeof compileJobViewSchema>
