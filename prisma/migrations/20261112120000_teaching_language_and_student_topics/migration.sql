-- ═══════════════════════════════════════════════════════════════════
-- O'QUV TILI, O'QUVCHINING SHAXSIY MAVZU REJASI VA HAR O'QUVCHIGA TEST
-- Biznes qarori, 2026-11-12. Uchta o'zgarish BITTA migratsiyada, chunki
-- ular bir-biriga tayanadi: til mavzular ro'yxatini bo'ladi, shaxsiy reja
-- o'sha ro'yxatdagi o'rinni o'quvchi kesimiga tushiradi, test esa aynan
-- shu o'rindan quriladi.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. O'QUV TILI ──────────────────────────────────────────────────
--
-- Bitta maktabda bir xil fan uch tilda o'qitiladi: 5-sinfda ham o'zbek,
-- ham rus, ham ingliz guruh bo'lishi mumkin va ularning mavzular rejasi
-- BOSHQA (kitob boshqa, tartib boshqa).
--
-- ⚠️ TIL — SINFNING xossasi, FANNING emas. Har til uchun alohida fan
-- ochish ("Matematika (rus)") jurnal, jadval, baho va hisobotlarning
-- HAMMA kesimini uch barobar bo'lib yuborardi.
CREATE TYPE "TeachingLanguage" AS ENUM ('uz', 'ru', 'en');

-- Mavjud sinflar va mavzular `uz` oladi: ular haqiqatan o'zbek tilidagi
-- reja va ularni "noma'lum" qoldirish jadvaldagi mavzuni jimgina
-- yo'qotardi.
ALTER TABLE "classes"
  ADD COLUMN "language" "TeachingLanguage" NOT NULL DEFAULT 'uz';

ALTER TABLE "topics"
  ADD COLUMN "language" "TeachingLanguage" NOT NULL DEFAULT 'uz';

-- ⚠️ YAGONALIK TILNI HAM QAMRAYDI: aks holda bitta fanning rus va ingliz
-- rejasidagi 1-mavzu bir-birini almashtirib yuborardi. Har ro'yxat 1 dan
-- mustaqil raqamlanadi — tartib raqami domenning o'lchovi va ankorlar
-- (`lesson_topic_bindings.topic_order`) aynan unga tayanadi.
DROP INDEX IF EXISTS "topics_subject_id_order_key";
CREATE UNIQUE INDEX "topics_subject_id_language_order_key"
  ON "topics"("subject_id", "language", "order");
CREATE INDEX "topics_subject_id_language_order_idx"
  ON "topics"("subject_id", "language", "order");

