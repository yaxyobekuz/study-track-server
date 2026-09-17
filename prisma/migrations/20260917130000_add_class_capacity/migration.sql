-- SINF SIG'IMI.
--
-- `classes.capacity` — sinfga sig'adigan o'quvchilar soni (admin belgilaydi,
-- ixtiyoriy). null → belgilanmagan. Moliya dashboardidagi sinflar jadvalida
-- "ortiqcha (bo'sh) joy" = capacity − joriy o'quvchilar soni.

-- AlterTable
ALTER TABLE "classes" ADD COLUMN     "capacity" INTEGER;
