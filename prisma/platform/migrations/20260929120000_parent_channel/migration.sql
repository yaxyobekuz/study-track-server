-- SEANS KANALI: OTA-ONA MOBIL ILOVASI (`X-Client: parent`).
--
-- Ota-ona ilovasi o'quvchi hisobi bilan kiradi — ota-ona telefoni va bola
-- telefoni bitta `userId`. Push qaysi telefonga borishini (`parental_policy`
-- faqat bolaga, `parental_alert` faqat ota-onaga) seans kanali hal qiladi
-- (`push.service.js` → `channels`).
--
-- ⚠️ Kanal — MARSHRUT, himoya emas: qiymatni mijoz yozadi. Himoya — PIN.
--
-- Mavjud birorta qator o'zgarmaydi, faqat enumga bitta qiymat qo'shiladi.

ALTER TYPE "SessionChannel" ADD VALUE IF NOT EXISTS 'parent';
