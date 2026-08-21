-- UMUMIY KATALOGLAR PLATFORMAGA KO'CHDI
--
-- Bu jadvallar endi `platform` schema'sida yashaydi (prisma/platform/schema.prisma),
-- chunki ular barcha filiallarga UMUMIY:
--
--   roles                     — rollar va boshlang'ich ruxsatlar
--   tariffs / tariff_versions — narx katalogi
--   discounts                 — chegirma turlari katalogi
--   changelogs / changelog_*  — o'zgarishlar tarixi (dasturiy ta'minot darajasida)
--
-- ⚠️ MA'LUMOTNI AVVAL KO'CHIRING. Mavjud ("Bosh filial") baza uchun tartib:
--
--     1) npm run branch:bootstrap   ← platforma schema'sini yaratadi,
--                                     jadvallarni PLATFORMAGA nusxalaydi,
--                                     sanoqni solishtiradi va faqat SHUNDAN
--                                     KEYIN eski nusxani bo'shatadi
--     2) npm run branch:migrate     ← faqat shundan keyin bu migratsiya qo'llanadi
--
-- HIMOYA: har bir DROP dan oldin jadval BO'SHLIGI tekshiriladi. Bo'sh
-- bo'lmasa migratsiya XATO bilan to'xtaydi va ma'lumot joyida qoladi.
-- Ya'ni "bootstrap'ni o'tkazib yuborish" — sekin nosozlik emas, BALAND xato.
--
-- Yangi filiallar uchun bu shunchaki "yaratildi → o'chirildi" ketma-ketligi:
-- `migrate deploy` barcha migratsiyalarni boshidan o'ynatadi, jadvallar bo'sh
-- bo'ladi va himoya jimgina o'tadi.

DO $$
DECLARE
  legacy_tables text[] := ARRAY[
    'tariff_versions',
    'tariffs',
    'discounts',
    'changelog_notifications',
    'changelog_settings',
    'changelogs',
    'roles'
  ];
  tbl text;
  row_count bigint;
BEGIN
  FOREACH tbl IN ARRAY legacy_tables LOOP
    -- Jadval umuman yo'q bo'lsa (yangi filial emas, boshqa sabab) — o'tamiz
    IF to_regclass(quote_ident(current_schema()) || '.' || quote_ident(tbl)) IS NULL THEN
      CONTINUE;
    END IF;

    EXECUTE format('SELECT count(*) FROM %I.%I', current_schema(), tbl) INTO row_count;

    IF row_count > 0 THEN
      RAISE EXCEPTION
        '"%.%" jadvalida % ta qator bor — u platformaga ko''chirilmagan. '
        'Avval "npm run branch:bootstrap" ni ishga tushiring.',
        current_schema(), tbl, row_count;
    END IF;
  END LOOP;
END $$;

-- FK tartibi: tariff_versions → tariffs. CASCADE baribir hal qiladi, lekin
-- tartib aniq turgani o'qishni osonlashtiradi.
DROP TABLE IF EXISTS "tariff_versions" CASCADE;
DROP TABLE IF EXISTS "tariffs" CASCADE;
DROP TABLE IF EXISTS "discounts" CASCADE;
DROP TABLE IF EXISTS "changelog_notifications" CASCADE;
DROP TABLE IF EXISTS "changelog_settings" CASCADE;
DROP TABLE IF EXISTS "changelogs" CASCADE;
DROP TABLE IF EXISTS "roles" CASCADE;

-- Enum tiplari PostgreSQL'da schema'ga tegishli, ya'ni bu yerda tashlash
-- `platform` schema'sidagi bir xil nomli tiplarga TEGMAYDI.
DROP TYPE IF EXISTS "DiscountType";
DROP TYPE IF EXISTS "ChangelogPanel";
DROP TYPE IF EXISTS "ChangelogBump";
DROP TYPE IF EXISTS "ChangelogNotificationKind";
DROP TYPE IF EXISTS "ChangelogNotificationStatus";
