-- AlterTable
ALTER TABLE "HardwareAsset" ADD COLUMN "biosVendor" TEXT NOT NULL DEFAULT '';
ALTER TABLE "HardwareAsset" ADD COLUMN "biosVersion" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "OperatingSystem" ADD COLUMN "hostname" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "fqdn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "kernel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "bootTime" DATETIME;
ALTER TABLE "OperatingSystem" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "domain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "gateway" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "dnsServers" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "agentVersion" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "helperVersion" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "roles" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "primaryIps" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OperatingSystem" ADD COLUMN "uptimeSec" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SoftwareInstallation" ADD COLUMN "installDate" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SoftwareInstallation" ADD COLUMN "installPath" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Service" ADD COLUMN "account" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Service" ADD COLUMN "binaryPath" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Service" ADD COLUMN "listenPorts" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Service" ADD COLUMN "configNote" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Process" ADD COLUMN "userName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Process" ADD COLUMN "rssBytes" BIGINT NOT NULL DEFAULT 0;

-- RedefineTable
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DeviceCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'device',
    "credKey" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'generic',
    "target" TEXT NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "persist" TEXT,
    "comment" TEXT,
    "browser" TEXT,
    "profile" TEXT,
    "lastWritten" TEXT,
    "secretEnc" TEXT NOT NULL DEFAULT '',
    "backedUpAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DeviceCredential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DeviceCredential" ("id", "deviceId", "scope", "credKey", "source", "kind", "target", "username", "persist", "comment", "browser", "profile", "lastWritten", "secretEnc", "backedUpAt", "updatedAt")
SELECT "id", "deviceId", 'device', "credKey", "source", "kind", "target", "username", "persist", "comment", "browser", "profile", "lastWritten", "secretEnc", "backedUpAt", "updatedAt" FROM "DeviceCredential";
DROP TABLE "DeviceCredential";
ALTER TABLE "new_DeviceCredential" RENAME TO "DeviceCredential";
CREATE UNIQUE INDEX "DeviceCredential_deviceId_credKey_key" ON "DeviceCredential"("deviceId", "credKey");
CREATE INDEX "DeviceCredential_deviceId_source_idx" ON "DeviceCredential"("deviceId", "source");
CREATE INDEX "DeviceCredential_scope_idx" ON "DeviceCredential"("scope");
PRAGMA foreign_keys=ON;
