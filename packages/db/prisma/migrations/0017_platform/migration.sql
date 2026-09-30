-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parameters" TEXT NOT NULL DEFAULT '[]',
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 60,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ScriptRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "scriptId" TEXT,
    "language" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "exitCode" INTEGER,
    "stdout" TEXT NOT NULL DEFAULT '',
    "stderr" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "trigger" TEXT NOT NULL,
    "commandId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScriptRun_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScriptRun_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScriptSchedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scriptId" TEXT NOT NULL,
    "deviceId" TEXT,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScriptSchedule_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ScriptSchedule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "deviceId" TEXT,
    "detail" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "labels" TEXT NOT NULL DEFAULT '{}',
    "value" REAL NOT NULL,
    "sampledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetricSample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AlertState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ruleId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "pendingSince" DATETIME,
    "lastFiredAt" DATETIME
);

-- CreateIndex
CREATE INDEX "Script_name_idx" ON "Script"("name");

-- CreateIndex
CREATE INDEX "ScriptRun_deviceId_createdAt_idx" ON "ScriptRun"("deviceId", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptRun_scriptId_createdAt_idx" ON "ScriptRun"("scriptId", "createdAt");

-- CreateIndex
CREATE INDEX "ScriptRun_commandId_idx" ON "ScriptRun"("commandId");

-- CreateIndex
CREATE INDEX "ScriptSchedule_enabled_scriptId_idx" ON "ScriptSchedule"("enabled", "scriptId");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "AuditLog_deviceId_at_idx" ON "AuditLog"("deviceId", "at");

-- CreateIndex
CREATE INDEX "AuditLog_action_at_idx" ON "AuditLog"("action", "at");

-- CreateIndex
CREATE INDEX "MetricSample_deviceId_name_sampledAt_idx" ON "MetricSample"("deviceId", "name", "sampledAt");

-- CreateIndex
CREATE INDEX "MetricSample_sampledAt_idx" ON "MetricSample"("sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "AlertState_ruleId_deviceId_key" ON "AlertState"("ruleId", "deviceId");

