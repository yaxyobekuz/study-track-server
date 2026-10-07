-- FILIALLARARO KO'CHIRISH JURNALI VA ASOSIY OYLIK EGASI.
--
-- `branch_transfers` / `branch_transfer_items` — kim, qachon, qayerdan,
-- qayerga, nega va nima ko'chdi. Append-only jurnal.
--
-- `payroll_month_owners` — (xodim, oy) uchun ASOSIY oylik qaysi filialda
-- hisoblanadi. Yagona kalit ikkinchi filial o'sha oyni egallashiga yo'l
-- qo'ymaydi: bitta odamga bir oyda ikki marta asosiy oylik strukturaviy
-- imkonsiz. Qator bo'lmasa — egasi xodimning uy filiali.
--
-- Mavjud jadvallarga tegilmaydi.

-- CreateEnum
CREATE TYPE "BranchTransferKind" AS ENUM ('student', 'staff', 'class');

-- CreateEnum
CREATE TYPE "BranchTransferMode" AS ENUM ('move', 'share');

-- CreateEnum
CREATE TYPE "BranchTransferStatus" AS ENUM ('completed', 'attention');

-- CreateTable
CREATE TABLE "branch_transfers" (
    "id" CHAR(24) NOT NULL,
    "kind" "BranchTransferKind" NOT NULL,
    "mode" "BranchTransferMode" NOT NULL,
    "source_branch_id" CHAR(24) NOT NULL,
    "target_branch_id" CHAR(24) NOT NULL,
    "effective_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "options" JSONB NOT NULL DEFAULT '{}',
    "item_count" INTEGER NOT NULL,
    "status" "BranchTransferStatus" NOT NULL DEFAULT 'completed',
    "created_by" CHAR(24) NOT NULL,
    "created_by_name" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_transfer_items" (
    "id" CHAR(24) NOT NULL,
    "transfer_id" CHAR(24) NOT NULL,
    "subject_type" VARCHAR(16) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "label" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT '',
    "details" JSONB NOT NULL DEFAULT '{}',
    "warnings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_transfer_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_month_owners" (
    "user_id" CHAR(24) NOT NULL,
    "month" INTEGER NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_month_owners_pkey" PRIMARY KEY ("user_id","month")
);

-- CreateIndex
CREATE INDEX "branch_transfers_source_branch_id_created_at_idx" ON "branch_transfers"("source_branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "branch_transfers_target_branch_id_created_at_idx" ON "branch_transfers"("target_branch_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "branch_transfers_created_at_idx" ON "branch_transfers"("created_at" DESC);

-- CreateIndex
CREATE INDEX "branch_transfer_items_transfer_id_idx" ON "branch_transfer_items"("transfer_id");

-- CreateIndex
CREATE INDEX "branch_transfer_items_subject_id_created_at_idx" ON "branch_transfer_items"("subject_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "payroll_month_owners_branch_id_month_idx" ON "payroll_month_owners"("branch_id", "month");

-- AddForeignKey
ALTER TABLE "branch_transfers" ADD CONSTRAINT "branch_transfers_source_branch_id_fkey" FOREIGN KEY ("source_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfers" ADD CONSTRAINT "branch_transfers_target_branch_id_fkey" FOREIGN KEY ("target_branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_transfer_items" ADD CONSTRAINT "branch_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "branch_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "login_attempts_branch_created_idx" RENAME TO "login_attempts_branch_id_created_at_idx";

-- RenameIndex
ALTER INDEX "login_attempts_ip_created_idx" RENAME TO "login_attempts_ip_created_at_idx";

-- RenameIndex
ALTER INDEX "login_attempts_user_id_created_idx" RENAME TO "login_attempts_user_id_created_at_idx";

-- RenameIndex
ALTER INDEX "login_attempts_username_created_idx" RENAME TO "login_attempts_username_created_at_idx";

-- RenameIndex
ALTER INDEX "security_alerts_branch_status_seen_idx" RENAME TO "security_alerts_branch_id_status_last_seen_at_idx";

-- RenameIndex
ALTER INDEX "security_alerts_status_severity_seen_idx" RENAME TO "security_alerts_status_severity_last_seen_at_idx";

-- RenameIndex
ALTER INDEX "security_alerts_user_id_last_seen_idx" RENAME TO "security_alerts_user_id_last_seen_at_idx";

-- RenameIndex
ALTER INDEX "user_sessions_branch_reason_seen_idx" RENAME TO "user_sessions_branch_id_end_reason_last_seen_at_idx";

-- RenameIndex
ALTER INDEX "user_sessions_end_reason_expires_idx" RENAME TO "user_sessions_end_reason_expires_at_idx";

