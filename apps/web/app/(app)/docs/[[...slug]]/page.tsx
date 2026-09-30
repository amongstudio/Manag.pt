import { DocsPage } from "@/components/docs-page"
import { serverApi } from "@/lib/server-api"

type Group = { id: string; title: string; docs: Array<{ slug: string; title: string }> }

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await params
  const path = slug?.join("/") || ""
  const [index, body] = await Promise.all([
    serverApi<{ groups: Group[] }>("/api/v1/admin/docs"),
    path ? serverApi<{ html: string }>(`/api/v1/admin/docs/body?path=${encodeURIComponent(path)}`) : Promise.resolve(null),
  ])
  return <DocsPage path={path} initialGroups={index?.groups ?? []} initialHtml={body?.html ?? ""} />
}
