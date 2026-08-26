-- TASHQI KIRIMLAR — o'quvchi to'lovi bo'lmagan pul (ijara, sotuv, homiylik)
--
-- Bu KIRIM. Chiqim (xarajat, ish haqi) hali yo'q — keyingi bosqich.
--
-- Kirim kassaga tushadi, ya'ni daftarga (`account_entries`) yoziladi va
-- `payment_accounts.balance` ni oshiradi. Bekor qilinganda qator
-- O'CHIRILMAYDI — teskari (kompensatsiya) qatori qo'shiladi.

-- 1. Daftar turlari
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'external_income';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'external_income_void';

-- 2. Kategoriyalar katalogi
CREATE TABLE "income_categories" (
    "id"          CHAR(24) NOT NULL,
    "name"        TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "created_by"  CHAR(24) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "income_categories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "income_categories_name_key" ON "income_categories"("name");
CREATE INDEX "income_categories_is_archived_is_active_sort_order_idx"
    ON "income_categories"("is_archived", "is_active", "sort_order");

-- 3. Kirim hujjati
CREATE TABLE "external_incomes" (
    "id"            CHAR(24) NOT NULL,
    "category_id"   CHAR(24) NOT NULL,
    "account_id"    CHAR(24) NOT NULL,
    "amount"        DECIMAL(14,2) NOT NULL,
    "category_name" TEXT NOT NULL DEFAULT '',
    "payer"         TEXT NOT NULL DEFAULT '',
    "note"          TEXT NOT NULL DEFAULT '',
    "occurred_at"   TIMESTAMP(3) NOT NULL,
    "is_voided"     BOOLEAN NOT NULL DEFAULT false,
    "voided_at"     TIMESTAMP(3),
    "voided_by"     CHAR(24),
    "void_reason"   TEXT NOT NULL DEFAULT '',
    "created_by"    CHAR(24) NOT NULL,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_incomes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "external_incomes_occurred_at_idx" ON "external_incomes"("occurred_at" DESC);
CREATE INDEX "external_incomes_category_id_occurred_at_idx" ON "external_incomes"("category_id", "occurred_at" DESC);
CREATE INDEX "external_incomes_account_id_occurred_at_idx" ON "external_incomes"("account_id", "occurred_at" DESC);

-- Katalog HECH QACHON o'chirilmaydi — arxivlanadi, shuning uchun Restrict
ALTER TABLE "external_incomes" ADD CONSTRAINT "external_incomes_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "income_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "external_incomes" ADD CONSTRAINT "external_incomes_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Daftar yozuvi hujjatga ishora qiladi
ALTER TABLE "account_entries" ADD COLUMN "external_income_id" CHAR(24);
CREATE INDEX "account_entries_external_income_id_idx" ON "account_entries"("external_income_id");
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_external_income_id_fkey"
    FOREIGN KEY ("external_income_id") REFERENCES "external_incomes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
