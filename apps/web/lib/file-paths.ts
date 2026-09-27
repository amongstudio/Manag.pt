/** Path crumbs and joins for the operator file explorer (Windows and POSIX). */

export function pathCrumbs(p: string): Array<{ label: string; path: string }> {
  if (!p) return []
  const unc = p.startsWith("\\\\") || p.startsWith("//")
  const unix = !unc && p.startsWith("/")
  const parts = p.split(/[/\\]/).filter(Boolean)
  const crumbs: Array<{ label: string; path: string }> = []
  if (unc) {
    if (parts.length < 2) return [{ label: p, path: p }]
    let acc = `\\\\${parts[0]}\\${parts[1]}`
    crumbs.push({ label: acc, path: acc })
    for (let i = 2; i < parts.length; i++) {
      acc = `${acc}\\${parts[i]}`
      crumbs.push({ label: parts[i]!, path: acc })
    }
    return crumbs
  }
  let acc = ""
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!
    acc = unix ? `${acc}/${part}` : i === 0 ? part : `${acc}\\${part}`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  if (/[/\\]$/.test(base)) return base + name
  const unc = base.startsWith("\\\\") || base.startsWith("//")
  const sep = unc || (base.includes("\\") && !base.startsWith("/")) ? "\\" : "/"
  return `${base}${sep}${name}`
}

export function parentPath(p: string): string {
  const crumbs = pathCrumbs(p)
  if (crumbs.length < 2) return ""
  return crumbs[crumbs.length - 2]!.path
}

export function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) || p
}
