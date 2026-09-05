-- Hisob-fakturaga MUHRLANADIGAN yo'nalish nomi.
--
-- Bo'sh bo'lishi mumkin: eski qatorlar va yo'nalishsiz tariflar. Hisobot
-- bunday qatorni tarif nomi bilan guruhlaydi (COALESCE).

ALTER TABLE "monthly_invoices"
  ADD COLUMN IF NOT EXISTS "direction_name" TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "monthly_invoices_direction_name_idx"
  ON "monthly_invoices"("direction_name");
