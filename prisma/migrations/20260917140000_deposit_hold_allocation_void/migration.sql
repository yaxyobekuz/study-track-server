-- DEPOZIT YECHIMINI QO'LDA BOSHQARISH.
--
-- `monthly_invoices.deposit_hold` — shu oyga depozitdan AVTOMAT yechish
-- to'xtatilgan (admin yechimni o'chirgan yoki kamaytirgan). Depozitdagi
-- "Qarzlarga qo'llash" tugmasi uni tozalaydi.
--
-- `payment_allocations.voided_by` / `void_reason` — yechim ALOHIDA bekor
-- qilinganda / tahrirlanganda kim va nima uchun (audit izi).

-- AlterTable
ALTER TABLE "monthly_invoices" ADD COLUMN     "deposit_hold" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payment_allocations" ADD COLUMN     "void_reason" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "voided_by" CHAR(24);
