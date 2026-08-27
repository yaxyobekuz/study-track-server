-- DARS JADVALINI REJALASHTIRISH (preview qatlami) + O'QITUVCHI FANLARI
--
-- Bu migratsiya AMALDAGI jadvalga (schedules / schedule_lessons) TEGMAYDI.
-- U yonida turadigan alohida ish stoli yaratadi:
--
--   user_subjects         → o'qituvchi qaysi fanlardan dars beradi (DOIMIY katalog)
--   planner_loads         → o'qituvchi × fan → haftalik soat
--   planner_load_classes  → o'sha fandan qaysi sinflarga (+ sinfga xos soat)
--   planner_busy_slots    → o'qituvchining band kataklari
--   planner_settings      → shakllantirish qoidalari (singleton)
--   planner_runs          → bitta shakllantirish = bitta VARIANT
--   planner_lessons       → variantdagi darslar
--
-- KIRIM (loads/busy/settings) versiyalanmaydi, NATIJA (runs/lessons)
-- versiyalanadi: o'zgaradigan narsa joylashtirishning o'zi.
--
-- Kun — mavjud "ScheduleDay" enum'i, dars katagi — schedule_settings.periods
-- dagi "order". Ya'ni preview grid amaldagi jadval bilan AYNAN bir xil
-- koordinatada yashaydi va keyinchalik "qo'llash" oddiy ko'chirish bo'ladi.
--
-- Soft ref'lar (teacher_id, subject_id, class_id) uy uslubiga ko'ra FK EMAS —
-- faqat user_subjects junction'i haqiqiy FK ishlatadi (u user_classes ning
-- ko'zgusi va o'chirishda kaskad kerak).

-- 1. O'qituvchi ↔ fan (user_classes ning ko'zgusi)
CREATE TABLE "user_subjects" (
    "user_id"    CHAR(24) NOT NULL,
    "subject_id" CHAR(24) NOT NULL,

    CONSTRAINT "user_subjects_pkey" PRIMARY KEY ("user_id","subject_id")
);

CREATE INDEX "user_subjects_subject_id_idx" ON "user_subjects"("subject_id");

ALTER TABLE "user_subjects"
    ADD CONSTRAINT "user_subjects_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_subjects"
    ADD CONSTRAINT "user_subjects_subject_id_fkey"
    FOREIGN KEY ("subject_id") REFERENCES "subjects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Haftalik yuklama: o'qituvchi × fan
--
-- weekly_hours — HAR BIR SINF uchun standart (4 soat × 3 sinf = 12).
-- Satrning o'zi user_subjects dan chiqadi, bu yerda faqat kiritilgan
-- qiymatlar yotadi: fan vaqtincha olib tashlansa qator yetim qoladi-yu,
-- yo'qolmaydi.
CREATE TABLE "planner_loads" (
    "id"           CHAR(24) NOT NULL,
    "teacher_id"   CHAR(24) NOT NULL,
    "subject_id"   CHAR(24) NOT NULL,
    "weekly_hours" INTEGER NOT NULL DEFAULT 0,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_loads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "planner_loads_teacher_id_subject_id_key"
    ON "planner_loads"("teacher_id","subject_id");
CREATE INDEX "planner_loads_subject_id_idx" ON "planner_loads"("subject_id");

-- 3. Yuklama qaysi sinflarga tegishli
--
-- weekly_hours NULL bo'lsa planner_loads.weekly_hours amal qiladi — ya'ni
-- istisno faqat kerak bo'lgan sinfga yoziladi.
CREATE TABLE "planner_load_classes" (
    "load_id"      CHAR(24) NOT NULL,
    "class_id"     CHAR(24) NOT NULL,
    "weekly_hours" INTEGER,

    CONSTRAINT "planner_load_classes_pkey" PRIMARY KEY ("load_id","class_id")
);

CREATE INDEX "planner_load_classes_class_id_idx" ON "planner_load_classes"("class_id");

ALTER TABLE "planner_load_classes"
    ADD CONSTRAINT "planner_load_classes_load_id_fkey"
    FOREIGN KEY ("load_id") REFERENCES "planner_loads"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Band kataklar — qator BORLIGI = band (bo'sh uchun yozuv saqlanmaydi)
CREATE TABLE "planner_busy_slots" (
    "teacher_id" CHAR(24) NOT NULL,
    "day"        "ScheduleDay" NOT NULL,
    "order"      INTEGER NOT NULL,
    "note"       TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_busy_slots_pkey" PRIMARY KEY ("teacher_id","day","order")
);

CREATE INDEX "planner_busy_slots_day_order_idx" ON "planner_busy_slots"("day","order");

-- 5. Shakllantirish qoidalari (singleton — id doim 'singleton')
--
-- work_days bo'sh massiv = 6 kunning hammasi. "Hech bir kun" holati ma'nosiz,
-- shuning uchun bo'sh qiymat "hammasi" deb o'qiladi va yangi filial darhol
-- ishlaydi.
CREATE TABLE "planner_settings" (
    "id"                      VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "work_days"               TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "max_lessons_per_day"     INTEGER NOT NULL DEFAULT 7,
    "min_lessons_per_day"     INTEGER NOT NULL DEFAULT 0,
    "teacher_max_per_day"     INTEGER NOT NULL DEFAULT 6,
    "allow_class_gaps"        BOOLEAN NOT NULL DEFAULT false,
    "allow_teacher_gaps"      BOOLEAN NOT NULL DEFAULT true,
    "max_same_subject_per_day" INTEGER NOT NULL DEFAULT 2,
    "avoid_consecutive_same"  BOOLEAN NOT NULL DEFAULT true,
    "seed"                    INTEGER NOT NULL DEFAULT 1,
    "updated_by"              CHAR(24),
    "created_at"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_settings_pkey" PRIMARY KEY ("id")
);

-- 6. Variant (bitta shakllantirish)
CREATE TABLE "planner_runs" (
    "id"                CHAR(24) NOT NULL,
    "name"              TEXT NOT NULL,
    "stats"             JSONB NOT NULL DEFAULT '{}',
    "unplaced"          JSONB NOT NULL DEFAULT '[]',
    "settings_snapshot" JSONB NOT NULL DEFAULT '{}',
    "generated_by"      CHAR(24),
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planner_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "planner_runs_created_at_idx" ON "planner_runs"("created_at" DESC);

-- 7. Variantdagi darslar
--
-- (run, class, day, order) UNIQUE — sinf to'qnashuvi STRUKTURAVIY IMKONSIZ.
-- O'qituvchi to'qnashuvi unique bo'la olmaydi (bitta o'qituvchi turli
-- variantlarda turli joyda turadi), shuning uchun u indeks + service
-- tekshiruvi bilan ushlanadi.
CREATE TABLE "planner_lessons" (
    "id"         CHAR(24) NOT NULL,
    "run_id"     CHAR(24) NOT NULL,
    "class_id"   CHAR(24) NOT NULL,
    "day"        "ScheduleDay" NOT NULL,
    "order"      INTEGER NOT NULL,
    "subject_id" CHAR(24) NOT NULL,
    "teacher_id" CHAR(24) NOT NULL,
    "is_pinned"  BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "planner_lessons_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "planner_lessons_run_id_class_id_day_order_key"
    ON "planner_lessons"("run_id","class_id","day","order");
CREATE INDEX "planner_lessons_run_id_teacher_id_day_order_idx"
    ON "planner_lessons"("run_id","teacher_id","day","order");

ALTER TABLE "planner_lessons"
    ADD CONSTRAINT "planner_lessons_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "planner_runs"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
