-- O'ZGARISHLAR TARIXI: FACE ID KIOSK ILOVASI UCHUN O'Z PANELI.
--
-- ⚠️ NIMA UCHUN: kiosk (`face-id/`, Electron) kompyuterlarga ALOHIDA
-- o'rnatiladi va ALOHIDA yangilanadi. "Qaysi kioskda qaysi versiya turibdi"
-- degan savol operatsion jihatdan muhim, shuning uchun u `server` yozuvi
-- ichida tilga olinib qolmaydi — o'z versiyasi (o'z qatori) bo'ladi.
--
-- Mavjud birorta qator o'zgarmaydi, faqat enumga bitta qiymat qo'shiladi.

ALTER TYPE "ChangelogPanel" ADD VALUE IF NOT EXISTS 'kiosk';
