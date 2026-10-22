-- MAVZUGA "DARAJA" VA "KITOB"
--
-- Biznes qarori (2026-10-22): fanning mavzular rejasi faylida har bir mavzu
-- qaysi darajaga (Beginner, Elementary … / Leksikologiya, Fonetika …) va
-- qaysi kitobga tegishli ekani ham yoziladi va u dars jadvalida mavzu bilan
-- birga ko'rinadi. "Nimalar o'rgatiladi" mavjud `description` ustuniga
-- tushadi — yangi ustun kerak emas.
--
-- Ikkalasi ham IXTIYORIY (NULL): hamma fanning rejasida bu ma'lumot yo'q va
-- eski shablon (Mavzu nomi, Tavsif) bilan yuklangan mavzular ham
-- o'zgarishsiz ishlashda davom etadi.
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "level" TEXT;
ALTER TABLE "topics" ADD COLUMN IF NOT EXISTS "book" TEXT;
