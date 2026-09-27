-- AlterTable
ALTER TABLE "Device" ADD COLUMN "e2ePub" TEXT;

-- AlterTable
ALTER TABLE "FileInfo" ADD COLUMN "offset" INTEGER NOT NULL DEFAULT 0;
