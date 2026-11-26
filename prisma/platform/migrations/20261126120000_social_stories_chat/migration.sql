-- ISTORIYALAR VA CHAT — platforma qatlami.
--
-- NIMA UCHUN PLATFORMADA: xodim bir nechta filialda ishlaydi va istoriya
-- butun tarmoqqa ko'rinadi (biznes qarori, 2026-11-26). Filial
-- schema'sida yotsa, lenta har filialga alohida so'rov yuborib javoblarni
-- qo'lda birlashtirishga to'g'ri kelardi.
--
-- ⚠️ `user_id` / `author_id` / `sender_id` ustunlari FOREIGN KEY EMAS va
-- bo'la olmaydi: `users` jadvali har FILIAL schema'sida. Bog'lanish kod
-- darajasida — `user_directory` orqali o'qiladi.

-- ─────────────────────────────────────────────────────────────────────
-- PROFIL RASMI — `user_directory` ga denormalizatsiya
-- ─────────────────────────────────────────────────────────────────────
-- Rasm odamning UY filialidagi `users.profile_picture` → `images` da
-- yotadi. Lenta 300 xodimning kartochkasini chizadi: har biri uchun o'z
-- filialining bazasiga borish N+1 so'rov bo'lardi (ustiga boshqa schema).
ALTER TABLE "user_directory" ADD COLUMN "avatar_url" TEXT;
ALTER TABLE "user_directory" ADD COLUMN "avatar_preset" VARCHAR(8);

-- ─────────────────────────────────────────────────────────────────────
-- ENUM lar
-- ─────────────────────────────────────────────────────────────────────
CREATE TYPE "MediaKind" AS ENUM ('image', 'video', 'file', 'voice');
CREATE TYPE "UploadStatus" AS ENUM ('pending', 'ready', 'attached');
CREATE TYPE "ConvType" AS ENUM ('direct', 'group', 'class');
CREATE TYPE "MemberSource" AS ENUM ('manual', 'auto');
CREATE TYPE "MemberRole" AS ENUM ('owner', 'admin', 'member');
CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'video', 'file', 'voice', 'system', 'story_reply');

