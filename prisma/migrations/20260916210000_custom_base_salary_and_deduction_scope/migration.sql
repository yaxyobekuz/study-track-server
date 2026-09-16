-- SHAXSIY MAOSH VA "HAMMAGA" USHLAB QOLISH.
--
-- `users.custom_base_salary` — lavozim qoladi, lekin maosh lavozimdan emas,
-- shu summadan olinadi (null → lavozim maoshi).
--
-- `payroll_deductions.applies_to_all` — "Hammasi" tanlab yozilgan guruh keyin
-- oyligi belgilangan xodimlarga ham yoyiladi. Eski qatorlarda false: ular
-- qanday tanlab yozilgani saqlanmagan, admin paneldagi tugma bilan yoqiladi.
--
-- `(batch_id, staff_id)` yagona: bir guruhda bir odamga bitta qator (yaratish
-- ro'yxatni `Set` bilan oladi, shuning uchun mavjud ma'lumotda takror yo'q).
-- Parallel yoyish ikkinchi qator yoza olmasin.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "custom_base_salary" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "payroll_deductions" ADD COLUMN     "applies_to_all" BOOLEAN NOT NULL DEFAULT false;

-- DropIndex
DROP INDEX "payroll_deductions_batch_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "payroll_deductions_batch_id_staff_id_key" ON "payroll_deductions"("batch_id", "staff_id");

-- CreateIndex
CREATE INDEX "payroll_deductions_applies_to_all_status_idx" ON "payroll_deductions"("applies_to_all", "status");
