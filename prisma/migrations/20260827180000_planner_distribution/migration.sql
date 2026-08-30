-- DARS TAQSIMOTI VARAG'I (mustaqil tab)
--
-- Butun varaq BITTA JSON hujjat sifatida saqlanadi. Bu ataylab: tab hozircha
-- MUSTAQIL — ustunlar (sinflar) va qatorlar (fanlar) varaqning o'zida yashaydi,
-- `classes` / `subjects` kataloglariga bog'lanmaydi. Normallashtirilgan jadvalga
-- yoysak, hali qabul qilinmagan qarorni ("qaysi ustun qaysi sinf?") sxemaga
-- muhrlab qo'ygan bo'lardik va integratsiya paytida uni qayta migratsiya
-- qilishga to'g'ri kelardi.
--
-- Doimiy saqlash MIJOZDA (localStorage). Bu jadval — IXTIYORIY zaxira: faqat
-- foydalanuvchi "Saqlash" tugmasini bosganda yoziladi.

CREATE TABLE "planner_distributions" (
    "id"         VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "data"       JSONB NOT NULL DEFAULT '{}',
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_distributions_pkey" PRIMARY KEY ("id")
);
