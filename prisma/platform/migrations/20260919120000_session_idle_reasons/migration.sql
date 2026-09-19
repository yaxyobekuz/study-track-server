-- SEANS YOPILISH SABABLARI: HARAKATSIZLIK VA ILOVA O'CHIRILISHI.
--
-- ⚠️ NIMA UCHUN: mobil ilova o'chirilganda `POST /auth/logout` chaqirilmaydi
-- va seans qatori token muddati tugaguncha (30 kun) `active` bo'lib qoladi.
-- O'qituvchida bu 4 ta joydan (`SESSION_LIMITS`) birini egallaydi — bir necha
-- marta qayta o'rnatilgach login 409 bilan yopilib qolardi.
--
--   idle         — 4 kun davomida bironta so'rov kelmagan seans
--   app_removed  — Firebase push tokeni "ro'yxatdan chiqdi" (ilova o'chirilgan)
--
-- ⚠️ `expired` QAYTA ISHLATILMAYDI: xavfsizlik bo'limida "token muddati
-- tugadi", "uzoq kirmadi" va "ilova o'chirildi" alohida ko'rinishi kerak.
--
-- Mavjud birorta qator o'zgarmaydi, faqat enumga ikki qiymat qo'shiladi.

ALTER TYPE "SessionEndReason" ADD VALUE IF NOT EXISTS 'idle';
ALTER TYPE "SessionEndReason" ADD VALUE IF NOT EXISTS 'app_removed';
