import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"

import {
  APP_AUTHOR,
  APP_DESCRIPTION,
  APP_NAME,
  APP_SITE,
} from "@workspace/shared"
import "@workspace/ui/globals.css"
import { Providers } from "@/components/providers"
import { cn } from "@workspace/ui/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })

export const metadata: Metadata = {
  title: APP_NAME,
  description: APP_DESCRIPTION,
  authors: [{ name: APP_AUTHOR, url: APP_SITE }],
  metadataBase: new URL(APP_SITE),
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn("antialiased", fontMono.variable, "font-sans", geist.variable)}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
