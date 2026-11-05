-- DIAGNOSTIKA — SAVOLNING PROVENIYANSI (qo'lda / fayldan / AI).
--
-- AI test yaratish qo'shildi: mavzu oralig'i va qiyinlik bo'yicha model
-- savol yozadi va ular BANKKA tushadi. Bank doktrinasi o'zgarmaydi —
-- testga faqat `approved` savol tushadi, tasdiqlash esa alohida ruxsat
-- (`diagnostics.moderate`). Ya'ni bu ustun hech qanday darvozani ochmaydi.
--
-- ⚠️ NEGA KERAK: moderatsiya navbatida AI yozgan savollar ALOHIDA
-- ko'rinishi kerak. Usiz admin yuzlab qoralama orasidan modelning
-- savollarini ajrata olmasdi va "tekshirilmagan savol qayerdan kelgan"
-- degan savol javobsiz qolardi.
--
-- Mavjud qatorlar `manual` bo'ladi: ular haqiqatan odam yozgan yoki
-- fayldan kelgan va ularni keyin "AI" deb belgilash ma'lumotni buzardi.

ALTER TABLE "diagnostic_questions"
  ADD COLUMN "source" VARCHAR(16) NOT NULL DEFAULT 'manual';

CREATE INDEX "diagnostic_questions_source_status_idx"
  ON "diagnostic_questions"("source", "status");
