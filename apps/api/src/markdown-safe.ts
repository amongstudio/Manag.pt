const DOCS = [
  { group: "users", title: "Users", files: ["getting-started", "dashboard", "agent-install", "scripts", "monitoring", "inventory", "security-scans", "remote", "credentials", "public-access"] },
  { group: "developers", title: "Developers", files: ["architecture", "data-model", "agent", "testing"] },
  { group: "operators", title: "Operators", files: ["runbook"] },
] as const

export function docIndex() {
  return DOCS.map((group) => ({
    id: group.group,
    title: group.title,
    docs: group.files.map((file) => ({
      slug: `${group.group}/${file}`,
      title: file.replaceAll("-", " "),
    })),
  }))
}

export function safeDocSlug(slug: string): string | null {
  const cleaned = slug.replace(/^\/+|\/+$/g, "")
  if (!/^[a-z0-9/-]+$/.test(cleaned) || cleaned.includes("..")) return null
  const known = DOCS.flatMap((group) => group.files.map((file) => `${group.group}/${file}`))
  if (cleaned === "README" || known.includes(cleaned)) return cleaned
  return null
}

export function renderSafeMarkdown(source: string): string {
  const escaped = source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  const lines = escaped.split("\n")
  const out: string[] = []
  let inCode = false
  let list: string[] = []
  const flushList = () => {
    if (!list.length) return
    out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`)
    list = []
  }
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushList()
      if (!inCode) {
        out.push("<pre><code>")
        inCode = true
      } else {
        out.push("</code></pre>")
        inCode = false
      }
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      list.push(line.slice(2))
      continue
    }
    flushList()
    if (line.startsWith("### ")) out.push(`<h3>${inline(line.slice(4))}</h3>`)
    else if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`)
    else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`)
    else if (line.trim() === "") out.push("")
    else if (line.startsWith("|")) out.push(`<p>${inline(line)}</p>`)
    else out.push(`<p>${inline(line)}</p>`)
  }
  flushList()
  if (inCode) out.push("</code></pre>")
  return out.join("\n")
}

function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
      if (!/^(https?:\/\/|\/|\.\/|#)/.test(href) || href.toLowerCase().startsWith("javascript:")) {
        return label
      }
      if (/["'<>\s]/.test(href)) return label
      return `<a href="${href}">${label}</a>`
    })
}
