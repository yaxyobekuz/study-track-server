-- HAFTALIK AI TAHLIL — bitta yangi jadval.
--
-- Mavjud birorta ustun o'zgarmaydi, birorta qator ko'chirilmaydi:
-- tahlil butunlay hosila ma'lumot va u yo'q bo'lsa ekran jonli
-- qoidalar matnini ko'rsatadi.
--
-- ⚠️ `week_start` UNIKAL: cron bir haftada ikki marta ishlasa ham
-- (qayta ishga tushirish yoki qo'lda yangilash) ikkinchi qator paydo
-- bo'lmaydi — `upsert` mavjudining ustiga yozadi.

CREATE TABLE IF NOT EXISTS "academic_insights" (
  "id"           CHAR(24)     NOT NULL,
  -- Toshkent dushanbasi, UTC yarim tunida (`DATE` — kun koordinatasi)
  "week_start"   DATE         NOT NULL,
  "month"        INTEGER      NOT NULL,
  -- "ai" | "rules" — matnni kim yozgani
  "source"       VARCHAR(10)  NOT NULL DEFAULT 'rules',
  "model"        VARCHAR(60)  NOT NULL DEFAULT '',
  "facts"        JSONB        NOT NULL,
  "insights"     JSONB        NOT NULL,
  "actions"      JSONB        NOT NULL,
  "summary"      TEXT         NOT NULL DEFAULT '',
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Bo'sh satr = cron yozgan. CHAR emas: CHAR bo'shlikni probel bilan to'ldiradi.
  "created_by"   VARCHAR(24)  NOT NULL DEFAULT '',

  CONSTRAINT "academic_insights_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "academic_insights_week_start_key"
  ON "academic_insights"("week_start");
CREATE INDEX IF NOT EXISTS "academic_insights_generated_at_idx"
  ON "academic_insights"("generated_at" DESC);
