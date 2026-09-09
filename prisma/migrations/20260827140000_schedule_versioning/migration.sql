-- Dars jadvalini versiyalash: amal qilish davri (dan-gacha) qo'shish.
-- Bir (sinf, kun) uchun endi bir nechta versiya bo'lishi mumkin (kesishmasdan),
-- shuning uchun unique(class_id, day) olib tashlanadi.

ALTER TABLE "schedules" ADD COLUMN "effective_from" DATE;
ALTER TABLE "schedules" ADD COLUMN "effective_to" DATE;

-- Mavjud jadvallar seed davrini (iyun 2026 dan) qamrab olsin
UPDATE "schedules" SET "effective_from" = DATE '2026-06-01' WHERE "effective_from" IS NULL;
ALTER TABLE "schedules" ALTER COLUMN "effective_from" SET NOT NULL;

-- Bitta (sinf, kun) cheklovi o'rniga versiyalash indeksi
DROP INDEX IF EXISTS "schedules_class_id_day_key";
CREATE INDEX "schedules_class_id_day_effective_from_idx"
  ON "schedules" ("class_id", "day", "effective_from" DESC);
