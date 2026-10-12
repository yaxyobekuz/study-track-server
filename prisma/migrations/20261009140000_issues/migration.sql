-- MUAMMOLAR — xodim/ota-ona botdan muammo yuboradi, ma'muriyat panelda ko'radi.
--
-- Oqim: botda KATEGORIYA tanlanadi (oddiy klaviatura) → matn yoziladi →
-- `issues` ga qator tushadi. Panelda holat o'zgartiriladi va javob yoziladi,
-- javob esa botga qaytadi.
--
-- `issue_categories` — ATAYLAB MINIMAL: nomi va holati. Kategoriya botdagi
-- tugma bo'lib xizmat qiladi, tugmada nomdan boshqa hech narsa ko'rinmaydi.
-- O'chirish YUMSHOQ (`is_active = false`) — arxivdagi muammo kategoriyasiz
-- qolmasligi uchun; shu sababli `issues.category_id` ga RESTRICT qo'yilgan.
--
-- ⚠️ `author_kind` — bog'lanish TURI ("student" | "staff", `tg_users.link_kind`
-- bilan ayni ma'noda), ROL EMAS: "student" da `user_id` o'quvchi, lekin botdan
-- foydalanadigan odam uning OTA-ONASI.
--
-- ⚠️ `chat_id` MUHRLANADI va javob yuborilayotganda `tg_users` dan qayta
-- izlanmaydi: odam bog'lanishni uzgan bo'lishi mumkin, javob esa muammoni
-- YUBORGAN chatga borishi kerak.
--
-- Mavjud jadvallarga tegilmaydi.

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('new', 'in_review', 'resolved', 'rejected');

-- CreateTable
CREATE TABLE "issue_categories" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issue_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issues" (
    "id" CHAR(24) NOT NULL,
    "category_id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "author_kind" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'new',
    "telegram_id" TEXT,
    "chat_id" TEXT,
    "reply" TEXT,
    "reviewed_by" CHAR(24),
    "reviewed_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "issue_categories_is_active_name_idx" ON "issue_categories"("is_active", "name");

-- CreateIndex
CREATE INDEX "issues_status_created_at_idx" ON "issues"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "issues_created_at_idx" ON "issues"("created_at" DESC);

-- CreateIndex
CREATE INDEX "issues_category_id_idx" ON "issues"("category_id");

-- CreateIndex
CREATE INDEX "issues_user_id_idx" ON "issues"("user_id");

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "issue_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
