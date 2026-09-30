-- CreateTable
CREATE TABLE "HardwareAsset" (
    "deviceId" TEXT NOT NULL PRIMARY KEY,
    "manufacturer" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "serial" TEXT NOT NULL DEFAULT '',
    "chassis" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HardwareAsset_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OperatingSystem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '',
    "build" TEXT NOT NULL DEFAULT '',
    "arch" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperatingSystem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cpu" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "cores" INTEGER NOT NULL DEFAULT 0,
    "threads" INTEGER NOT NULL DEFAULT 0,
    "mhz" REAL NOT NULL DEFAULT 0,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Cpu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MemoryModule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "bank" TEXT NOT NULL DEFAULT '',
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "speedMhz" INTEGER NOT NULL DEFAULT 0,
    "manufacturer" TEXT NOT NULL DEFAULT '',
    "serial" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MemoryModule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Disk" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "serial" TEXT NOT NULL DEFAULT '',
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Disk_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Volume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "mount" TEXT NOT NULL DEFAULT '',
    "fs" TEXT NOT NULL DEFAULT '',
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "freeBytes" BIGINT NOT NULL DEFAULT 0,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Volume_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Gpu" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "driver" TEXT NOT NULL DEFAULT '',
    "memoryBytes" BIGINT NOT NULL DEFAULT 0,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Gpu_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NetworkAdapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "mac" TEXT NOT NULL DEFAULT '',
    "ips" TEXT NOT NULL DEFAULT '[]',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NetworkAdapter_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Monitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "width" INTEGER NOT NULL DEFAULT 0,
    "height" INTEGER NOT NULL DEFAULT 0,
    "primary" BOOLEAN NOT NULL DEFAULT false,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Monitor_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Printer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "driver" TEXT NOT NULL DEFAULT '',
    "port" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Printer_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UsbDevice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "vendorId" TEXT NOT NULL DEFAULT '',
    "productId" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UsbDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Software" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '',
    "publisher" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "SoftwareInstallation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "softwareId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SoftwareInstallation_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SoftwareInstallation_softwareId_fkey" FOREIGN KEY ("softwareId") REFERENCES "Software" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WindowsUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "kb" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT '',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "approval" TEXT NOT NULL DEFAULT 'pending',
    "rebootPolicy" TEXT NOT NULL DEFAULT 'never',
    "windowStart" TEXT NOT NULL DEFAULT '',
    "windowEnd" TEXT NOT NULL DEFAULT '',
    "lastError" TEXT NOT NULL DEFAULT '',
    "rebootRequired" BOOLEAN NOT NULL DEFAULT false,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WindowsUpdate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Driver_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "subject" TEXT NOT NULL DEFAULT '',
    "issuer" TEXT NOT NULL DEFAULT '',
    "thumbprint" TEXT NOT NULL DEFAULT '',
    "store" TEXT NOT NULL DEFAULT '',
    "notAfter" DATETIME,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Certificate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '',
    "startType" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Service_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProcessSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Process" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "snapshotId" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "cpu" REAL NOT NULL DEFAULT 0,
    "ram" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "Process_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "ProcessSnapshot" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "StartupItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "command" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "StartupItem_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Browser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "version" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Browser_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sid" TEXT NOT NULL DEFAULT '',
    "local" BOOLEAN NOT NULL DEFAULT true,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserProfile_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);


-- CreateIndex
CREATE INDEX "OperatingSystem_deviceId_collectedAt_idx" ON "OperatingSystem"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Cpu_deviceId_collectedAt_idx" ON "Cpu"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "MemoryModule_deviceId_collectedAt_idx" ON "MemoryModule"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Disk_deviceId_collectedAt_idx" ON "Disk"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Volume_deviceId_collectedAt_idx" ON "Volume"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Gpu_deviceId_collectedAt_idx" ON "Gpu"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "NetworkAdapter_deviceId_collectedAt_idx" ON "NetworkAdapter"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Monitor_deviceId_collectedAt_idx" ON "Monitor"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Printer_deviceId_collectedAt_idx" ON "Printer"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "UsbDevice_deviceId_collectedAt_idx" ON "UsbDevice"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Software_name_version_idx" ON "Software"("name", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Software_name_version_publisher_key" ON "Software"("name", "version", "publisher");

-- CreateIndex
CREATE INDEX "SoftwareInstallation_deviceId_collectedAt_idx" ON "SoftwareInstallation"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "SoftwareInstallation_softwareId_collectedAt_idx" ON "SoftwareInstallation"("softwareId", "collectedAt");

-- CreateIndex
CREATE INDEX "WindowsUpdate_deviceId_approval_idx" ON "WindowsUpdate"("deviceId", "approval");

-- CreateIndex
CREATE UNIQUE INDEX "WindowsUpdate_deviceId_kb_title_key" ON "WindowsUpdate"("deviceId", "kb", "title");

-- CreateIndex
CREATE INDEX "Driver_deviceId_collectedAt_idx" ON "Driver"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Certificate_deviceId_collectedAt_idx" ON "Certificate"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Service_deviceId_name_idx" ON "Service"("deviceId", "name");

-- CreateIndex
CREATE INDEX "ProcessSnapshot_deviceId_collectedAt_idx" ON "ProcessSnapshot"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Process_snapshotId_idx" ON "Process"("snapshotId");

-- CreateIndex
CREATE INDEX "StartupItem_deviceId_collectedAt_idx" ON "StartupItem"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "Browser_deviceId_collectedAt_idx" ON "Browser"("deviceId", "collectedAt");

-- CreateIndex
CREATE INDEX "UserProfile_deviceId_collectedAt_idx" ON "UserProfile"("deviceId", "collectedAt");

