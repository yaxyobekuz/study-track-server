-- DARS JADVALI QORALAMASI (tugallanmagan tahrirning zaxirasi)
--
-- Jadval SAQLASHDA butunligicha tekshiriladi: o'qituvchi boshqa sinfda o'sha
-- tartibda band bo'lsa, butun hafta rad etiladi. Konfliktni bartaraf qilish
-- uchun boshqa sinf jadvaliga o'tish kerak va shu paytgacha qilingan tahrir
-- brauzer xotirasida yo'q bo'lardi. Qoralama shu bo'shliqni yopadi.
--
-- Har foydalanuvchi O'Z qoralamasi bilan ishlaydi: (class_id, user_id) unique.
-- Ikki xodim bitta sinfni tahrir qilsa bir-birining tugallanmagan ishini
-- ko'rmaydi va bosib ketmaydi.
--
-- base_hash — qoralama olingan paytdagi saqlangan jadvalning imzosi. Qoralama
-- turgan payt jadval boshqa odam tomonidan o'zgartirilsa, tiklashda
-- ogohlantirish beriladi.

CREATE TABLE "schedule_drafts" (
    "id"         CHAR(24) NOT NULL,
    "class_id"   CHAR(24) NOT NULL,
    "user_id"    CHAR(24) NOT NULL,
    "data"       JSONB NOT NULL DEFAULT '{}',
    "base_hash"  VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "schedule_drafts_class_id_user_id_key" ON "schedule_drafts"("class_id", "user_id");

CREATE INDEX "schedule_drafts_user_id_idx" ON "schedule_drafts"("user_id");
