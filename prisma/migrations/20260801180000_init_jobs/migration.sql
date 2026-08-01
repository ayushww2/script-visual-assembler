-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'completed', 'failed');

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "phase" TEXT NOT NULL DEFAULT 'google-first',
    "script" TEXT NOT NULL,
    "beatCount" INTEGER NOT NULL DEFAULT 0,
    "googleCount" INTEGER NOT NULL DEFAULT 0,
    "aiCount" INTEGER NOT NULL DEFAULT 0,
    "model" TEXT,
    "error" TEXT,
    "progress" TEXT,
    "beatsJson" JSONB,
    "resultJson" JSONB,
    "previewsJson" JSONB,
    "usageJson" JSONB,
    "previewDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Job_createdAt_idx" ON "Job"("createdAt");
