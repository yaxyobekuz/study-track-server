-- INVENTAR — ZARAR SABABI VA TOPSHIRISH-QABUL QILISH AKTI
--
-- Ikki mustaqil qo'shimcha, bitta migratsiyada (ikkalasi ham inventar
-- domenining shu bosqichdagi bo'shliqlari):
--
--   1) SABAB   — "nima bo'ldi": sindi / yaroqlilik muddati tugadi /
--                eskirdi / yo'qoldi / o'g'irlandi / boshqa.
--                `kind` (xatlovga ta'sir) dan MUSTAQIL o'lchov.
--   2) O'TKAZMA — "qaysi xonaga va KIMGA topshirildi" hujjati.
--                `AccountTransfer` ning aynan ko'zgusi.

-- ─────────────────────────────────────────────
-- 1. ZARAR SABABI — yangi enum
-- ─────────────────────────────────────────────
DO $$ BEGIN
    CREATE TYPE "InventoryDamageReason" AS ENUM
        ('broken', 'expired', 'worn_out', 'misused', 'lost', 'stolen', 'other');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Kunlik hisobot satri — HAR BIR TUR uchun alohida sabab.
--
-- Bir satrda ikkala tur bir vaqtda bo'lishi mumkin ("3 tasi sindi, 1 tasi
-- yo'qoldi") va ular BOSHQA-BOSHQA zarar hodisasiga aylanadi. Bitta umumiy
-- ustun bo'lsa, ikkala hodisaga bir xil sabab muhrlanardi.
--
-- NULL qonuniy: tegishli miqdor nol bo'lganda sabab ham bo'lmaydi.
ALTER TABLE "inventory_check_lines"
    ADD COLUMN IF NOT EXISTS "broken_reason"  "InventoryDamageReason",
    ADD COLUMN IF NOT EXISTS "missing_reason" "InventoryDamageReason";

-- Zarar hodisasi — sabab hodisa bilan birga MUHRLANADI.
--
-- DEFAULT 'broken' faqat mavjud qatorlar uchun kerak; yangi hodisada sabab
-- MAJBURIY va uni service tekshiradi.
ALTER TABLE "inventory_damages"
    ADD COLUMN IF NOT EXISTS "reason" "InventoryDamageReason" NOT NULL DEFAULT 'broken';

-- BACKFILL: eski qatorlarda sabab yo'q edi, lekin `kind` bor. Yo'qolgan
-- buyumning sababi "sindi" bo'lib qolmasligi uchun uni 'lost' ga o'tkazamiz
-- (`broken` esa DEFAULT bilan allaqachon to'g'ri).
UPDATE "inventory_damages" SET "reason" = 'lost' WHERE "kind" = 'missing';

-- Sabab kesimi hisoboti — "bu yil nechta jihoz yaroqlilik muddati tugagani
-- uchun chiqdi" degan savol butun jadvalni skanerlamasin.
CREATE INDEX IF NOT EXISTS "inventory_damages_reason_occurred_at_idx"
    ON "inventory_damages"("reason", "occurred_at" DESC);

