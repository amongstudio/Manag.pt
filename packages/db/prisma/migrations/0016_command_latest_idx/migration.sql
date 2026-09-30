-- Device detail looks up the newest successful command per type.
CREATE INDEX "Command_deviceId_type_status_createdAt_idx" ON "Command"("deviceId", "type", "status", "createdAt");
