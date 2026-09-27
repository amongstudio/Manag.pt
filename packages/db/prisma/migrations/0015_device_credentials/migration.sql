-- CreateTable
CREATE TABLE "DeviceCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
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

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCredential_deviceId_credKey_key" ON "DeviceCredential"("deviceId", "credKey");

-- CreateIndex
CREATE INDEX "DeviceCredential_deviceId_source_idx" ON "DeviceCredential"("deviceId", "source");
