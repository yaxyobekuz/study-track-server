-- FACE ID — YUZ NAMUNALARI, URINISHLAR JURNALI VA SOZLAMA
--
-- To'liq qoida: `.claude/rules/face-id.md`. Eng muhimi:
--
--   KIOSK YANGI DAVOMAT TIZIMI EMAS. U kimligini aniqlaydi, davomatni esa
--   mavjud `attendance.service` / `studentAttendance.service` yozadi.
--   Kechikish, jarima, `checkoutGate` va o'qish davri mantig'ining
--   NUSXASI bu modulda yo'q.
--
-- Kiosk reyestri (`kiosks`) PLATFORMADA, biometrika esa SHU YERDA: odam
-- bilan bir schema'da. Xodim bir nechta filialda ishlasa, uning yuz
-- namunasi HAR FILIALDA alohida ro'yxatga olinadi — `users.permissions`
-- har filialda alohida bo'lgani bilan ayni mulohaza.

CREATE TYPE "FaceSampleSource" AS ENUM ('kiosk', 'panel', 'import');

-- ⚠️ `no_match` va `ambiguous` ALOHIDA. Birinchisi "bazada yo'q"
-- (ro'yxatga olish kerak), ikkinchisi "ikki odamga baravar o'xshadi"
-- (aka-uka, egizak) — qo'lda belgilash kerak. Ikkalasini bitta qiymatga
-- yig'ish "nega ishlamayapti" degan savolni javobsiz qoldirardi.
CREATE TYPE "FaceCheckResult" AS ENUM (
    'marked', 'cooldown', 'already', 'no_match', 'ambiguous', 'spoof',
    'low_quality', 'not_enrolled', 'blocked', 'rejected', 'error'
);

CREATE TYPE "FaceCheckKind" AS ENUM ('checkIn', 'checkOut', 'studentMark', 'enroll', 'unknown');

-- YUZ PROFILI — odamga bitta.
--
-- ⚠️ `face_samples` dan ALOHIDA: odam bir nechta namuna bilan ro'yxatga
-- olinadi (ko'zoynakli/ko'zoynaksiz, yorug'/qorong'i) va taqqoslash
-- ularning ENG YAXSHISI bo'yicha ketadi. Bitta vektor bilan ko'zoynak
-- kiygan odam har kuni "topilmadi" bo'lardi.
CREATE TABLE "face_profiles" (
    "id" CHAR(24) NOT NULL,
    "user_id" CHAR(24) NOT NULL,
    -- Profilni vaqtincha o'chirish — namunani O'CHIRMASDAN ("yuzi
    -- o'zgargan, qayta olish kerak"): namunalar tarixda qoladi,
    -- taqqoslashga esa kirmaydi.
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    -- Denormalizatsiya — ro'yxatni chizishda `_count` so'ramaslik uchun.
    -- Yagona yozuvchi — `faceProfile.service.js` (tranzaksiya ichida).
    "sample_count" INTEGER NOT NULL DEFAULT 0,
    "enrolled_by" CHAR(24),
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- "Bu profil ishlayaptimi" — ro'yxatda "3 oydan beri tanilmagan".
    "last_matched_at" TIMESTAMP(3),
    "last_score" DOUBLE PRECISION,
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "face_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "face_profiles_user_id_key" ON "face_profiles"("user_id");
CREATE INDEX "face_profiles_is_active_idx" ON "face_profiles"("is_active");
CREATE INDEX "face_profiles_enrolled_at_idx" ON "face_profiles"("enrolled_at" DESC);

-- BITTA KADRDAN OLINGAN VEKTOR.
--
-- ⚠️ `embedding` — `Float32Array` ning XOM BAYTLARI (BYTEA), matn yoki
-- JSON massiv EMAS. 1024 o'lchamli vektor JSON'da ~12 KB, baytlarda
-- 4 KB bo'ladi va parse qilish shart emas. `pgvector` ISHLATILMAYDI:
-- u baza kengaytmasiga bog'liqlik qo'shardi, 5000 namunani JS'da
-- taqqoslash esa ~5 ms.
--
-- ⚠️ `model` va `dim` HAR NAMUNADA. Model almashtirilsa eski namunalar
-- taqqoslashga KIRMAYDI (`faceGallery.service.js` filtrlaydi) — jim
-- noto'g'ri natija o'rniga ochiq "qayta ro'yxatdan o'tkazish kerak".
CREATE TABLE "face_samples" (
    "id" CHAR(24) NOT NULL,
    "profile_id" CHAR(24) NOT NULL,
    "embedding" BYTEA NOT NULL,
    "dim" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    -- Detektorning kadrga ishonchi (0..1) — eng yaxshi namunani tanlash
    -- va "sifatsiz namunani almashtir" degan maslahat uchun.
    "quality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    -- Namuna OLINGAN paytdagi tiriklik ballari: keyin chegara oshirilsa,
    -- past tiriklik bilan olingan namunalarni topish mumkin.
    "liveness" DOUBLE PRECISION,
    "antispoof" DOUBLE PRECISION,
    -- ⚠️ IXTIYORIY: `face_settings.store_snapshots` o'chirilgan filialda
    -- rasm saqlanmaydi.
    "snapshot_key" TEXT,
    "snapshot_url" TEXT,
    "source" "FaceSampleSource" NOT NULL DEFAULT 'kiosk',
    -- soft ref -> platform.kiosks (panelda olinsa NULL)
    "kiosk_id" CHAR(24),
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_samples_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "face_samples_profile_id_idx" ON "face_samples"("profile_id");
CREATE INDEX "face_samples_model_dim_idx" ON "face_samples"("model", "dim");

ALTER TABLE "face_samples" ADD CONSTRAINT "face_samples_profile_id_fkey"
    FOREIGN KEY ("profile_id") REFERENCES "face_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- URINISHLAR JURNALI — APPEND-ONLY (`account_entries` uslubi).
--
-- ⚠️ Tahrirlanmaydi va o'chirilmaydi. Muvaffaqiyatsiz urinish ham
-- yoziladi: "nega kiosk meni tanimayapti" va "kim telefondagi rasm bilan
-- o'tishga urindi" degan savollarning javobi aynan shu jadvalda.
CREATE TABLE "face_check_events" (
    "id" CHAR(24) NOT NULL,
    -- soft ref -> platform.kiosks (cross-schema FK yo'q)
    "kiosk_id" CHAR(24),
    "kiosk_name" TEXT,
    -- Kimligi aniqlanmagan urinishda NULL — jurnal shunda ham yoziladi.
    "user_id" CHAR(24),
    -- Odam nomi MUHRLANADI: keyin ismi o'zgarsa yoki hisob o'chirilsa ham
    -- jurnal o'qiladigan bo'lib qolishi kerak.
    "user_name" TEXT,
    "user_role" TEXT,
    "kind" "FaceCheckKind" NOT NULL,
    "result" "FaceCheckResult" NOT NULL,
    -- Chegarani sozlashda shu ustunlardan o'qiladi.
    "score" DOUBLE PRECISION,
    "margin" DOUBLE PRECISION,
    "liveness" DOUBLE PRECISION,
    "antispoof" DOUBLE PRECISION,
    "message" TEXT,
    -- soft ref -> attendances / student_attendances
    "attendance_id" CHAR(24),
    "snapshot_key" TEXT,
    "snapshot_url" TEXT,
    -- Oflayn navbatdan kelganmi — panelda "internetsiz yozilgan" deb
    -- ko'rinadi (qayd vaqti va yuborilgan vaqti farq qiladi).
    "offline" BOOLEAN NOT NULL DEFAULT false,
    -- ⚠️ OFLAYN NAVBAT IDEMPOTENTLIGI. Tarmoq uzilib navbat ikki marta
    -- yuborilsa, ikkinchi qator yozilmaydi va bitta kelish ikki marta
    -- hisoblanmaydi.
    "client_event_id" TEXT NOT NULL,
    -- ⚠️ KIOSKDAGI VAQT — qayd HAQIQATDA bo'lgan payt (oflaynda bu
    -- `created_at` dan soatlar oldin bo'lishi mumkin). Hisobot shu bo'yicha.
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_check_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "face_check_events_client_event_id_key" ON "face_check_events"("client_event_id");
CREATE INDEX "face_check_events_occurred_at_idx" ON "face_check_events"("occurred_at" DESC);
CREATE INDEX "face_check_events_user_id_occurred_at_idx" ON "face_check_events"("user_id", "occurred_at" DESC);
CREATE INDEX "face_check_events_result_occurred_at_idx" ON "face_check_events"("result", "occurred_at" DESC);
CREATE INDEX "face_check_events_kiosk_id_occurred_at_idx" ON "face_check_events"("kiosk_id", "occurred_at" DESC);

-- FACE ID SOZLAMASI — filialga bitta (singleton).
--
-- ⚠️ Chegaralar SOZLAMADA va kodda emas: har kameraning sifati boshqa va
-- "0.62" raqami bitta filialda juda qattiq, boshqasida juda yumshoq bo'lib
-- chiqadi. Default qiymat esa SCHEMA'NING O'ZIDA — yangi filial ochilganda
-- `settings.service.js` dagi getter seed bo'lib ishlaydi.
CREATE TABLE "face_settings" (
    "id" VARCHAR(24) NOT NULL DEFAULT 'singleton',
    "match_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.62,
    -- ⚠️ IKKINCHI SHART — eng yaxshi va IKKINCHI odam natijasi orasidagi
    -- minimal farq. Usiz aka-uka navbatma-navbat bir-birining davomatini
    -- belgilab ketardi. Past bo'lsa javob `ambiguous`.
    "margin_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    -- ⚠️ Kiosk ham tekshiradi, server ham QAYTA tekshiradi: kiosk dasturi
    -- almashtirilgan bo'lishi mumkin.
    "liveness_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "antispoof_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    "min_face_quality" DOUBLE PRECISION NOT NULL DEFAULT 0.55,
    -- Shu oynada ayni odamga ikkinchi amal YOZILMAYDI.
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 90,
    -- Aks holda eshikdan kirib ikkinchi marta turgan xodim darhol
    -- "ketdi" bo'lardi.
    "checkout_min_minutes" INTEGER NOT NULL DEFAULT 60,
    "max_samples_per_person" INTEGER NOT NULL DEFAULT 5,
    -- Ro'yxatga olish taqqoslashdan QATTIQROQ tekshiriladi.
    "duplicate_threshold" DOUBLE PRECISION NOT NULL DEFAULT 0.55,
    "staff_enabled" BOOLEAN NOT NULL DEFAULT true,
    "student_enabled" BOOLEAN NOT NULL DEFAULT true,
    "student_late_grace_minutes" INTEGER NOT NULL DEFAULT 10,
    "store_snapshots" BOOLEAN NOT NULL DEFAULT true,
    "snapshot_retention_days" INTEGER NOT NULL DEFAULT 30,
    -- ⚠️ O'chirilsa kiosk internetsiz ISHLAMAYDI — biometrika qurilmada
    -- yotishini xohlamaydigan filial uchun ataylab qo'yilgan tanlov.
    "offline_gallery_enabled" BOOLEAN NOT NULL DEFAULT true,
    "embedding_model" TEXT NOT NULL DEFAULT 'human/faceres',
    "embedding_dim" INTEGER NOT NULL DEFAULT 1024,
    -- ⚠️ GALEREYA VERSIYASI — kiosk keshini va server keshini bir vaqtda
    -- yangilaydigan YAGONA son. Bir nechta jarayon (PM2 cluster) bo'lsa ham
    -- eskirgan galereya ishlatilmaydi.
    "gallery_version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "face_settings_pkey" PRIMARY KEY ("id")
);
