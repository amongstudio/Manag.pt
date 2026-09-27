-- AlterTable
ALTER TABLE "Plugin" ADD COLUMN "allDevices" BOOLEAN NOT NULL DEFAULT false;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'agent',
    "version" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "notes" TEXT,
    "checksum" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_AgentUpdate" ("id", "kind", "version", "platform", "arch", "notes", "checksum", "path", "size", "createdAt")
SELECT
    "id",
    CASE
        WHEN instr(lower("path"), 'helper') > 0 OR instr(lower(coalesce("notes", '')), 'helper') > 0 THEN 'helper'
        ELSE 'agent'
    END,
    "version",
    "platform",
    "arch",
    "notes",
    "checksum",
    "path",
    "size",
    "createdAt"
FROM "AgentUpdate";
DROP TABLE "AgentUpdate";
ALTER TABLE "new_AgentUpdate" RENAME TO "AgentUpdate";
CREATE UNIQUE INDEX "AgentUpdate_kind_version_platform_arch_key" ON "AgentUpdate"("kind", "version", "platform", "arch");
CREATE INDEX "AgentUpdate_kind_platform_arch_createdAt_idx" ON "AgentUpdate"("kind", "platform", "arch", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
