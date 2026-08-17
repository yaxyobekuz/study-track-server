-- CreateEnum
CREATE TYPE "ChangelogPanel" AS ENUM ('admin', 'teacher', 'student', 'server', 'bot');

-- CreateEnum
CREATE TYPE "ChangelogBump" AS ENUM ('major', 'minor', 'patch');

-- CreateTable
CREATE TABLE "changelogs" (
    "id" CHAR(24) NOT NULL,
    "panel" "ChangelogPanel" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "version" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "patch" INTEGER NOT NULL,
    "bump" "ChangelogBump" NOT NULL DEFAULT 'patch',
    "title" TEXT NOT NULL DEFAULT '',
    "items" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT NOT NULL DEFAULT '',
    "source_file" TEXT,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "changelogs_panel_major_minor_patch_idx" ON "changelogs"("panel", "major" DESC, "minor" DESC, "patch" DESC);

-- CreateIndex
CREATE INDEX "changelogs_date_idx" ON "changelogs"("date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "changelogs_date_panel_key" ON "changelogs"("date", "panel");

-- CreateIndex
CREATE UNIQUE INDEX "changelogs_panel_version_key" ON "changelogs"("panel", "version");
