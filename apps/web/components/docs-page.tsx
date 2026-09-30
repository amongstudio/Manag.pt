"use client"

import Link from "next/link"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

type Group = { id: string; title: string; docs: Array<{ slug: string; title: string }> }

export function DocsPage({
  path,
  initialGroups,
  initialHtml,
}: {
  path: string
  initialGroups: Group[]
  initialHtml: string
}) {
  const index = useQuery({
    queryKey: ["docs-index"],
    queryFn: () => api<{ groups: Group[] }>("/api/v1/admin/docs"),
    initialData: { groups: initialGroups },
  })
  const body = useQuery({
    queryKey: ["docs-body", path],
    queryFn: () => api<{ title: string; html: string }>(`/api/v1/admin/docs/body?path=${encodeURIComponent(path)}`),
    enabled: path.length > 0,
    initialData: path ? { title: path, html: initialHtml } : undefined,
  })
  return (
    <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <nav className="flex flex-col gap-4 text-sm">
        {(index.data?.groups ?? []).map((group) => (
          <div key={group.id}>
            <p className="mb-1 font-medium">{group.title}</p>
            <ul className="flex flex-col gap-1">
              {group.docs.map((doc) => (
                <li key={doc.slug}>
                  <Link href={`/docs/${doc.slug}`} className={path === doc.slug ? "underline" : "text-muted-foreground"}>
                    {doc.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <article className="prose-sm max-w-3xl">
        {path === "" ? (
          <div>
            <h1 className="text-xl font-medium">Documentation</h1>
            <p className="mt-2 text-sm text-muted-foreground">Guides shipped with this repository. They are not loaded from the internet.</p>
          </div>
        ) : (
          <div className="text-sm leading-6" dangerouslySetInnerHTML={{ __html: body.data?.html ?? "" }} />
        )}
      </article>
    </div>
  )
}
