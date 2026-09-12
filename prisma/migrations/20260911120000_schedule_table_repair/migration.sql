-- DARS JADVALI JADVALINI TUZATISH (versiyalash qoldig'i)
--
-- `20260827140000_schedule_versioning` migratsiyasi `schedules` ga
-- `effective_from DATE NOT NULL` (DEFAULT'siz) ustunini qo'shgan va
-- (class_id, day) unique indeksini olib tashlagan. Keyin versiyalash kodi
-- olib tashlandi (merge 54d6c71), lekin migratsiya qaytarilmadi: u amalda
-- ishlagan har bir bazada (yangi filiallar ham — ular migratsiyalarni noldan
-- oladi) Prisma `schedules` ga yangi qator yoza OLMAYDI, chunki sxemada bu
-- ustun yo'q va baza NOT NULL talab qiladi. Ya'ni jadvalni saqlash ham,
-- Google Sheets'dan qo'llash ham "null value in column effective_from"
-- bilan yiqiladi.
--
-- ⚠️ BU MIGRATSIYA HECH NARSANI O'CHIRMAYDI:
--   · ustun o'chirilmaydi — faqat DEFAULT beriladi (yangi qator yozilsin);
--   · unique indeks faqat TAKRORIY (class_id, day) qator BO'LMASA tiklanadi.
--     Takroriy qatorlar bo'lsa, ular joyida qoladi (qaysi biri to'g'ri ekanini
--     migratsiya hal qila olmaydi) va indeks yaratilmaydi.
-- Idempotent: ustun/indeks yo'q bazada (masalan, migratsiya `resolve
-- --applied` bilan o'tkazilgan joyda) hech narsa qilmaydi.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'schedules'
      AND column_name = 'effective_from'
  ) THEN
    ALTER TABLE "schedules" ALTER COLUMN "effective_from" SET DEFAULT CURRENT_DATE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'schedules'
      AND indexname = 'schedules_class_id_day_key'
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM "schedules"
      GROUP BY "class_id", "day"
      HAVING COUNT(*) > 1
    ) THEN
      CREATE UNIQUE INDEX "schedules_class_id_day_key" ON "schedules"("class_id", "day");
    ELSE
      RAISE NOTICE 'schedules: takroriy (class_id, day) qatorlar bor — unique indeks tiklanmadi';
    END IF;
  END IF;
END
$$;
