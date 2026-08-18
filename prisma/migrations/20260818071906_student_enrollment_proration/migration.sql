/*
  O'QISH DAVRLARI VA KIRISH PRORATSIYASI.

  `prorated_amount` majburiy, lekin ma'lumot YO'QOTILMAYDI: ustun avval
  nullable qo'shiladi, mavjud qatorlarga `base_amount` ko'chiriladi, so'ng
  NOT NULL qilinadi. Proratsiyagacha chiqarilgan har bir hisob-fakturada
  proratsiya bo'lmagan, ya'ni `prorated_amount = base_amount` — bu tarixni
  o'zgartirmaydi, faqat yangi invariantni

      amount = prorated_amount − discount_amount

  butun jadval bo'ylab (tarix bilan birga) bajariladigan qiladi. Aynan shu
  sababli financeReconcile job uni har kecha tekshira oladi.

  `billable_days` / `month_days` / `rounding_unit` tarixiy qatorlarda NULL
  qoladi — NULL "proratsiya yo'q" degani.
*/
-- CreateEnum
CREATE TYPE "StudentEnrollmentEndReason" AS ENUM ('left', 'expelled', 'graduated', 'transferred');

-- AlterTable
ALTER TABLE "finance_settings" ADD COLUMN     "proration_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "rounding_unit" INTEGER NOT NULL DEFAULT 1000;

-- AlterTable
ALTER TABLE "monthly_invoices" ADD COLUMN     "billable_days" INTEGER,
ADD COLUMN     "month_days" INTEGER,
ADD COLUMN     "rounding_unit" INTEGER,
ADD COLUMN     "prorated_amount" DECIMAL(14,2);

-- Backfill: proratsiyagacha chiqarilgan qatorlarda proratsiya bo'lmagan
UPDATE "monthly_invoices" SET "prorated_amount" = "base_amount" WHERE "prorated_amount" IS NULL;

ALTER TABLE "monthly_invoices" ALTER COLUMN "prorated_amount" SET NOT NULL;

-- CreateTable
CREATE TABLE "student_enrollments" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "end_reason" "StudentEnrollmentEndReason",
    "reason" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_enrollments_student_id_start_date_idx" ON "student_enrollments"("student_id", "start_date" DESC);

-- CreateIndex
CREATE INDEX "student_enrollments_start_date_end_date_idx" ON "student_enrollments"("start_date", "end_date");

-- CreateIndex
CREATE UNIQUE INDEX "student_enrollments_student_id_start_date_key" ON "student_enrollments"("student_id", "start_date");