-- ─────────────────────────────────────────────
-- 2. O'TKAZMA HUJJATI
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "inventory_transfers" (
    "id"               CHAR(24) NOT NULL,
    "from_location_id" CHAR(24) NOT NULL,
    "to_location_id"   CHAR(24) NOT NULL,
    -- Kimga topshirildi (soft ref → users). Ixtiyoriy: "singan partalar
    -- omborga" o'tkazmasida aniq qabul qiluvchi bo'lmasligi mumkin.
    "to_person_id"     CHAR(24),
    "person_snapshot"  JSONB,
    "occurred_at"      TIMESTAMP(3) NOT NULL,
    "note"             TEXT NOT NULL DEFAULT '',
    "lines_count"      INTEGER NOT NULL DEFAULT 0,
    "total_quantity"   INTEGER NOT NULL DEFAULT 0,
    "from_snapshot"    JSONB NOT NULL,
    "to_snapshot"      JSONB NOT NULL,
    "created_by"       CHAR(24) NOT NULL,
    "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_transfers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "inventory_transfers_occurred_at_idx"
    ON "inventory_transfers"("occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "inventory_transfers_from_location_id_occurred_at_idx"
    ON "inventory_transfers"("from_location_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "inventory_transfers_to_location_id_occurred_at_idx"
    ON "inventory_transfers"("to_location_id", "occurred_at" DESC);
-- "Shu xodimga nima topshirilgan" kesimi
CREATE INDEX IF NOT EXISTS "inventory_transfers_to_person_id_occurred_at_idx"
    ON "inventory_transfers"("to_person_id", "occurred_at" DESC);

-- Restrict, Cascade EMAS: Cascade o'tkazma tarixini xona bilan birga olib
-- ketardi (`inventory_movements` bilan bir xil mulohaza).
ALTER TABLE "inventory_transfers" DROP CONSTRAINT IF EXISTS "inventory_transfers_from_location_id_fkey";
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_from_location_id_fkey"
    FOREIGN KEY ("from_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inventory_transfers" DROP CONSTRAINT IF EXISTS "inventory_transfers_to_location_id_fkey";
ALTER TABLE "inventory_transfers" ADD CONSTRAINT "inventory_transfers_to_location_id_fkey"
    FOREIGN KEY ("to_location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- O'tkazma satri — bir aktda bir nechta jihoz
CREATE TABLE IF NOT EXISTS "inventory_transfer_lines" (
    "id"              CHAR(24) NOT NULL,
    "transfer_id"     CHAR(24) NOT NULL,
    "item_id"         CHAR(24) NOT NULL,
    "item_name"       TEXT NOT NULL,
    "unit"            TEXT NOT NULL DEFAULT 'dona',
    "quantity"        INTEGER NOT NULL,
    -- `quantity` ICHIDA: jami 10 ta ko'chirildi, shundan 3 tasi singan
    "broken_quantity" INTEGER NOT NULL DEFAULT 0,
    "note"            TEXT NOT NULL DEFAULT '',
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_transfer_lines_pkey" PRIMARY KEY ("id")
);
-- Bitta aktda bitta jihoz BIR MARTA
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_transfer_lines_transfer_id_item_id_key"
    ON "inventory_transfer_lines"("transfer_id", "item_id");
CREATE INDEX IF NOT EXISTS "inventory_transfer_lines_item_id_idx"
    ON "inventory_transfer_lines"("item_id");

-- Satr aktsiz yashamaydi → Cascade (`inventory_check_lines` bilan bir xil)
ALTER TABLE "inventory_transfer_lines" DROP CONSTRAINT IF EXISTS "inventory_transfer_lines_transfer_id_fkey";
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "inventory_transfer_lines" DROP CONSTRAINT IF EXISTS "inventory_transfer_lines_item_id_fkey";
ALTER TABLE "inventory_transfer_lines" ADD CONSTRAINT "inventory_transfer_lines_item_id_fkey"
    FOREIGN KEY ("item_id") REFERENCES "inventory_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────
-- 3. Miqdor daftari → o'tkazma hujjatiga bog'lanish
-- ─────────────────────────────────────────────
-- Ikkala qator (chiqim va kirim) BITTA `transfer_id` ga ishora qiladi.
ALTER TABLE "inventory_movements"
    ADD COLUMN IF NOT EXISTS "transfer_id" CHAR(24);

CREATE INDEX IF NOT EXISTS "inventory_movements_transfer_id_idx"
    ON "inventory_movements"("transfer_id");

ALTER TABLE "inventory_movements" DROP CONSTRAINT IF EXISTS "inventory_movements_transfer_id_fkey";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_transfer_id_fkey"
    FOREIGN KEY ("transfer_id") REFERENCES "inventory_transfers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
