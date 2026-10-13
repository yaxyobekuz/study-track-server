-- TELEGRAM GURUHLARI REYESTRI — bot admin bo'lgan guruhlar.
--
-- Telegram Bot API "men qaysi guruhlarda adminman" degan savolga javob
-- beradigan metod bermaydi, shuning uchun ro'yxat bizda to'planadi:
-- bot `my_chat_member` hodisasida (yoki guruhdagi xabarda) qator yozadi.
--
-- `chat_id` — TABIIY kalit (Telegram beradi), shuning uchun CHAR(24)
-- ObjectId emas: bu jadval botning `AUTO_ID_MODELS` ro'yxatida yo'q.
--
-- ⚠️ `social_networks` BILAN ARALASHTIRMANG: u filial schema'sida va
-- monitor ekrani uchun QO'LDA kiritiladigan havolalar; bu — botning
-- haqiqiy a'zoligi va qo'lda to'ldirilmaydi.

-- CreateTable
CREATE TABLE "telegram_groups" (
    "chat_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'group',
    "title" TEXT NOT NULL,
    "username" TEXT,
    "status" TEXT NOT NULL DEFAULT 'member',
    "can_post_messages" BOOLEAN NOT NULL DEFAULT false,
    "can_invite_users" BOOLEAN NOT NULL DEFAULT false,
    "is_official" BOOLEAN NOT NULL DEFAULT false,
    "official_by" CHAR(24),
    "official_at" TIMESTAMP(3),
    "official_branch" CHAR(24),
    "added_by_tg_id" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "telegram_groups_pkey" PRIMARY KEY ("chat_id")
);

-- CreateIndex
CREATE INDEX "telegram_groups_status_idx" ON "telegram_groups"("status");

-- CreateIndex
CREATE INDEX "telegram_groups_is_official_idx" ON "telegram_groups"("is_official");
