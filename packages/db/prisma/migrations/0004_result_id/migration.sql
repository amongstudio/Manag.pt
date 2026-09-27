-- AlterTable
ALTER TABLE "Command" ADD COLUMN "resultId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Command_resultId_key" ON "Command"("resultId");
