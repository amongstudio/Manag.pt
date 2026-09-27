-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "leasedAt" DATETIME;

-- CreateIndex
CREATE INDEX "Device_lastSeen_idx" ON "Device"("lastSeen");

-- CreateIndex
CREATE INDEX "Stat_timestamp_idx" ON "Stat"("timestamp");

-- CreateIndex
CREATE INDEX "Log_timestamp_idx" ON "Log"("timestamp");

-- CreateIndex
CREATE INDEX "Command_status_updatedAt_idx" ON "Command"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "Command_deviceId_createdAt_idx" ON "Command"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "Command_createdAt_idx" ON "Command"("createdAt");

-- CreateIndex
CREATE INDEX "Screenshot_createdAt_idx" ON "Screenshot"("createdAt");

-- CreateIndex
CREATE INDEX "AgentUpdate_platform_arch_createdAt_idx" ON "AgentUpdate"("platform", "arch", "createdAt");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PluginDeviceGrant" (
    "pluginId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    PRIMARY KEY ("pluginId", "deviceId"),
    CONSTRAINT "PluginDeviceGrant_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PluginDeviceGrant_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_PluginDeviceGrant" ("pluginId", "deviceId")
SELECT "pluginId", "deviceId" FROM "PluginDeviceGrant"
WHERE "deviceId" IN (SELECT "id" FROM "Device");
DROP TABLE "PluginDeviceGrant";
ALTER TABLE "new_PluginDeviceGrant" RENAME TO "PluginDeviceGrant";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
