-- CreateTable
CREATE TABLE "Plugin" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "runtime" TEXT NOT NULL,
    "platform" TEXT,
    "arch" TEXT,
    "sha256" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "timeoutSec" INTEGER NOT NULL DEFAULT 60,
    "networkAllowed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PluginDeviceGrant" (
    "pluginId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,

    PRIMARY KEY ("pluginId", "deviceId"),
    CONSTRAINT "PluginDeviceGrant_pluginId_fkey" FOREIGN KEY ("pluginId") REFERENCES "Plugin" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentBuild" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "platform" TEXT NOT NULL,
    "arch" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "path" TEXT NOT NULL,
    "notes" TEXT
);
