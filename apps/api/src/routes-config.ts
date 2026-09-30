import fs from "node:fs"
import path from "node:path"

import type { FastifyInstance } from "fastify"
import { API_PREFIX, appSettingsPatchSchema } from "@workspace/shared"

import { appendAudit } from "./audit.js"
import { errorBody } from "./lib.js"
import { docIndex, renderSafeMarkdown, safeDocSlug } from "./markdown-safe.js"
import { operatorAuthorized } from "./operator-auth.js"
import { installCommandLine, readOperatorConfig, saveOperatorSection } from "./operator-config.js"
import { env } from "./env.js"
import { patchSettings } from "./settings.js"

function docsRoot(): string {
  for (const candidate of [path.resolve(process.cwd(), "docs"), path.resolve(process.cwd(), "../../docs")]) {
    if (fs.existsSync(candidate)) return candidate
  }
  return path.resolve(process.cwd(), "../../docs")
}

export async function registerConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(`${API_PREFIX}/admin/config`, async () => readOperatorConfig())

  app.get(`${API_PREFIX}/admin/config/install-command`, async () => ({
    command: installCommandLine(env.publicUrl),
    serverUrl: env.publicUrl,
    secretIncluded: false,
  }))

  app.put(`${API_PREFIX}/admin/config/:section`, async (req, reply) => {
    const { section } = req.params as { section: string }
    const authed = await operatorAuthorized(req.headers as Record<string, unknown>)
    const actor = authed.username || "operator"
    if (section === "agent") {
      const parsed = appSettingsPatchSchema.safeParse(req.body)
      if (!parsed.success || !parsed.data.agent) return reply.code(400).send(errorBody("invalid_body", parsed.success ? "agent required" : parsed.error.flatten()))
      await patchSettings({ agent: parsed.data.agent })
      await appendAudit({ actor, action: "config_save", detail: { section: "agent", keys: Object.keys(parsed.data.agent) } })
      return { ok: true }
    }
    const saved = await saveOperatorSection(app, section, req.body, actor)
    if (!saved.ok) return reply.code(400).send(errorBody(saved.error))
    return { ok: true }
  })

  app.get(`${API_PREFIX}/admin/docs`, async () => ({ groups: docIndex() }))

  app.get(`${API_PREFIX}/admin/docs/body`, async (req, reply) => {
    const slug = safeDocSlug(String((req.query as { path?: string }).path ?? ""))
    if (!slug) return reply.code(404).send(errorBody("not_found"))
    const file = slug === "README" ? path.join(docsRoot(), "README.md") : path.join(docsRoot(), `${slug}.md`)
    const root = docsRoot()
    const resolved = path.resolve(file)
    if (!resolved.startsWith(root + path.sep) && resolved !== path.join(root, "README.md")) {
      return reply.code(404).send(errorBody("not_found"))
    }
    let text = ""
    try {
      text = fs.readFileSync(resolved, "utf8")
    } catch {
      return reply.code(404).send(errorBody("not_found"))
    }
    const title = text.split("\n").find((line) => line.startsWith("# "))?.slice(2).trim() || slug
    return { slug, title, html: renderSafeMarkdown(text) }
  })
}
