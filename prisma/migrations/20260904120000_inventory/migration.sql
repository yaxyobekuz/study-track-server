-- INVENTAR — MODDIY-TEXNIK BAZA
--
-- Uch bosqich, moliya moduli bilan aynan bir xil doktrinada:
--   1) XATLOV      inventory_locations × inventory_items → inventory_stocks
--   2) MONITORING  inventory_checks + inventory_check_lines (kunlik hisobot)
--   3) UNDIRUV     inventory_damages → damage_charges → damage_payments
--
-- Ko'zgu jadvali (kirim tomoni → inventar tomoni):
--   AccountEntry      → InventoryMovement  (append-only miqdor daftari)
--   MonthlyInvoice    → DamageCharge       (majburiyat, MUHRLANGAN)
--   Payment           → DamagePayment      (to'lov, LEKIN depozitsiz)
--   PaymentAllocation → DamageAllocation
--
-- ⚠️ LOCK TARTIBI: DamageCharge (occurred_at asc, id asc) → PaymentAccount.
-- Kassa uchala yo'lda ham OXIRGI — deadlock shu sababli bo'lmaydi.

-- ─────────────────────────────────────────────
-- 1. Daftar turlari — zarar undiruvi kassaga TUSHADI (musbat)
-- ─────────────────────────────────────────────
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'damage_payment';
ALTER TYPE "AccountEntryType" ADD VALUE IF NOT EXISTS 'damage_payment_void';

-- ─────────────────────────────────────────────
-- 2. Yangi enumlar
-- ─────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "InventoryLocationType" AS ENUM
        ('classroom', 'canteen', 'gym', 'library', 'lab', 'office', 'corridor', 'dorm', 'warehouse', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "InventoryMovementType" AS ENUM
        ('initial', 'purchase', 'damage', 'repair', 'write_off', 'transfer_in', 'transfer_out', 'adjustment', 'damage_revert');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "InventoryCheckStatus" AS ENUM ('draft', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "InventoryDamageKind" AS ENUM ('broken', 'missing');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "InventoryDamageStatus" AS ENUM ('pending', 'charged', 'waived', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "DamageChargeStatus" AS ENUM ('unpaid', 'partial', 'paid', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─────────────────────────────────────────────
-- 3. Katalog — jihoz toifasi
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_categories" (
    "id"          CHAR(24) NOT NULL,
    "name"        TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "created_by"  CHAR(24) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_categories_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_categories_name_key" ON "inventory_categories"("name");
CREATE INDEX "inventory_categories_is_archived_is_active_sort_order_idx"
    ON "inventory_categories"("is_archived", "is_active", "sort_order");

-- ─────────────────────────────────────────────
-- 4. Katalog — jihoz nomi va standart narxi
--
-- Narx VERSIYALANMAYDI (tarifdan farqli): zarar hodisa paytidagi narxda
-- MUHRLANADI, ya'ni katalogdagi qiymat faqat "hozirgi standart".
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_items" (
    "id"          CHAR(24) NOT NULL,
    "category_id" CHAR(24) NOT NULL,
    "name"        TEXT NOT NULL,
    "unit"        TEXT NOT NULL DEFAULT 'dona',
    "unit_price"  DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description" TEXT NOT NULL DEFAULT '',
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "sort_order"  INTEGER NOT NULL DEFAULT 0,
    "created_by"  CHAR(24) NOT NULL,
    "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"  TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_items_name_key" ON "inventory_items"("name");
CREATE INDEX "inventory_items_category_id_is_archived_sort_order_idx"
    ON "inventory_items"("category_id", "is_archived", "sort_order");
CREATE INDEX "inventory_items_is_archived_name_idx" ON "inventory_items"("is_archived", "name");
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_category_id_fkey"
    FOREIGN KEY ("category_id") REFERENCES "inventory_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 5. Xona (lokatsiya)
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_locations" (
    "id"             CHAR(24) NOT NULL,
    "name"           TEXT NOT NULL,
    "type"           "InventoryLocationType" NOT NULL DEFAULT 'classroom',
    "class_id"       CHAR(24),
    "responsible_id" CHAR(24),
    "note"           TEXT NOT NULL DEFAULT '',
    "is_archived"    BOOLEAN NOT NULL DEFAULT false,
    "sort_order"     INTEGER NOT NULL DEFAULT 0,
    "created_by"     CHAR(24) NOT NULL,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_locations_name_key" ON "inventory_locations"("name");
CREATE INDEX "inventory_locations_is_archived_type_sort_order_idx"
    ON "inventory_locations"("is_archived", "type", "sort_order");
CREATE INDEX "inventory_locations_responsible_id_idx" ON "inventory_locations"("responsible_id");
CREATE INDEX "inventory_locations_class_id_idx" ON "inventory_locations"("class_id");

-- ─────────────────────────────────────────────
-- 6. XATLOV — xona × jihoz → miqdor
--
-- quantity / broken_quantity HOSILA: ular inventory_movements yig'indisi.
-- Har kecha financeReconcile job tasdiqlaydi (PaymentAccount.balance naqshi).
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_stocks" (
    "id"              CHAR(24) NOT NULL,
    "location_id"     CHAR(24) NOT NULL,
    "item_id"         CHAR(24) NOT NULL,
    "quantity"        INTEGER NOT NULL DEFAULT 0,
    "broken_quantity" INTEGER NOT NULL DEFAULT 0,
    "note"            TEXT NOT NULL DEFAULT '',
    "created_by"      CHAR(24) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_stocks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_stocks_location_id_item_id_key"
    ON "inventory_stocks"("location_id", "item_id");
CREATE INDEX "inventory_stocks_item_id_idx" ON "inventory_stocks"("item_id");
CREATE INDEX "inventory_stocks_location_id_broken_quantity_idx"
    ON "inventory_stocks"("location_id", "broken_quantity");
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_stocks" ADD CONSTRAINT "inventory_stocks_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 7. Kunlik hisobot (sarlavha)
--
-- (location_id, date) UNIQUE — idempotentlik: bir kunda ikkita hisobot
-- bo'lsa "bugun nechta sindi" ikki xil javob berardi.
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_checks" (
    "id"                CHAR(24) NOT NULL,
    "location_id"       CHAR(24) NOT NULL,
    "date"              DATE NOT NULL,
    "status"            "InventoryCheckStatus" NOT NULL DEFAULT 'draft',
    "reported_by"       CHAR(24) NOT NULL,
    "note"              TEXT NOT NULL DEFAULT '',
    "submitted_at"      TIMESTAMP(3),
    "lines_count"       INTEGER NOT NULL DEFAULT 0,
    "broken_count"      INTEGER NOT NULL DEFAULT 0,
    "missing_count"     INTEGER NOT NULL DEFAULT 0,
    "repaired_count"    INTEGER NOT NULL DEFAULT 0,
    "damage_amount"     DECIMAL(14,2) NOT NULL DEFAULT 0,
    "location_snapshot" JSONB NOT NULL,
    "created_by"        CHAR(24) NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_checks_location_id_date_key" ON "inventory_checks"("location_id", "date");
CREATE INDEX "inventory_checks_date_status_idx" ON "inventory_checks"("date" DESC, "status");
CREATE INDEX "inventory_checks_location_id_date_idx" ON "inventory_checks"("location_id", "date" DESC);
CREATE INDEX "inventory_checks_reported_by_date_idx" ON "inventory_checks"("reported_by", "date" DESC);
ALTER TABLE "inventory_checks" ADD CONSTRAINT "inventory_checks_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 8. Kunlik hisobot satri
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_check_lines" (
    "id"                CHAR(24) NOT NULL,
    "check_id"          CHAR(24) NOT NULL,
    "stock_id"          CHAR(24) NOT NULL,
    "item_id"           CHAR(24) NOT NULL,
    "item_name"         TEXT NOT NULL,
    "unit"              TEXT NOT NULL DEFAULT 'dona',
    "expected_quantity" INTEGER NOT NULL,
    "expected_broken"   INTEGER NOT NULL DEFAULT 0,
    "broken_quantity"   INTEGER NOT NULL DEFAULT 0,
    "missing_quantity"  INTEGER NOT NULL DEFAULT 0,
    "repaired_quantity" INTEGER NOT NULL DEFAULT 0,
    "note"              TEXT NOT NULL DEFAULT '',
    "attachments"       JSONB NOT NULL DEFAULT '[]',
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_check_lines_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "inventory_check_lines_check_id_item_id_key"
    ON "inventory_check_lines"("check_id", "item_id");
CREATE INDEX "inventory_check_lines_stock_id_idx" ON "inventory_check_lines"("stock_id");
ALTER TABLE "inventory_check_lines" ADD CONSTRAINT "inventory_check_lines_check_id_fkey"
    FOREIGN KEY ("check_id") REFERENCES "inventory_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_check_lines" ADD CONSTRAINT "inventory_check_lines_stock_id_fkey"
    FOREIGN KEY ("stock_id") REFERENCES "inventory_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 9. ZARAR HODISASI — MUHRLANGAN FAKT
--
--   amount = quantity × unit_price     ← o'zgartiradigan endpoint YO'Q
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_damages" (
    "id"                CHAR(24) NOT NULL,
    "location_id"       CHAR(24) NOT NULL,
    "item_id"           CHAR(24) NOT NULL,
    "stock_id"          CHAR(24) NOT NULL,
    "check_id"          CHAR(24),
    "kind"              "InventoryDamageKind" NOT NULL DEFAULT 'broken',
    "status"            "InventoryDamageStatus" NOT NULL DEFAULT 'pending',
    "quantity"          INTEGER NOT NULL,
    "unit_price"        DECIMAL(14,2) NOT NULL,
    "amount"            DECIMAL(14,2) NOT NULL,
    "charged_amount"    DECIMAL(14,2) NOT NULL DEFAULT 0,
    "description"       TEXT NOT NULL DEFAULT '',
    "attachments"       JSONB NOT NULL DEFAULT '[]',
    "occurred_at"       TIMESTAMP(3) NOT NULL,
    "reported_by"       CHAR(24) NOT NULL,
    "item_snapshot"     JSONB NOT NULL,
    "location_snapshot" JSONB NOT NULL,
    "waive_reason"      TEXT NOT NULL DEFAULT '',
    "waived_at"         TIMESTAMP(3),
    "waived_by"         CHAR(24),
    "cancel_reason"     TEXT NOT NULL DEFAULT '',
    "cancelled_at"      TIMESTAMP(3),
    "cancelled_by"      CHAR(24),
    "created_by"        CHAR(24) NOT NULL,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_damages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_damages_occurred_at_idx" ON "inventory_damages"("occurred_at" DESC);
CREATE INDEX "inventory_damages_status_occurred_at_idx" ON "inventory_damages"("status", "occurred_at" DESC);
CREATE INDEX "inventory_damages_location_id_occurred_at_idx" ON "inventory_damages"("location_id", "occurred_at" DESC);
CREATE INDEX "inventory_damages_item_id_occurred_at_idx" ON "inventory_damages"("item_id", "occurred_at" DESC);
CREATE INDEX "inventory_damages_check_id_idx" ON "inventory_damages"("check_id");
ALTER TABLE "inventory_damages" ADD CONSTRAINT "inventory_damages_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_damages" ADD CONSTRAINT "inventory_damages_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_damages" ADD CONSTRAINT "inventory_damages_stock_id_fkey"
    FOREIGN KEY ("stock_id") REFERENCES "inventory_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_damages" ADD CONSTRAINT "inventory_damages_check_id_fkey"
    FOREIGN KEY ("check_id") REFERENCES "inventory_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 10. MIQDOR DAFTARI — QAT'IY APPEND-ONLY (AccountEntry ko'zgusi)
--
-- 9-bo'limdan KEYIN yaratiladi: damage_id unga FK bilan bog'lanadi.
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_movements" (
    "id"                      CHAR(24) NOT NULL,
    "seq"                     BIGSERIAL NOT NULL,
    "stock_id"                CHAR(24) NOT NULL,
    "location_id"             CHAR(24) NOT NULL,
    "item_id"                 CHAR(24) NOT NULL,
    "type"                    "InventoryMovementType" NOT NULL,
    "quantity_delta"          INTEGER NOT NULL,
    "broken_delta"            INTEGER NOT NULL DEFAULT 0,
    "quantity_after"          INTEGER NOT NULL,
    "broken_after"            INTEGER NOT NULL,
    "occurred_at"             TIMESTAMP(3) NOT NULL,
    "check_id"                CHAR(24),
    "damage_id"               CHAR(24),
    "counterpart_location_id" CHAR(24),
    "note"                    TEXT NOT NULL DEFAULT '',
    "created_by"              CHAR(24) NOT NULL,
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "inventory_movements_stock_id_seq_idx" ON "inventory_movements"("stock_id", "seq" DESC);
CREATE INDEX "inventory_movements_location_id_occurred_at_idx" ON "inventory_movements"("location_id", "occurred_at" DESC);
CREATE INDEX "inventory_movements_item_id_occurred_at_idx" ON "inventory_movements"("item_id", "occurred_at" DESC);
CREATE INDEX "inventory_movements_occurred_at_idx" ON "inventory_movements"("occurred_at");
CREATE INDEX "inventory_movements_check_id_idx" ON "inventory_movements"("check_id");
CREATE INDEX "inventory_movements_damage_id_idx" ON "inventory_movements"("damage_id");
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_stock_id_fkey"
    FOREIGN KEY ("stock_id") REFERENCES "inventory_stocks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fkey"
    FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_check_id_fkey"
    FOREIGN KEY ("check_id") REFERENCES "inventory_checks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_damage_id_fkey"
    FOREIGN KEY ("damage_id") REFERENCES "inventory_damages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 11. AYBDORGA QARZ (PayrollEntry ko'zgusi, teskari yo'nalishda)
-- ─────────────────────────────────────────────
CREATE TABLE "damage_charges" (
    "id"              CHAR(24) NOT NULL,
    "damage_id"       CHAR(24) NOT NULL,
    "person_id"       CHAR(24) NOT NULL,
    "person_role"     TEXT NOT NULL,
    "person_snapshot" JSONB NOT NULL,
    "quantity"        INTEGER NOT NULL DEFAULT 0,
    "amount"          DECIMAL(14,2) NOT NULL,
    "paid_amount"     DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status"          "DamageChargeStatus" NOT NULL DEFAULT 'unpaid',
    "note"            TEXT NOT NULL DEFAULT '',
    "due_date"        DATE,
    "paid_at"         TIMESTAMP(3),
    "cancel_reason"   TEXT NOT NULL DEFAULT '',
    "cancelled_at"    TIMESTAMP(3),
    "cancelled_by"    CHAR(24),
    "created_by"      CHAR(24) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "damage_charges_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "damage_charges_person_id_status_idx" ON "damage_charges"("person_id", "status");
CREATE INDEX "damage_charges_person_id_created_at_idx" ON "damage_charges"("person_id", "created_at" DESC);
CREATE INDEX "damage_charges_status_created_at_idx" ON "damage_charges"("status", "created_at" DESC);
CREATE INDEX "damage_charges_damage_id_idx" ON "damage_charges"("damage_id");
CREATE INDEX "damage_charges_due_date_idx" ON "damage_charges"("due_date");
ALTER TABLE "damage_charges" ADD CONSTRAINT "damage_charges_damage_id_fkey"
    FOREIGN KEY ("damage_id") REFERENCES "inventory_damages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 12. UNDIRUV — Payment ko'zgusi, LEKIN DEPOZITSIZ
-- ─────────────────────────────────────────────
CREATE TABLE "damage_payments" (
    "id"              CHAR(24) NOT NULL,
    "receipt_no"      SERIAL NOT NULL,
    "person_id"       CHAR(24) NOT NULL,
    "account_id"      CHAR(24) NOT NULL,
    "amount"          DECIMAL(14,2) NOT NULL,
    "paid_at"         TIMESTAMP(3) NOT NULL,
    "note"            TEXT NOT NULL DEFAULT '',
    "person_snapshot" JSONB NOT NULL,
    "is_voided"       BOOLEAN NOT NULL DEFAULT false,
    "voided_at"       TIMESTAMP(3),
    "voided_by"       CHAR(24),
    "void_reason"     TEXT NOT NULL DEFAULT '',
    "created_by"      CHAR(24) NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,
    CONSTRAINT "damage_payments_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "damage_payments_receipt_no_key" ON "damage_payments"("receipt_no");
CREATE INDEX "damage_payments_person_id_paid_at_idx" ON "damage_payments"("person_id", "paid_at" DESC);
CREATE INDEX "damage_payments_account_id_paid_at_idx" ON "damage_payments"("account_id", "paid_at" DESC);
CREATE INDEX "damage_payments_paid_at_idx" ON "damage_payments"("paid_at");
ALTER TABLE "damage_payments" ADD CONSTRAINT "damage_payments_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "payment_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 13. Taqsimot — to'lov qaysi qarzni yopdi
-- ─────────────────────────────────────────────
CREATE TABLE "damage_allocations" (
    "id"         CHAR(24) NOT NULL,
    "payment_id" CHAR(24) NOT NULL,
    "charge_id"  CHAR(24) NOT NULL,
    "person_id"  CHAR(24) NOT NULL,
    "amount"     DECIMAL(14,2) NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL,
    "is_voided"  BOOLEAN NOT NULL DEFAULT false,
    "voided_at"  TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "damage_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "damage_allocations_charge_id_is_voided_idx" ON "damage_allocations"("charge_id", "is_voided");
CREATE INDEX "damage_allocations_payment_id_idx" ON "damage_allocations"("payment_id");
CREATE INDEX "damage_allocations_person_id_applied_at_idx" ON "damage_allocations"("person_id", "applied_at" DESC);
ALTER TABLE "damage_allocations" ADD CONSTRAINT "damage_allocations_payment_id_fkey"
    FOREIGN KEY ("payment_id") REFERENCES "damage_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "damage_allocations" ADD CONSTRAINT "damage_allocations_charge_id_fkey"
    FOREIGN KEY ("charge_id") REFERENCES "damage_charges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 14. Daftar yozuvi undiruv hujjatiga ishora qiladi
-- ─────────────────────────────────────────────
ALTER TABLE "account_entries" ADD COLUMN "damage_payment_id" CHAR(24);
CREATE INDEX "account_entries_damage_payment_id_idx" ON "account_entries"("damage_payment_id");
ALTER TABLE "account_entries" ADD CONSTRAINT "account_entries_damage_payment_id_fkey"
    FOREIGN KEY ("damage_payment_id") REFERENCES "damage_payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 15. Sozlamalar singletoni (har filialda alohida)
-- ─────────────────────────────────────────────
CREATE TABLE "inventory_settings" (
    "id"                  VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "daily_check_enabled" BOOLEAN NOT NULL DEFAULT true,
    "reminder_time"       TEXT NOT NULL DEFAULT '17:00',
    "reminder_enabled"    BOOLEAN NOT NULL DEFAULT false,
    "require_photo"       BOOLEAN NOT NULL DEFAULT false,
    "default_account_id"  CHAR(24),
    "updated_by"          CHAR(24),
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,
    CONSTRAINT "inventory_settings_pkey" PRIMARY KEY ("id")
);
