-- KUNNI YOPISH — "Men ketdim" faqat bugungi ishlar tugagach.
--
-- ⚠️ Mavjud qatorlar o'zgarmaydi: 1 ta yangi jadval, 1 ta yangi enum va
-- 4 ta yangi ustun (ikkitasi sozlamada, ikkitasi davomat qatorida).
-- Eski davomat qatorlarida `checkout_report` va `checkout_request_id`
-- NULL qoladi — ular darvozadan oldin yozilgan.
--
-- ⚠️ Sozlamalar sukutda YOQILGAN: deploydan keyin o'qituvchi darslariga baho
-- qo'ymay yoki muddati kelgan topshiriqni topshirmay "Men ketdim" ni bosa
-- olmaydi. O'chirish: Davomat → Sozlamalar → "Kunni yopish".

-- CreateEnum
CREATE TYPE "CheckoutRequestStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- AlterTable
ALTER TABLE "attendance_settings"
    ADD COLUMN "checkout_require_grades" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "checkout_require_tasks" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "attendances"
    ADD COLUMN "checkout_report" JSONB,
    ADD COLUMN "checkout_request_id" CHAR(24);

-- CreateTable
CREATE TABLE "checkout_requests" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "CheckoutRequestStatus" NOT NULL DEFAULT 'pending',
    "pending_items" JSONB NOT NULL DEFAULT '{}',
    "reviewed_by" CHAR(24),
    "reviewed_at" TIMESTAMP(3),
    "review_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "checkout_requests_user_id_date_idx" ON "checkout_requests"("user_id", "date");

-- CreateIndex
CREATE INDEX "checkout_requests_status_created_at_idx" ON "checkout_requests"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "checkout_requests_date_status_idx" ON "checkout_requests"("date", "status");
