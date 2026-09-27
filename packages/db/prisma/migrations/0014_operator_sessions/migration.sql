-- CreateTable
CREATE TABLE "OperatorAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OperatorSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OperatorSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "OperatorAccount" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RemoteSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "operatorPub" TEXT,
    "agentPub" TEXT,
    "meta" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "OperatorAccount_username_key" ON "OperatorAccount"("username");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSession_tokenHash_key" ON "OperatorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OperatorSession_expiresAt_idx" ON "OperatorSession"("expiresAt");

-- CreateIndex
CREATE INDEX "RemoteSession_deviceId_kind_idx" ON "RemoteSession"("deviceId", "kind");

-- CreateIndex
CREATE INDEX "RemoteSession_expiresAt_idx" ON "RemoteSession"("expiresAt");
