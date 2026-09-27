-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hostname" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "agentVersion" TEXT NOT NULL,
    "ip" TEXT,
    "mac" TEXT,
    "enrollmentKeyHash" TEXT NOT NULL,
    "apiKeyHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'offline',
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "labels" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Stat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpu" REAL NOT NULL,
    "ram" REAL NOT NULL,
    "disk" REAL NOT NULL,
    "gpu" REAL,
    "temp" REAL,
    "netUp" REAL,
    "netDown" REAL,
    "processes" TEXT NOT NULL,
    "extras" TEXT,
    CONSTRAINT "Stat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "source" TEXT,
    "message" TEXT NOT NULL,
    CONSTRAINT "Log_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Command" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Command_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Screenshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FileInfo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "localPath" TEXT NOT NULL,
    "remotePath" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileInfo_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT,
    "channel" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" DATETIME,
    CONSTRAINT "Notification_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "version" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "notes" TEXT,
    "checksum" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ip" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "adminId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "window" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");
CREATE UNIQUE INDEX "AgentUpdate_version_platform_arch_key" ON "AgentUpdate"("version", "platform", "arch");
CREATE UNIQUE INDEX "RateLimit_key_window_key" ON "RateLimit"("key", "window");
CREATE INDEX "Device_status_lastSeen_idx" ON "Device"("status", "lastSeen");
CREATE INDEX "Stat_deviceId_timestamp_idx" ON "Stat"("deviceId", "timestamp");
CREATE INDEX "Log_deviceId_timestamp_idx" ON "Log"("deviceId", "timestamp");
CREATE INDEX "Command_deviceId_status_idx" ON "Command"("deviceId", "status");
CREATE INDEX "Screenshot_deviceId_createdAt_idx" ON "Screenshot"("deviceId", "createdAt");
CREATE INDEX "FileInfo_deviceId_createdAt_idx" ON "FileInfo"("deviceId", "createdAt");
CREATE INDEX "Notification_status_createdAt_idx" ON "Notification"("status", "createdAt");
CREATE INDEX "Notification_deviceId_type_createdAt_idx" ON "Notification"("deviceId", "type", "createdAt");
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
