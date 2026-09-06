-- XAVFSIZLIK — PLATFORMA schema'sida uchta yangi jadval.
--
-- ⚠️ NIMA UCHUN PLATFORMADA:
--   1. Mavjud bo'lmagan login bilan urinishda FILIAL KONTEKSTI YO'Q —
--      filial jadvaliga yozib bo'lmasdi va aynan eng qimmatli hodisa
--      (noma'lum nom bilan brute-force) yozilmay qolardi.
--   2. Xodim bir nechta filialda ishlaydi; "bitta hisobda ikkita seans"
--      qoidasi filial ichida ikki seansni ko'ra olmasdi.
--   3. Odam — global tushuncha, filial esa uning ish joyi.
--
-- Ko'rish huquqi baribir `branch_id` bo'yicha chegaralanadi.
-- Mavjud birorta jadval o'zgarmaydi.

-- ─────────────────────────────────────────────
-- 1. ENUM'lar
-- ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "SessionChannel" AS ENUM ('bot', 'admin', 'teacher', 'student', 'reception', 'worker');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SessionEndReason" AS ENUM ('active', 'logout', 'revoked', 'expired', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SecurityAlertType" AS ENUM ('concurrent_session', 'new_device', 'new_ip', 'brute_force', 'rapid_switch', 'night_login', 'dormant_login');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SecurityAlertSeverity" AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SecurityAlertStatus" AS ENUM ('open', 'acknowledged', 'resolved');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────
-- 2. KIRISH SEANSI
-- ─────────────────────────────────────────────
-- ⚠️ `jti` UNIKAL: token bilan seansni bog'laydigan yagona ip. Usiz
-- "seansni tugat" tugmasi faqat ro'yxatdan qatorni o'chirgan bo'lardi.
-- ⚠️ `user_id` ga FK YO'Q — u boshqa schema'dagi (`public`/`br_*`) jadvalga
-- ishora qiladi. `branch_id` ga esa FK bor.
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "id"           CHAR(24)           NOT NULL,
  "user_id"      CHAR(24)           NOT NULL,
  "username"     VARCHAR(120)       NOT NULL DEFAULT '',
  "branch_id"    CHAR(24)           NOT NULL,
  "jti"          VARCHAR(32)        NOT NULL,
  "channel"      "SessionChannel"   NOT NULL DEFAULT 'admin',
  "ip"           VARCHAR(45),
  "user_agent"   VARCHAR(400),
  "device"       VARCHAR(120),
  "created_at"   TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   TIMESTAMP(3)       NOT NULL,
  "ended_at"     TIMESTAMP(3),
  "end_reason"   "SessionEndReason" NOT NULL DEFAULT 'active',
  "ended_by"     CHAR(24),

  CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_jti_key"              ON "user_sessions"("jti");
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_created_at_idx"      ON "user_sessions"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "user_sessions_branch_reason_seen_idx"      ON "user_sessions"("branch_id", "end_reason", "last_seen_at" DESC);
CREATE INDEX IF NOT EXISTS "user_sessions_end_reason_expires_idx"      ON "user_sessions"("end_reason", "expires_at");
CREATE INDEX IF NOT EXISTS "user_sessions_created_at_idx"              ON "user_sessions"("created_at" DESC);

DO $$ BEGIN
  ALTER TABLE "user_sessions"
    ADD CONSTRAINT "user_sessions_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────
-- 3. KIRISH URINISHI
-- ─────────────────────────────────────────────
-- ⚠️ Muvaffaqiyatli va muvaffaqiyatsiz urinish BITTA jadvalda: "14 marta
-- xato, 15-chisi o'tdi" ketma-ketligi faqat shundagina ko'rinadi.
-- ⚠️ `branch_id` NULL bo'lishi mumkin — noma'lum login bilan kelgan
-- urinishda hech qanday filial yo'q va uni taxmin qilish yolg'on bo'lardi.
-- ⚠️ Parol hech qachon yozilmaydi.
CREATE TABLE IF NOT EXISTS "login_attempts" (
  "id"         CHAR(24)         NOT NULL,
  "username"   VARCHAR(120)     NOT NULL,
  "user_id"    CHAR(24),
  "branch_id"  CHAR(24),
  "success"    BOOLEAN          NOT NULL,
  "reason"     VARCHAR(24)      NOT NULL DEFAULT 'ok',
  "channel"    "SessionChannel" NOT NULL DEFAULT 'admin',
  "ip"         VARCHAR(45),
  "user_agent" VARCHAR(400),
  "device"     VARCHAR(120),
  "created_at" TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "day"        DATE             NOT NULL,

  CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "login_attempts_day_success_idx"      ON "login_attempts"("day", "success");
CREATE INDEX IF NOT EXISTS "login_attempts_branch_created_idx"   ON "login_attempts"("branch_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "login_attempts_username_created_idx" ON "login_attempts"("username", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "login_attempts_user_id_created_idx"  ON "login_attempts"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "login_attempts_ip_created_idx"       ON "login_attempts"("ip", "created_at" DESC);

-- ─────────────────────────────────────────────
-- 4. XAVFSIZLIK OGOHLANTIRISHI
-- ─────────────────────────────────────────────
-- ⚠️ `dedupe_key` UNIKAL: bitta hodisa — bitta qator, `hit_count` o'sadi.
-- Aks holda ekran bitta muammoning nusxalari bilan to'lib ketardi va
-- ikkinchi, haqiqiy muammo ko'rinmay qolardi.
CREATE TABLE IF NOT EXISTS "security_alerts" (
  "id"              CHAR(24)                NOT NULL,
  "type"            "SecurityAlertType"     NOT NULL,
  "severity"        "SecurityAlertSeverity" NOT NULL DEFAULT 'medium',
  "status"          "SecurityAlertStatus"   NOT NULL DEFAULT 'open',
  "user_id"         CHAR(24),
  "username"        VARCHAR(120)            NOT NULL DEFAULT '',
  "branch_id"       CHAR(24),
  "session_id"      CHAR(24),
  "dedupe_key"      VARCHAR(140)            NOT NULL,
  "title"           VARCHAR(160)            NOT NULL,
  "detail"          TEXT                    NOT NULL DEFAULT '',
  "meta"            JSONB,
  "hit_count"       INTEGER                 NOT NULL DEFAULT 1,
  "first_seen_at"   TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at"    TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "day"             DATE                    NOT NULL,
  "acknowledged_by" CHAR(24),
  "acknowledged_at" TIMESTAMP(3),
  "resolved_at"     TIMESTAMP(3),
  "note"            TEXT                    NOT NULL DEFAULT '',

  CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "security_alerts_dedupe_key_key"    ON "security_alerts"("dedupe_key");
CREATE INDEX IF NOT EXISTS "security_alerts_status_severity_seen_idx" ON "security_alerts"("status", "severity", "last_seen_at" DESC);
CREATE INDEX IF NOT EXISTS "security_alerts_branch_status_seen_idx"   ON "security_alerts"("branch_id", "status", "last_seen_at" DESC);
CREATE INDEX IF NOT EXISTS "security_alerts_user_id_last_seen_idx"    ON "security_alerts"("user_id", "last_seen_at" DESC);
CREATE INDEX IF NOT EXISTS "security_alerts_day_type_idx"             ON "security_alerts"("day", "type");
