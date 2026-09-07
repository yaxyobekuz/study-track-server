-- TELEFON RAQAMLARI — filial schema'si.
--
-- `phone` (o'quvchining o'zi) va `parent_phone` (ota-ona). Ikkalasi NULL
-- bilan qo'shiladi: mavjud o'quvchilarda raqam yo'q va u profildan
-- `users.phone` ruxsati bilan qo'lda to'ldiriladi. Davomat ekranidagi
-- "Qo'ng'iroq" tugmasi shu ustunlardan o'qiydi.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "parent_phone" TEXT;
