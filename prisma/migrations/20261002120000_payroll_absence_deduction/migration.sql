-- KELMAGAN KUN UCHUN AYIRMA — fiksa oylikdan har "kelmadi"/"sababli" ish kuni
-- uchun kunlik summa ayriladi (biznes qarori, 2026-10-02; `finance.md` §10).
--
-- ⚠️ Mavjud qatorlar O'ZGARMAYDI: faqat yangi ustunlar, sukut 0 / '{}'.
-- Eski majburiyatlarda `absence_amount = 0` — invariant
-- (amount = fixed + kpi + allowance − absence − suspended − deduction) ular
-- uchun ham bajariladi.
--
-- ⚠️ Sozlama sukutda 202610 (Oktabr, 2026): o'tgan oylarga tegilmaydi.
-- O'chirish: Moliya → Sozlamalar → "Kelmagan kun uchun ayirma".

-- AlterTable
ALTER TABLE "payroll_entries"
    ADD COLUMN "absence_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN "absence_breakdown" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "finance_settings"
    ADD COLUMN "absence_deduction_from_month" INTEGER DEFAULT 202610;
