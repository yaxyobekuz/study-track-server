-- DropIndex
DROP INDEX "changelogs_date_panel_key";

-- AlterTable
ALTER TABLE "changelogs" ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "changelogs_date_panel_seq_key" ON "changelogs"("date", "panel", "seq");

