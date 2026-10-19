-- SERTIFIKAT REJALARI
--
-- "Kim qaysi sertifikatni qachon topshirmoqchi" — o'quvchining O'Z
-- deklaratsiyasi (Google Forms javoblari platformaga yuklanadi yoki qo'lda
-- kiritiladi). Baho ham, imtihon natijasi ham EMAS: faqat reja va muddat.
--
-- Ikki jadval, chunki ikki xil savol: katalog ("qaysi yo'nalishlar bor") va
-- fakt ("bu o'quvchi qachon topshiradi").

CREATE TYPE "CertificatePlanStatus" AS ENUM ('planned', 'passed', 'cancelled', 'superseded');

-- YO'NALISHLAR KATALOGI.
--
-- Yo'nalish maktab fani bo'lishi SHART EMAS: IELTS/CEFR/SAT — tashqi
-- imtihonlar. `subject_id` IXTIYORIY va u mavzu progressining yagona
-- manbai: bog'lanmagan yo'nalishda ekranda "mavzu ro'yxati bog'lanmagan"
-- deb turadi, soxta foiz chiqarilmaydi.
CREATE TABLE "certificate_tracks" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "subject_id" CHAR(24),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_tracks_pkey" PRIMARY KEY ("id")
);

-- O'QUVCHINING REJASI — bitta yo'nalish, bitta muddat.
--
-- Formada "1-fan" va "2-fan" ustunlari bor, lekin bu formaning cheklovi:
-- import har ustunni ALOHIDA qator qiladi. Uchinchi sertifikat qo'shilsa
-- statistika, progress va o'quvchi ekranini qayta yozish kerak bo'lmaydi.
CREATE TABLE "certificate_plans" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "track_id" CHAR(24) NOT NULL,
    -- Muddat KUN aniqligida (faqat `getUTC*`). NULL — "aniq sanani
    -- bilmayman" degan javob: bu HOLAT, bo'shliq emas.
    "due_date" DATE,
    "status" "CertificatePlanStatus" NOT NULL DEFAULT 'planned',
    -- Forma to'ldirilgan ON. Faqat ADMIN ko'radi; o'quvchi ekraniga
    -- chiqmaydi. INSTANT, `DATE` emas: "oxirgisi yutadi" qarori soat-daqiqa
    -- aniqligida (bitta kunda ikki marta to'ldirilgan).
    "submitted_at" TIMESTAMP(3),
    "note" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    -- Importdagi xom qiymatlar — MOSLASHTIRISH XOTIRASI: keyingi import
    -- xato yozilgan ismni shu ustundan topib o'quvchini qayta so'ramaydi.
    -- Alohida moslashtirish jadvali shu sababdan yo'q.
    "source_name" TEXT,
    "source_group" TEXT,
    "active_key" TEXT,
    "passed_at" TIMESTAMP(3),
    "passed_by" CHAR(24),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by" CHAR(24),
    "cancel_reason" TEXT,
    "superseded_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "certificate_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "certificate_tracks_name_key" ON "certificate_tracks"("name");

CREATE INDEX "certificate_tracks_subject_id_idx" ON "certificate_tracks"("subject_id");

CREATE INDEX "certificate_tracks_is_active_name_idx" ON "certificate_tracks"("is_active", "name");

-- HAR (o'quvchi + yo'nalish) uchun BITTA FAOL reja. Almashtirilgan/bekor
-- qilingan qatorda `active_key` NULL ga tushadi va PostgreSQL da NULL lar
-- teng emas — tarix cheklanmaydi (`lesson_topic_bindings.active_key` bilan
-- AYNI yechim).
CREATE UNIQUE INDEX "certificate_plans_active_key_key" ON "certificate_plans"("active_key");

CREATE INDEX "certificate_plans_student_id_status_idx" ON "certificate_plans"("student_id", "status");

CREATE INDEX "certificate_plans_track_id_status_idx" ON "certificate_plans"("track_id", "status");

CREATE INDEX "certificate_plans_status_due_date_idx" ON "certificate_plans"("status", "due_date");

CREATE INDEX "certificate_plans_source_name_idx" ON "certificate_plans"("source_name");

-- IMPORT IDEMPOTENTLIGI: forma timestamp'i tashqi tizimdagi yagona kalit,
-- ya'ni AYNI faylni ikki marta yuklash ikkinchi qator yozmaydi. Qo'lda
-- kiritilganda `submitted_at` NULL bo'ladi va NULL lar teng emasligi uchun
-- bu shart qo'lda kiritishni TO'SMAYDI.
CREATE UNIQUE INDEX "certificate_plans_student_id_track_id_submitted_at_key" ON "certificate_plans"("student_id", "track_id", "submitted_at");

-- Fan o'chirilsa yo'nalish QOLADI (unga rejalar ishora qiladi), faqat
-- progress yo'qoladi.
ALTER TABLE "certificate_tracks" ADD CONSTRAINT "certificate_tracks_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Rejasi bor yo'nalish o'chirilmaydi — arxivlanadi.
ALTER TABLE "certificate_plans" ADD CONSTRAINT "certificate_plans_track_id_fkey" FOREIGN KEY ("track_id") REFERENCES "certificate_tracks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
