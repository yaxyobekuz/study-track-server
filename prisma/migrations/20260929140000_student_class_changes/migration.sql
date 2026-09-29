-- O'QUVCHI SINFI O'ZGARISHI JURNALI — sinfdan chiqarish va boshqa sinfga
-- ko'chirish, majburiy sababi va aktyori bilan.
--
-- ⚠️ Mavjud birorta qator o'zgarmaydi: 1 ta yangi jadval va 2 ta yangi enum.
-- Jurnal BO'SH boshlanadi — oldingi o'zgarishlarning sababi hech qayerda
-- yozilmagan edi, ularni to'qib chiqarib bo'lmaydi.

-- CreateEnum
CREATE TYPE "StudentClassChangeType" AS ENUM ('moved', 'removed');

-- CreateEnum
CREATE TYPE "StudentClassChangeSource" AS ENUM ('profile', 'class_page', 'assistant');

-- CreateTable
CREATE TABLE "student_class_changes" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "type" "StudentClassChangeType" NOT NULL,
    "source" "StudentClassChangeSource" NOT NULL,
    "from_class_ids" TEXT[],
    "from_class_names" TEXT[],
    "to_class_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "to_class_names" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_class_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "student_class_changes_type_created_at_idx" ON "student_class_changes"("type", "created_at");

-- CreateIndex
CREATE INDEX "student_class_changes_student_id_created_at_idx" ON "student_class_changes"("student_id", "created_at");

-- AddForeignKey
ALTER TABLE "student_class_changes" ADD CONSTRAINT "student_class_changes_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

