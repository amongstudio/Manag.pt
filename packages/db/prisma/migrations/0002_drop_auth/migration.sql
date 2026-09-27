-- DropTable
DROP TABLE IF EXISTS "AuditLog";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "AdminUser";
DROP TABLE IF EXISTS "RateLimit";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "ip" TEXT,
    "mac" TEXT,
    "enrollmentKeyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "labels" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Device" ("agentVersion", "arch", "createdAt", "enrollmentKeyHash", "hostname", "id", "ip", "labels", "lastSeen", "mac", "platform", "status", "updatedAt") SELECT "agentVersion", "arch", "createdAt", "enrollmentKeyHash", "hostname", "id", "ip", "labels", "lastSeen", "mac", "platform", "status", "updatedAt" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
CREATE INDEX "Device_status_lastSeen_idx" ON "Device"("status", "lastSeen");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
