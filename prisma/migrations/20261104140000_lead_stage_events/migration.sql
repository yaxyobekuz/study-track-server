-- QABUL ZINAPOYASI TARIXI + KIRITISH MAYDONLARI.
--
-- 1) `leads` ga uch maydon: kelgan maktabi, kim olib keldi, kim mas'ul.
-- 2) `lead_stage_events` — "shu lead qaysi pog'onagacha YETGAN" fakti.
--
-- ⚠️ FUNNEL JORIY HOLATDAN HISOBLANMAYDI. Lead `enrolled` bo'lsa u
-- `interested` da turmaydi, ya'ni holat bo'yicha sanalgan "funnel" har
-- pog'onada faqat O'SHA YERDA QOTIB QOLGANLARNI ko'rsatadi. "10 ta bola
-- olib keldim, 2 tasi qoldi" degan savolga javob berish uchun har
-- pog'onaga YETISH fakti alohida qator bo'lishi kerak.
--
-- ⚠️ ORTGA QAYTISH QATORNI O'CHIRMAYDI — "yetgan" o'tgan fakt. Chiqib
-- ketish HOLAT bilan qayd etiladi (`lost`/`rejected`/`postponed`), shuning
-- uchun "qaysi pog'onada yo'qotdik" savoliga javob qoladi.

ALTER TABLE "leads"
  ADD COLUMN "previous_school" TEXT,
  -- soft ref → users (FK yo'q, `leads.created_by` bilan AYNI naqsh):
  -- xodim arxivlansa ham tahlil o'qilishi kerak
  ADD COLUMN "brought_by" CHAR(24),
  ADD COLUMN "assigned_to" CHAR(24);

-- "Men nechta olib keldim" va "menga nechtasi berildi" kesimlari
CREATE INDEX "leads_brought_by_idx" ON "leads"("brought_by");
CREATE INDEX "leads_assigned_to_idx" ON "leads"("assigned_to");

CREATE TABLE "lead_stage_events" (
    "id" CHAR(24) NOT NULL,
    "lead_id" CHAR(24) NOT NULL,
    -- pog'ona raqami 1..6 — KALIT shu, holat nomi emas
    "stage" INTEGER NOT NULL,
    "status" "LeadStatus" NOT NULL,
    "reached_at" TIMESTAMP(3) NOT NULL,
    "created_by" CHAR(24),
    "note" TEXT NOT NULL DEFAULT '',
    -- eski ma'lumotdan tiklangan: VAQTI taxminiy, SONI aniq
    "backfilled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_stage_events_pkey" PRIMARY KEY ("id")
);

-- BIR POG'ONAGA BIR MARTA YETILADI — takror yozuv strukturaviy imkonsiz
CREATE UNIQUE INDEX "lead_stage_events_lead_id_stage_key" ON "lead_stage_events"("lead_id", "stage");
CREATE INDEX "lead_stage_events_stage_reached_at_idx" ON "lead_stage_events"("stage", "reached_at");

-- Lead o'chirilsa tarixi ham ketadi (u faqat shu lead haqida)
ALTER TABLE "lead_stage_events" ADD CONSTRAINT "lead_stage_events_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── BACKFILL ────────────────────────────────────────────────────────────
--
-- Eski ma'lumotda pog'ona tarixi yo'q, lekin uni TIKLASH mumkin: lead'ning
-- joriy holati va `lead_activities` dagi holat o'zgarishlari (eski + yangi)
-- ichidan ENG YUQORI pog'ona olinadi. Chiqib ketgan lead (`lost`) ham
-- shunday tiklanadi — uning qaysi pog'onada yo'qolgani aynan tarixda.
--
-- ⚠️ Zinapoya MONOTON: eng yuqori pog'ona N bo'lsa, 1..N ning hammasi
-- yoziladi. Busiz "yetganlar soni" pastga tushib, grafik teskari ko'rinardi.
--
-- ⚠️ `id` DETERMINISTIK (`md5(lead_id || ':' || stage)`): migratsiya qayta
-- ishlasa ham ikkinchi qator paydo bo'lmaydi (unique indeks ham to'sadi).
WITH rungs (stage, status) AS (
  VALUES (1, 'interested'), (2, 'trial'), (3, 'visited'),
         (4, 'attended'), (5, 'liked'), (6, 'enrolled')
),
mapped AS (
  SELECT
    l."id"         AS lead_id,
    l."updated_at" AS reached_at,
    GREATEST(
      CASE l."status"::text
        WHEN 'interested'  THEN 1
        WHEN 'trial'       THEN 2
        WHEN 'visited'     THEN 3
        WHEN 'attended'    THEN 4
        -- "Muzokara" — to'lovdan oldingi suhbat, ya'ni dars allaqachon
        -- yoqqan holat (5-pog'ona)
        WHEN 'negotiation' THEN 5
        WHEN 'liked'       THEN 5
        WHEN 'enrolled'    THEN 6
        ELSE 0
      END,
      COALESCE(MAX(
        CASE a."new_status"
          WHEN 'interested'  THEN 1
          WHEN 'trial'       THEN 2
          WHEN 'visited'     THEN 3
          WHEN 'attended'    THEN 4
          WHEN 'negotiation' THEN 5
          WHEN 'liked'       THEN 5
          WHEN 'enrolled'    THEN 6
          ELSE 0
        END
      ), 0),
      COALESCE(MAX(
        CASE a."previous_status"
          WHEN 'interested'  THEN 1
          WHEN 'trial'       THEN 2
          WHEN 'visited'     THEN 3
          WHEN 'attended'    THEN 4
          WHEN 'negotiation' THEN 5
          WHEN 'liked'       THEN 5
          WHEN 'enrolled'    THEN 6
          ELSE 0
        END
      ), 0)
    ) AS max_rung
  FROM "leads" l
  LEFT JOIN "lead_activities" a ON a."lead_id" = l."id"
  GROUP BY l."id", l."updated_at", l."status"
)
INSERT INTO "lead_stage_events"
  ("id", "lead_id", "stage", "status", "reached_at", "created_by", "note", "backfilled", "created_at")
SELECT
  substr(md5(m.lead_id || ':' || r.stage::text), 1, 24),
  m.lead_id,
  r.stage,
  r.status::"LeadStatus",
  m.reached_at,
  NULL,
  'Eski ma''lumotdan tiklandi',
  true,
  NOW()
FROM mapped m
JOIN rungs r ON r.stage <= m.max_rung
WHERE m.max_rung > 0
ON CONFLICT ("lead_id", "stage") DO NOTHING;
