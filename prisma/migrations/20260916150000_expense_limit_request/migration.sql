-- Limit oshirish so'rovi: xodim xarajat limitidan oshmoqchi bo'lganda
-- adminga so'rov yuboradi; admin tasdiqlasa limit oshadi.
CREATE TABLE "expense_limit_requests" (
  "id" CHAR(24) NOT NULL,
  "month" INTEGER NOT NULL,
  "category_id" CHAR(24) NOT NULL,
  "requested_limit" DECIMAL(14,2) NOT NULL,
  "current_limit" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "spent_at_request" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL DEFAULT '',
  "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
  "requested_by" CHAR(24) NOT NULL,
  "reviewed_by" CHAR(24),
  "reviewed_at" TIMESTAMP(3),
  "rejection_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "expense_limit_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "expense_limit_requests_status_created_at_idx" ON "expense_limit_requests"("status","created_at" DESC);
CREATE INDEX "expense_limit_requests_month_category_id_idx" ON "expense_limit_requests"("month","category_id");
CREATE INDEX "expense_limit_requests_requested_by_idx" ON "expense_limit_requests"("requested_by");
ALTER TABLE "expense_limit_requests" ADD CONSTRAINT "expense_limit_requests_category_id_fkey"
  FOREIGN KEY ("category_id") REFERENCES "expense_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
