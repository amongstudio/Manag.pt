import { PrismaClient } from "@prisma/client"

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  })

await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;")
await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;")

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}

export * from "@prisma/client"
