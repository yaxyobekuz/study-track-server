-- REJAGA QO'LDA QATOR QO'SHISH.
--
-- `metric` endi katalog kalitidan tashqari "custom:<id>" ham bo'lishi
-- mumkin. Bunday qatorning nomi va turi bazada saqlanadi — katalogda
-- ular yo'q. Mavjud qatorlar tegilmaydi: ikkala ustun ham sukut qiymatga
-- ega va katalog metrikalari uchun O'QILMAYDI.

ALTER TABLE "finance_targets"
  ADD COLUMN IF NOT EXISTS "label" TEXT NOT NULL DEFAULT '';

ALTER TABLE "finance_targets"
  ADD COLUMN IF NOT EXISTS "kind" VARCHAR(12) NOT NULL DEFAULT 'money';
