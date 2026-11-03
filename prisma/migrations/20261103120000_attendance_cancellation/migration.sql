-- XODIM DAVOMATINI BEKOR QILISH JURNALI.
--
-- ⚠️ Davomat qatori O'CHIRILADI, "bekor qilindi" degan YANGI HOLAT
-- qo'shilmaydi: unday holatni davomat foizi, kelmagan kun ayirmasi, kechki
-- "kelmadi" passi, baho darvozasi, hisobot va eksportlar — hammasi alohida
-- o'rganishi kerak bo'lardi va bittasi uni "kelmadi" deb o'qib qolardi.
-- Qator o'chirilgach kun HAQIQATAN belgilanmagan bo'ladi, ya'ni mavjud
-- o'quvchilarning birortasiga tegilmaydi.
--
-- Fakt esa yo'qolmaydi: o'chirilgan qatorning to'liq nusxasi, sababi va
-- aktyori shu jadvalda qoladi (append-only).
--
-- ⚠️ Bu qator KECHKI PASS UCHUN QALQON ham: `attendanceAbsent.job.js` shu
-- kuni bekor qilingan xodimni "kelmadi" deb qayta yozmaydi — aks holda
-- kunduzi bekor qilingan davomat 23:45 da jarimasi bilan qaytib kelardi.

CREATE TABLE "attendance_cancellations" (
    "id" CHAR(24) NOT NULL,
    -- soft ref → users (FK yo'q, `attendances` bilan AYNI qoida)
    "user_id" CHAR(24) NOT NULL,
    -- Toshkent kunining UTC yarim tuni
    "date" TIMESTAMP(3) NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "check_in" TIMESTAMP(3),
    "check_out" TIMESTAMP(3),
    -- O'chirilgan qatorning TO'LIQ nusxasi
    "snapshot" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    -- Bekor qilish bilan birga qaytarilgan davomat jarimasi (bo'lsa)
    "penalty_ref" CHAR(24),
    "penalty_points" INTEGER NOT NULL DEFAULT 0,
    "cancelled_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attendance_cancellations_pkey" PRIMARY KEY ("id")
);

-- Kechki passning qalqon tekshiruvi va xodim kesimi
CREATE INDEX "attendance_cancellations_user_id_date_idx"
    ON "attendance_cancellations"("user_id", "date");

-- Kunlik ro'yxat: "bu qator nega bo'sh" degan savolga javob
CREATE INDEX "attendance_cancellations_date_idx" ON "attendance_cancellations"("date");

CREATE INDEX "attendance_cancellations_created_at_idx"
    ON "attendance_cancellations"("created_at" DESC);
