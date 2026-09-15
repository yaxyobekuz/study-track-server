-- AI YORDAMCHI (faqat tizim egasi): suhbatlar, xabarlar, ovozli xabarlar
-- va model taklif qilgan amallar.
--
-- ⚠️ Filial schema'sida: suhbat va undagi amallar ega turgan filialga
-- tegishli, boshqa filialda ular umuman ko'rinmaydi.
-- Mavjud ma'lumotga TEGILMAYDI — faqat yangi jadvallar.

-- Tur tekshiruvi `current_schema()` bilan cheklanadi: `pg_type` butun bazaga
-- umumiy, cheklanmasa ikkinchi filialda tur yaratilmay qolardi
-- (`20260906090000_academic_dashboard` dagi izohga qarang).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AiMessageRole' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "AiMessageRole" AS ENUM ('user', 'assistant');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AiInputMode' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "AiInputMode" AS ENUM ('text', 'voice');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AiMessageStatus' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "AiMessageStatus" AS ENUM ('complete', 'error', 'interrupted');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'AiActionStatus' AND n.nspname = current_schema()
  ) THEN
    CREATE TYPE "AiActionStatus" AS ENUM ('pending', 'executing', 'succeeded', 'failed', 'rejected', 'expired');
  END IF;
END
$$;

-- Suhbatlar (yumshoq o'chirish)
CREATE TABLE IF NOT EXISTS "ai_conversations" (
  "id"              CHAR(24)     NOT NULL,
  "owner_id"        CHAR(24)     NOT NULL,
  "title"           VARCHAR(120) NOT NULL,
  "active_toolsets" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "message_count"   INTEGER      NOT NULL DEFAULT 0,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at"      TIMESTAMP(3),
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_conversations_owner_id_deleted_at_last_message_at_idx"
  ON "ai_conversations"("owner_id", "deleted_at", "last_message_at" DESC);

-- Xabarlar
CREATE TABLE IF NOT EXISTS "ai_messages" (
  "id"                CHAR(24)          NOT NULL,
  "conversation_id"   CHAR(24)          NOT NULL,
  "role"              "AiMessageRole"   NOT NULL,
  "content"           TEXT              NOT NULL,
  "input_mode"        "AiInputMode"     NOT NULL DEFAULT 'text',
  "audio_duration_ms" INTEGER,
  "steps"             JSONB,
  "status"            "AiMessageStatus" NOT NULL DEFAULT 'complete',
  "error_message"     TEXT,
  "model"             VARCHAR(60),
  "prompt_tokens"     INTEGER,
  "completion_tokens" INTEGER,
  "created_at"        TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_messages_conversation_id_created_at_idx"
  ON "ai_messages"("conversation_id", "created_at");

-- Ovozli xabarlar: fayl Spaces'da MAXFIY (ACL private), bu yerda faqat kaliti
CREATE TABLE IF NOT EXISTS "ai_voice_clips" (
  "id"          CHAR(24)     NOT NULL,
  "message_id"  CHAR(24)     NOT NULL,
  "mime_type"   VARCHAR(60)  NOT NULL,
  "size_bytes"  INTEGER      NOT NULL,
  "duration_ms" INTEGER,
  "storage_key" VARCHAR(255) NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_voice_clips_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ai_voice_clips_message_id_key"
  ON "ai_voice_clips"("message_id");

-- Model taklif qilgan amallar (audit izi)
CREATE TABLE IF NOT EXISTS "ai_actions" (
  "id"              CHAR(24)         NOT NULL,
  "conversation_id" CHAR(24)         NOT NULL,
  "message_id"      CHAR(24),
  "owner_id"        CHAR(24)         NOT NULL,
  "type"            VARCHAR(80)      NOT NULL,
  "tool_name"       VARCHAR(64)      NOT NULL,
  "title"           VARCHAR(160)     NOT NULL,
  "risk"            VARCHAR(16)      NOT NULL,
  "permission"      VARCHAR(80),
  "args"            JSONB            NOT NULL,
  "params"          JSONB            NOT NULL,
  "preview"         JSONB            NOT NULL,
  "fingerprint"     VARCHAR(64)      NOT NULL,
  "status"          "AiActionStatus" NOT NULL DEFAULT 'pending',
  "result"          JSONB,
  "error_message"   TEXT,
  "expires_at"      TIMESTAMP(3)     NOT NULL,
  "decided_at"      TIMESTAMP(3),
  "executed_at"     TIMESTAMP(3),
  "created_at"      TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3)     NOT NULL,

  CONSTRAINT "ai_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ai_actions_conversation_id_created_at_idx"
  ON "ai_actions"("conversation_id", "created_at");
CREATE INDEX IF NOT EXISTS "ai_actions_owner_id_status_created_at_idx"
  ON "ai_actions"("owner_id", "status", "created_at" DESC);

-- Tashqi kalitlar (qayta ishga tushirishda `duplicate_object` jim o'tadi)
DO $$ BEGIN
  ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_voice_clips" ADD CONSTRAINT "ai_voice_clips_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "ai_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
