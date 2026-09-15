-- SEANS: QURILMA IDENTIFIKATORI VA KO'P QURILMA SIYOSATI.
--
-- ⚠️ NIMA UCHUN: yangi kirish "o'sha qurilmaning" eski seansini yopardi,
-- qurilma esa faqat "Chrome · Android" yorlig'i bilan tanilardi. Ikkita
-- turli telefon bir xil yorliqqa ega bo'lgani uchun o'quvchi ikkinchi
-- telefondan kirganda BIRINCHISIDAN otib yuborilardi.
--
--   device_id    — brauzer xotirasidagi tasodifiy identifikator (`X-Device-Id`)
--   multi_device — seans ochilgan paytdagi siyosat: o'quvchi `true`
--                  (hech qanday seans yopilmaydi), xodim `false` (avvalgidek)
--
-- Mavjud birorta qator o'chirilmaydi, faqat ikki ustun qo'shiladi.

ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "device_id" VARCHAR(64);
ALTER TABLE "user_sessions" ADD COLUMN IF NOT EXISTS "multi_device" BOOLEAN NOT NULL DEFAULT false;

-- ⚠️ ORQAGA TO'LDIRISH MAJBURIY. Usiz o'quvchilarning hozir ochiq
-- seanslari `false` bo'lib qolardi va birinchi kechki supurgi
-- (`dedupeLiveSessions`, 03:40) ularni eski qoida bo'yicha yopib,
-- o'quvchini oxirgi marta tizimdan chiqarib yuborardi.
-- `user_directory.id` = filialdagi `User.id` (login yo'naltirgichi).
UPDATE "user_sessions" AS s
SET "multi_device" = true
FROM "user_directory" AS d
WHERE d."id" = s."user_id"
  AND d."role" = 'student'
  AND s."multi_device" = false;