-- ── 2. O'QUVCHINING SHAXSIY MAVZU REJASI ───────────────────────────
--
-- Mavzu o'rni SINFGA tegishli edi: butun guruh bitta raqamda turardi.
-- Amalda bolalar boshqa-boshqa tezlikda ketadi — biri bitta darsda uch
-- mavzuni oladi, boshqasi o'rtada qo'shilgani uchun 45-mavzudan
-- boshlaydi. Diagnostikaning asosiy qoidasi ("o'tilmagan mavzudan savol
-- berilmaydi") aynan shu yerda buzilardi.
--
-- Saqlanadigan narsa — ANKOR + QADAM, sinf bilan AYNI doktrina:
--   "16-oktabr, 3-darsda bu bola 50-mavzuda, bitta darsda 3 mavzu"
-- Qolgan hamma dars shundan SANAB chiqariladi (ikkinchi hisob yo'q).
--
-- ⚠️ QATOR BO'LMASA — SINFDAN MEROS (qadam 1). Shuning uchun bu
-- migratsiya BIRORTA qator yozmaydi: butun maktabga qator yozish
-- "shaxsiy reja" tushunchasini ma'nosiz qilardi.
CREATE TABLE "student_topic_plans" (
  "id"           CHAR(24)     NOT NULL,
  "student_id"   CHAR(24)     NOT NULL,
  "subject_id"   CHAR(24)     NOT NULL,
  "class_id"     CHAR(24)     NOT NULL,
  "date"         DATE         NOT NULL,
  "lesson_order" INTEGER      NOT NULL,
  "topic_order"  INTEGER      NOT NULL,
  "step"         INTEGER      NOT NULL DEFAULT 1,
  "start_order"  INTEGER      NOT NULL DEFAULT 1,
  "source"       TEXT         NOT NULL DEFAULT 'manual',
  "note"         TEXT,
  "snapshot"     JSONB        NOT NULL,
  "active_key"   TEXT,
  "batch_id"     CHAR(24),
  "created_by"   CHAR(24)     NOT NULL,
  "revoked_at"   TIMESTAMP(3),
  "revoked_by"   CHAR(24),
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "student_topic_plans_pkey" PRIMARY KEY ("id")
);

-- FAOL qator yagona: parallel ikki so'rov ikkinchi ankorni yoza olmaydi
-- (bekor qilinganda kalit NULL ga tushadi — qayta belgilash mumkin).
CREATE UNIQUE INDEX "student_topic_plans_active_key_key"
  ON "student_topic_plans"("active_key");
CREATE INDEX "student_topic_plans_student_id_subject_id_date_idx"
  ON "student_topic_plans"("student_id", "subject_id", "date");
CREATE INDEX "student_topic_plans_class_id_subject_id_date_idx"
  ON "student_topic_plans"("class_id", "subject_id", "date");
CREATE INDEX "student_topic_plans_batch_id_idx"
  ON "student_topic_plans"("batch_id");

-- ── 3. HAR O'QUVCHIGA O'Z TESTI + TASDIQLASH ───────────────────────
--
-- `per_student` — savollar butun sinfga emas, HAR O'QUVCHIGA uning
-- shaxsiy mavzu oralig'idan tanlanadi.
--
-- `approved_at` / `approved_by` / `review_note` — "filial egasi ko'rib
-- chiqib, keyin chiqariladi". ⚠️ `published_at` BILAN CHALKASHMASIN: u
-- oynaning ochilgan lahzasi, bu esa ODAMNING qarori. Tasdiqsiz test
-- `draft` dan chiqa olmaydi, ya'ni ustun darvozaning O'ZI.
ALTER TABLE "diagnostic_tests"
  ADD COLUMN "per_student" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "language"    VARCHAR(4),
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" CHAR(24),
  ADD COLUMN "review_note" TEXT;

-- ⚠️ MAVJUD TESTLAR TASDIQLANGAN DEB BELGILANADI. Ular allaqachon
-- chiqarilgan (`active`/`scheduled`) yoki admin ularni o'zi
-- chiqaradi — tasdiq darvozasini o'tgan ma'lumotga ORQAGA qo'llash
-- ishlab turgan testlarni jimgina to'xtatib qo'yardi.
UPDATE "diagnostic_tests"
SET "approved_at" = COALESCE("published_at", "created_at")
WHERE "approved_at" IS NULL;

-- Qamrov ham, savollar ham MUHRLANADI: o'quvchi ertaga oldinga ketsa,
-- bugun tasdiqlangan test o'zgarmaydi.
--
-- ⚠️ Qamrov topilmagan o'quvchiga ham qator yoziladi (`status: failed` +
-- sababi): "4 o'quvchidan 3 tasiga test tushdi" degan yarim holat jim
-- qolmasligi kerak.
CREATE TABLE "diagnostic_test_students" (
  "test_id"        CHAR(24)     NOT NULL,
  "student_id"     CHAR(24)     NOT NULL,
  "snapshot"       JSONB        NOT NULL,
  "scope"          JSONB        NOT NULL,
  "question_count" INTEGER      NOT NULL DEFAULT 0,
  "status"         VARCHAR(16)  NOT NULL DEFAULT 'ready',
  "reason"         TEXT,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"     TIMESTAMP(3) NOT NULL,

  CONSTRAINT "diagnostic_test_students_pkey" PRIMARY KEY ("test_id", "student_id")
);

CREATE INDEX "diagnostic_test_students_student_id_idx"
  ON "diagnostic_test_students"("student_id");

ALTER TABLE "diagnostic_test_students"
  ADD CONSTRAINT "diagnostic_test_students_test_id_fkey"
  FOREIGN KEY ("test_id") REFERENCES "diagnostic_tests"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- `row_index` va `difficulty` — SAVOLNI ALMASHTIRISH uchun: o'rniga
-- yozilgan savol AYNI fan, AYNI qiyinlik va AYNI mavzu oralig'idan
-- bo'lishi shart, aks holda "bitta savolni almashtirdim" degan amal
-- testning taqsimotini jimgina buzardi.
CREATE TABLE "diagnostic_test_student_questions" (
  "test_id"     CHAR(24)          NOT NULL,
  "student_id"  CHAR(24)          NOT NULL,
  "question_id" CHAR(24)          NOT NULL,
  "position"    INTEGER           NOT NULL,
  "row_index"   INTEGER           NOT NULL,
  "difficulty"  "DiagnosticLevel" NOT NULL,

  CONSTRAINT "diagnostic_test_student_questions_pkey"
    PRIMARY KEY ("test_id", "student_id", "question_id")
);

CREATE INDEX "diagnostic_test_student_questions_test_id_student_id_positi_idx"
  ON "diagnostic_test_student_questions"("test_id", "student_id", "position");
CREATE INDEX "diagnostic_test_student_questions_question_id_idx"
  ON "diagnostic_test_student_questions"("question_id");

ALTER TABLE "diagnostic_test_student_questions"
  ADD CONSTRAINT "diagnostic_test_student_questions_test_id_student_id_fkey"
  FOREIGN KEY ("test_id", "student_id")
  REFERENCES "diagnostic_test_students"("test_id", "student_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "diagnostic_test_student_questions"
  ADD CONSTRAINT "diagnostic_test_student_questions_question_id_fkey"
  FOREIGN KEY ("question_id") REFERENCES "diagnostic_questions"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
