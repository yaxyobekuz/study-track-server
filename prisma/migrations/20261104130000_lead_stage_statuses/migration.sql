-- QABUL ZINAPOYASINING IKKI YANGI POG'ONASI.
--
-- Biznes qarori (2026-11-04): bola qabul qilinishi 6 pog'onadan o'tadi —
-- qiziqish bildirdi → sinov darsiga yozildi → keldi → DARSGA KIRDI →
-- DARS YOQDI → to'lov qildi. Oxirgi ikkita oraliq holat yo'q edi, ya'ni
-- "keldi, lekin darsga kirmadi" va "darsga kirdi, lekin yoqmadi" degan
-- yo'qotishlar bir-biridan ajratilmasdi — tahlilning butun mohiyati esa shu.
--
-- ⚠️ QIYMATLAR OXIRIGA QO'SHILADI (`BEFORE`/`AFTER` siz): PostgreSQL enum
-- tartibi domen tartibi EMAS. Pog'onalar tartibi yagona joyda —
-- `helpers/leadStage.helpers.js` dagi `LEAD_STAGES`.
--
-- ⚠️ ALOHIDA MIGRATSIYA va bu ataylab: PostgreSQL yangi enum qiymatini
-- U QO'SHILGAN TRANZAKSIYA ICHIDA ishlatishga ruxsat bermaydi
-- ("unsafe use of new value of enum type"). Keyingi migratsiya
-- (`..._lead_stage_events`) backfill'da aynan shu qiymatlarni yozadi,
-- shuning uchun ular ALOHIDA, oldin commit bo'ladigan qadamda qo'shiladi.
-- Ikkalasini bitta faylga qo'shsangiz migratsiya yiqiladi.

ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'attended';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'liked';