-- ─────────────────────────────────────────────────────────────────────
-- MEDIA
-- ─────────────────────────────────────────────────────────────────────
-- Katta fayl Node orqali O'TMAYDI: ilova to'g'ridan-to'g'ri Spaces'ga
-- yuklaydi (presigned PUT), server faqat ruxsat beradi va keyin
-- tekshiradi. Jadval yetim fayllarni tozalash uchun ham kerak —
-- Spaces'da nima yotganini bazadan bilmasak, "yuklandi-u biriktirilmadi"
-- fayllarni hech qachon topib bo'lmasdi.
CREATE TABLE "media_upload" (
    "id" CHAR(24) NOT NULL,
    "owner_id" CHAR(24) NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "key" TEXT NOT NULL,
    "thumb_key" TEXT,
    "mime" VARCHAR(80) NOT NULL,
    "size" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "duration_ms" INTEGER,
    "blurhash" VARCHAR(64),
    "status" "UploadStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_upload_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_upload_key_key" ON "media_upload"("key");
-- Tozalash navbati: `pending` yoki `ready` holda qolib ketganlar.
CREATE INDEX "media_upload_status_created_at_idx" ON "media_upload"("status", "created_at");
CREATE INDEX "media_upload_owner_id_created_at_idx" ON "media_upload"("owner_id", "created_at" DESC);

-- ─────────────────────────────────────────────────────────────────────
-- ISTORIYALAR
-- ─────────────────────────────────────────────────────────────────────
-- ⚠️ IKKI UMR, BITTA QATOR: 24 soat lentada (`expires_at`), keyin
-- muallif profilida DOIMIY. Muddat qatorni o'chirmaydi — faqat lentadan
-- chiqaradi. Yo'qotadigan yagona narsa — muallifning o'z qo'li.
--
-- ⚠️ `day_key` TOSHKENT kuni (`created_at` dan hisoblanmaydi): server UTC
-- da yashaydi, ya'ni 00:30 da qo'yilgan istoriya kechagi kunga tushib,
-- odamga 4-chi imkon berib qo'yardi.
CREATE TABLE "story" (
    "id" CHAR(24) NOT NULL,
    "author_id" CHAR(24) NOT NULL,
    "author_branch_id" CHAR(24) NOT NULL,
    "media_id" CHAR(24) NOT NULL,
    "caption" VARCHAR(300),
    "day_key" CHAR(10) NOT NULL,
    "views_count" INTEGER NOT NULL DEFAULT 0,
    "likes_count" INTEGER NOT NULL DEFAULT 0,
    "comments_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" CHAR(24),

    CONSTRAINT "story_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "story_media_id_key" ON "story"("media_id");
CREATE INDEX "story_expires_at_idx" ON "story"("expires_at");
-- Kunlik limit: "bu odam bugun nechta qo'ydi" (o'chirilganlari ham).
CREATE INDEX "story_author_id_day_key_idx" ON "story"("author_id", "day_key");
CREATE INDEX "story_author_id_created_at_idx" ON "story"("author_id", "created_at" DESC);
CREATE INDEX "story_deleted_at_expires_at_idx" ON "story"("deleted_at", "expires_at");

ALTER TABLE "story" ADD CONSTRAINT "story_media_id_fkey"
    FOREIGN KEY ("media_id") REFERENCES "media_upload"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ⚠️ Kompozit PK = BIR ODAM BIR KO'RISH: ilova paketni qayta yuborsa ham
-- sanoqchi ikki marta oshmaydi.
CREATE TABLE "story_view" (
    "story_id" CHAR(24) NOT NULL,
    "viewer_id" CHAR(24) NOT NULL,
    "viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_view_pkey" PRIMARY KEY ("story_id", "viewer_id")
);

CREATE INDEX "story_view_viewer_id_story_id_idx" ON "story_view"("viewer_id", "story_id");
CREATE INDEX "story_view_story_id_viewed_at_idx" ON "story_view"("story_id", "viewed_at" DESC);

ALTER TABLE "story_view" ADD CONSTRAINT "story_view_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_like" (
    "story_id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "emoji" VARCHAR(16) NOT NULL DEFAULT '❤️',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "story_like_pkey" PRIMARY KEY ("story_id", "user_id")
);

CREATE INDEX "story_like_story_id_created_at_idx" ON "story_like"("story_id", "created_at" DESC);

ALTER TABLE "story_like" ADD CONSTRAINT "story_like_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "story_comment" (
    "id" CHAR(24) NOT NULL,
    "story_id" CHAR(24) NOT NULL,
    "author_id" CHAR(24) NOT NULL,
    "text" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),
    "deleted_by" CHAR(24),

    CONSTRAINT "story_comment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "story_comment_story_id_created_at_idx" ON "story_comment"("story_id", "created_at");

ALTER TABLE "story_comment" ADD CONSTRAINT "story_comment_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "story"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- CHAT
-- ─────────────────────────────────────────────────────────────────────
-- ⚠️ `last_seq` — xabar tartib raqami hisoblagichi va u AYNAN shu qatorda
-- turadi: `UPDATE ... SET last_seq = last_seq + 1 RETURNING` bitta
-- qatorli qulf beradi, ya'ni ikki parallel xabar bir xil `seq` olishi
-- strukturaviy imkonsiz. `COUNT(*) + 1` bo'lsa, poyga ikkita 7-xabar
-- yozib, biri yo'qolardi.
CREATE TABLE "conversation" (
    "id" CHAR(24) NOT NULL,
    "type" "ConvType" NOT NULL,
    "direct_key" VARCHAR(49),
    "branch_id" CHAR(24),
    "class_id" CHAR(24),
    "only_staff_post" BOOLEAN NOT NULL DEFAULT false,
    "slow_mode_sec" INTEGER NOT NULL DEFAULT 0,
    "title" VARCHAR(80),
    "avatar_key" TEXT,
    "created_by" CHAR(24) NOT NULL,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMP(3),
    "last_preview" VARCHAR(120),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_pkey" PRIMARY KEY ("id")
);

-- 1:1 suhbat dublikat bo'lmaydi: ikki odam bir vaqtda yozsa ham `upsert`
-- bitta qator beradi.
CREATE UNIQUE INDEX "conversation_direct_key_key" ON "conversation"("direct_key");
-- ⚠️ NULL lar PostgreSQL da bir-biriga TENG EMAS, shuning uchun bu indeks
-- 1:1 va guruh suhbatlarini bloklamaydi — faqat "bitta sinf = bitta
-- guruh" ni kafolatlaydi.
CREATE UNIQUE INDEX "conversation_branch_id_class_id_key" ON "conversation"("branch_id", "class_id");
CREATE INDEX "conversation_last_message_at_idx" ON "conversation"("last_message_at" DESC);
CREATE INDEX "conversation_type_closed_at_idx" ON "conversation"("type", "closed_at");

-- ⚠️ "O'QILDI" — BITTA SON (`last_read_seq`), har xabarga qator EMAS.
-- 10 000 xabarli guruhda 200 a'zo bo'lsa, har xabarga o'qish qatori
-- 2 million qator degani — va bu faqat bitta suhbat.
CREATE TABLE "conversation_member" (
    "conversation_id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "source" "MemberSource" NOT NULL DEFAULT 'manual',
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "last_delivered_seq" INTEGER NOT NULL DEFAULT 0,
    "muted_until" TIMESTAMP(3),
    "post_banned_until" TIMESTAMP(3),
    "post_ban_reason" VARCHAR(300),
    "pinned_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "cleared_seq" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),

    CONSTRAINT "conversation_member_pkey" PRIMARY KEY ("conversation_id", "user_id")
);

CREATE INDEX "conversation_member_user_id_left_at_idx" ON "conversation_member"("user_id", "left_at");
CREATE INDEX "conversation_member_conversation_id_left_at_idx" ON "conversation_member"("conversation_id", "left_at");

ALTER TABLE "conversation_member" ADD CONSTRAINT "conversation_member_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ⚠️ `client_id` — ILOVA yaratgan UUID va u `sender_id` bilan YAGONA:
-- tarmoq uzilib, ilova xabarni qayta yuborsa ikkinchi qator YOZILMAYDI.
-- Usiz "yubordim, ko'rinmadi, yana bosdim" har safar ikkita xabar bo'lardi.
CREATE TABLE "message" (
    "id" CHAR(24) NOT NULL,
    "conversation_id" CHAR(24) NOT NULL,
    "seq" INTEGER NOT NULL,
    "sender_id" CHAR(24) NOT NULL,
    "client_id" VARCHAR(36) NOT NULL,
    "type" "MessageType" NOT NULL,
    "text" VARCHAR(4000),
    "media_id" CHAR(24),
    "reply_to_id" CHAR(24),
    "story_id" CHAR(24),
    "forwarded_from_id" CHAR(24),
    "flagged" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),
    "deleted_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "message_conversation_id_seq_key" ON "message"("conversation_id", "seq");
CREATE UNIQUE INDEX "message_sender_id_client_id_key" ON "message"("sender_id", "client_id");
CREATE INDEX "message_conversation_id_seq_idx" ON "message"("conversation_id", "seq" DESC);
CREATE INDEX "message_conversation_id_created_at_idx" ON "message"("conversation_id", "created_at" DESC);

ALTER TABLE "message" ADD CONSTRAINT "message_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────
-- SHIKOYAT
-- ─────────────────────────────────────────────────────────────────────
-- ⚠️ BIR ODAM BIR NISHONGA BIR MARTA: takroriy bosish moderatorning
-- ro'yxatini bir xil qatorlar bilan to'ldirmasin.
CREATE TABLE "content_report" (
    "id" CHAR(24) NOT NULL,
    "reporter_id" CHAR(24) NOT NULL,
    "target_type" VARCHAR(20) NOT NULL,
    "target_id" CHAR(24) NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" CHAR(24),
    "resolve_note" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "content_report_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "content_report_reporter_id_target_type_target_id_key" ON "content_report"("reporter_id", "target_type", "target_id");
CREATE INDEX "content_report_resolved_at_created_at_idx" ON "content_report"("resolved_at", "created_at" DESC);
CREATE INDEX "content_report_target_type_target_id_idx" ON "content_report"("target_type", "target_id");
