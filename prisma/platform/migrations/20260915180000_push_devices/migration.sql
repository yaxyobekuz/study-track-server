-- MOBIL PUSH: FCM qurilma tokenlari.
--
-- ⚠️ NIMA UCHUN: xodimga topshiriq yuborilganda va u rad etilgan /
-- to'xtatilgan / muvaffaqiyatli yakunlanganda mobil ilovaga bildirishnoma
-- borishi kerak. Buning uchun server qaysi telefon kimniki ekanini bilishi
-- shart — mobil ilova login qilgach tokenini shu jadvalga yozadi.
--
-- Yangi jadval, mavjud birorta qatorga tegilmaydi.

CREATE TABLE IF NOT EXISTS "push_devices" (
    "id" CHAR(24) NOT NULL,
    "token" VARCHAR(512) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "jti" VARCHAR(32),
    "platform" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_devices_token_key" ON "push_devices"("token");
CREATE INDEX IF NOT EXISTS "push_devices_user_id_idx" ON "push_devices"("user_id");
CREATE INDEX IF NOT EXISTS "push_devices_jti_idx" ON "push_devices"("jti");
