-- CreateTable
CREATE TABLE "ModuleArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "signer" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "entrypoint" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "argumentsSchema" TEXT NOT NULL DEFAULT '[]',
    "timeoutSec" INTEGER NOT NULL DEFAULT 60,
    "maxOutputBytes" INTEGER NOT NULL DEFAULT 65536,
    "networkAllowed" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "allDevices" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModuleDeviceGrant" (
    "moduleId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    PRIMARY KEY ("moduleId", "deviceId"),
    CONSTRAINT "ModuleDeviceGrant_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "ModuleArtifact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModuleDeviceGrant_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ModuleArtifact_enabled_revokedAt_platform_arch_idx" ON "ModuleArtifact"("enabled", "revokedAt", "platform", "arch");

-- CreateIndex
CREATE INDEX "ModuleArtifact_createdAt_idx" ON "ModuleArtifact"("createdAt");

-- CreateIndex
CREATE INDEX "ModuleDeviceGrant_deviceId_idx" ON "ModuleDeviceGrant"("deviceId");
