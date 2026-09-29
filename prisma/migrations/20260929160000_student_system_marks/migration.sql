-- O'QUVCHI TASHQI TIZIMDA BORMI — ERP va Kundalik.com belgilari.
--
-- ⚠️ Mavjud birorta qator o'zgarmaydi: 1 ta yangi jadval va 1 ta yangi enum.
-- Jadval BO'SH boshlanadi — sukutda hech kim belgilanmagan, ya'ni barcha
-- o'quvchilar ikkala tizimda ham "yo'q" ro'yxatida turadi. Belgini mas'ul
-- xodim panelda qo'yib chiqadi.

-- CreateEnum
CREATE TYPE "ExternalSystem" AS ENUM ('erp', 'kundalik');

-- CreateTable
CREATE TABLE "student_system_marks" (
    "student_id" CHAR(24) NOT NULL,
    "system" "ExternalSystem" NOT NULL,
    "marked_by" CHAR(24) NOT NULL,
    "marked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_system_marks_pkey" PRIMARY KEY ("student_id","system")
);

-- CreateIndex
CREATE INDEX "student_system_marks_system_idx" ON "student_system_marks"("system");

-- AddForeignKey
ALTER TABLE "student_system_marks" ADD CONSTRAINT "student_system_marks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
