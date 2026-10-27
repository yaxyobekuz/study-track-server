-- FACE ID KIOSKLARI — yuz orqali davomatdan o'tish qurilmalari reyestri.
--
-- NIMA UCHUN PLATFORMADA: kiosk tokeni filial kontekstidan OLDIN
-- tekshiriladi. "Bu qurilma qaysi filialning?" degan savolga javob
-- `user_directory` bilan AYNI mulohaza bilan shu yerda yashaydi — aks holda
-- `middleware/kiosk.middleware.js` qaysi schema'ga borishni bilmasdi.
--
-- Yuz namunalari esa FILIAL schema'sida (`face_profiles` / `face_samples`):
-- biometrika odamning o'zi bilan bir joyda turadi va Chilonzor kioski
-- Yunusobod galereyasini ko'rmaydi (`.claude/rules/face-id.md` §1).

CREATE TYPE "KioskStatus" AS ENUM ('pending', 'active', 'suspended', 'revoked');

-- Kirish eshigidagi kiosk ikkalasini ham, o'qituvchilar xonasidagi faqat
-- xodimni o'tkazadi: bir binoda ikki xil joy, ikki xil siyosat.
CREATE TYPE "KioskMode" AS ENUM ('both', 'staffOnly', 'studentOnly');

CREATE TABLE "kiosks" (
    "id" CHAR(24) NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL DEFAULT '',
    "mode" "KioskMode" NOT NULL DEFAULT 'both',
    "status" "KioskStatus" NOT NULL DEFAULT 'pending',

    -- Bir martalik biriktirish kodi HASH bilan: reyestrdan o'qib kiosk
    -- biriktirib olish mumkin bo'lmasligi kerak. Kod admin panelda FAQAT
    -- bir marta (berilgan paytda) ko'rsatiladi.
    "pairing_code_hash" TEXT,
    "pairing_expires_at" TIMESTAMP(3),
    "paired_at" TIMESTAMP(3),
    "device_uid" TEXT,

    -- ⚠️ TOKEN BEKOR QILISH KALITI. "Bekor qilish" bosilganda raqam oshadi
    -- va chiqarilgan token DARHOL o'ladi (`verifyKioskToken` tekshiradi).
    -- Usiz o'g'irlangan kiosk 365 kun ishlashda davom etardi.
    "token_version" INTEGER NOT NULL DEFAULT 1,
    "token_issued_at" TIMESTAMP(3),

    -- Kiosk ekranidagi "Sozlamalar" shu PIN bilan ochiladi. PBKDF2 —
    -- `helpers/parentalPin.helpers.js` bilan AYNI naqsh: iteratsiya soni
    -- qatorda saqlanadi, shuning uchun chegara oshirilsa eski PIN'lar
    -- tekshirilaveradi.
    "setup_pin_hash" TEXT NOT NULL,
    "setup_pin_salt" TEXT NOT NULL,
    "setup_pin_iterations" INTEGER NOT NULL,
    "setup_pin_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Qurilma holati — heartbeat yozadi.
    "last_seen_at" TIMESTAMP(3),
    "last_ip" TEXT,
    "app_version" TEXT,
    "os_version" TEXT,
    "camera_label" TEXT,
    -- Oflayn navbatda qolgan qayd soni — panelda "12 qayd yuborilmagan"
    "pending_count" INTEGER NOT NULL DEFAULT 0,

    "check_count" INTEGER NOT NULL DEFAULT 0,
    "last_check_at" TIMESTAMP(3),

    "note" TEXT NOT NULL DEFAULT '',
    -- "Nega ishlamayapti" degan savolga javob reyestrda turadi, log faylida emas.
    "status_reason" TEXT,

    "created_by" CHAR(24),
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "kiosks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "kiosks_branch_id_status_idx" ON "kiosks"("branch_id", "status");
-- ⚠️ YAGONA EMAS: bitta kompyuterga ikki kiosk profili (test va ish)
-- biriktirilishi mumkin — bu odatda xato, lekin ro'yxatda ko'rinib turadi.
CREATE INDEX "kiosks_device_uid_idx" ON "kiosks"("device_uid");
CREATE INDEX "kiosks_status_last_seen_at_idx" ON "kiosks"("status", "last_seen_at" DESC);

-- RESTRICT — filial ortida kiosklar qolgan bo'lsa o'chirilmaydi (filial
-- baribir hech qachon o'chirilmaydi, arxivlanadi).
ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
