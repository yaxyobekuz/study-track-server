-- ISH VAQTI YO'Q — xodimdan davomat umuman talab qilinmaydi.
--
-- ⚠️ `manual` + bo'sh ish kunlari BUNI BERA OLMAYDI: hal qiluvchi
-- (`getEffectiveSchedule`) bo'sh `work_days` ni "belgilanmagan" deb o'qib
-- Du–Ju ga qaytaradi — roldan meros olish aynan shu bilan ishlaydi.
-- "Ish vaqti yo'q" esa QAROR, bo'shliq emas, shuning uchun u alohida
-- qiymat bo'lishi kerak.
--
-- Natijasi: kechki pass "kelmadi" yozmaydi, kechikish va erta ketish
-- jarimasi hisoblanmaydi, oylikdagi kelmagan kun ayirmasi chiqmaydi.
-- Qo'lda belgilash va "Men keldim" esa ochiq qoladi.

ALTER TYPE "WorkTimeSource" ADD VALUE IF NOT EXISTS 'none';
