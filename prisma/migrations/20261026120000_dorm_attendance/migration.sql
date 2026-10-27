-- YOTOQXONA DAVOMATI — "bugun kechqurun yotoqxonada kim qoldi".
--
-- ⚠️ ALOHIDA JADVAL, `student_attendances` ga ustun QO'SHILMAYDI. Dars
-- davomati baho jarimasining maxraji (`education.md` §7), davomat foizi va
-- kechki "kelmadi" job uchun haqiqat manbai; yotoqxona esa butunlay boshqa
-- savol va uni o'sha qatorga yozish tarbiyachining qarorini pul va jarima
-- hisobiga olib kirardi.
--
-- ⚠️ Yotoqxona HAR KUNI ishlaydi (yakshanba, bayram, ta'til oyida ham):
-- jadvalda dars kunlari filtri yo'q va bo'lmaydi.

CREATE TYPE "DormAttendanceStatus" AS ENUM ('present', 'absent', 'excused');

CREATE TABLE "dorm_attendances" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    -- NULL bo'lishi mumkin: yotoqxonada yashash sinf a'zoligiga bog'liq emas
    "class_id" CHAR(24),
    "date" TIMESTAMP(3) NOT NULL,
    "status" "DormAttendanceStatus" NOT NULL,
    "note" TEXT,
    "marked_at" TIMESTAMP(3) NOT NULL,
    "created_by" CHAR(24),
    "last_modified_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dorm_attendances_pkey" PRIMARY KEY ("id")
);

-- Kunlik: bir o'quvchida bir kunda bitta yozuv (upsert kaliti)
CREATE UNIQUE INDEX "dorm_attendances_student_id_date_key"
    ON "dorm_attendances"("student_id", "date");

-- Kunlik ro'yxat va holat filtri
CREATE INDEX "dorm_attendances_date_status_idx"
    ON "dorm_attendances"("date", "status");

-- "Qaysi sinfdan nechta qoldi" kesimi
CREATE INDEX "dorm_attendances_class_id_date_idx"
    ON "dorm_attendances"("class_id", "date");

-- Bitta o'quvchining tarixi (oxirgi kunlar birinchi)
CREATE INDEX "dorm_attendances_student_id_date_idx"
    ON "dorm_attendances"("student_id", "date" DESC);

-- Davomat shu vaqtdan boshlanadi (Toshkent devor-soati). Sozlamada, kodda
-- EMAS: 16:00 — maktabning hozirgi tartibi, qoida emas.
CREATE TABLE "dorm_attendance_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "start_time" TEXT NOT NULL DEFAULT '16:00',
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dorm_attendance_settings_pkey" PRIMARY KEY ("id")
);
