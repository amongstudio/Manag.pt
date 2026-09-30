-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "commandId" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Scan_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Finding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT,
    "deviceId" TEXT,
    "hostIp" TEXT NOT NULL DEFAULT '',
    "hostHostname" TEXT NOT NULL DEFAULT '',
    "hostOs" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "cveId" TEXT NOT NULL DEFAULT '',
    "cvssScore" REAL,
    "evidence" TEXT NOT NULL DEFAULT '',
    "remediation" TEXT NOT NULL DEFAULT '',
    "remediationType" TEXT NOT NULL DEFAULT 'manual',
    "scriptId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "acceptReason" TEXT NOT NULL DEFAULT '',
    "firstSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Finding_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Finding_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Finding_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CveCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "product" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Scan_createdAt_idx" ON "Scan"("createdAt");

-- CreateIndex
CREATE INDEX "Scan_deviceId_createdAt_idx" ON "Scan"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "Scan_status_idx" ON "Scan"("status");

-- CreateIndex
CREATE INDEX "Finding_deviceId_idx" ON "Finding"("deviceId");

-- CreateIndex
CREATE INDEX "Finding_severity_idx" ON "Finding"("severity");

-- CreateIndex
CREATE INDEX "Finding_cveId_idx" ON "Finding"("cveId");

-- CreateIndex
CREATE INDEX "Finding_status_idx" ON "Finding"("status");

-- CreateIndex
CREATE INDEX "Finding_scanId_idx" ON "Finding"("scanId");

-- CreateIndex
CREATE UNIQUE INDEX "Finding_hostIp_source_category_title_cveId_key" ON "Finding"("hostIp", "source", "category", "title", "cveId");

-- CreateIndex
CREATE UNIQUE INDEX "CveCache_product_version_key" ON "CveCache"("product", "version");

