-- TANGA CHEKLOVI — qarzdor o'quvchiga tanga berilmaydi.
--
-- Biznes qarori (2026-11-04): oylik to'lovini to'lamagan o'quvchi tanga
-- olmaydi — na kunlik baho uchun, na haftalik reyting bonusi, na test
-- mavsumi mukofoti, na qo'lda berilgan tanga. Cheklov QO'LDA qo'yiladi va
-- QO'LDA olinadi (`coins.block`): qarzdorlar registri faqat tanlov
-- ro'yxatini beradi, qarorni odam qabul qiladi.
--
-- ⚠️ BIR O'QUVCHIDA BITTA FAOL CHEKLOV — `active_key` unique indeksi
-- kafolatlaydi (`class_leaders` doktrinasi): ikki parallel so'rov bitta
-- o'quvchiga ikki faol qator yoza OLMAYDI. Bekor qilinganda kalit NULL ga
-- tushadi va qator tarix bo'lib qoladi (o'chirilmaydi).
--
-- ⚠️ FK YO'Q (soft ref → users): o'quvchi arxivlansa ham cheklov tarixi
-- registrda o'qilishi kerak (`lesson_credits` bilan AYNI sabab).

CREATE TABLE "student_coin_blocks" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    -- bir amalda cheklanganlar guruhi: ommaviy tanlov bitta qarordir
    "batch_id" CHAR(24) NOT NULL,
    -- faol bo'lsa student_id, bekor qilinsa NULL
    -- ⚠️ TEXT, CHAR(24) EMAS (`lesson_credits.active_key` bilan AYNI):
    -- CHAR bo'shliq bilan to'ldiriladi va unique indeksda taqqoslash
    -- semantikasi o'zgarib ketardi
    "active_key" TEXT,
    "reason" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    -- cheklash paytidagi qarz: TUSHUNTIRISH, ikkinchi haqiqat manbai emas
    "debt_snapshot" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "debt_month_count" INTEGER NOT NULL DEFAULT 0,
    "oldest_debt_month" INTEGER,
    -- { fullName, username, className } — qayta nomlangandan keyin ham o'qiladi
    "snapshot" JSONB NOT NULL,
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" CHAR(24),
    "revoke_reason" TEXT NOT NULL DEFAULT '',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_coin_blocks_pkey" PRIMARY KEY ("id")
);

-- BITTA FAOL CHEKLOV (poyga strukturaviy imkonsiz)
CREATE UNIQUE INDEX "student_coin_blocks_active_key_key" ON "student_coin_blocks"("active_key");

-- Darvoza: "shu o'quvchilar O'SHA PAYTDA cheklangan edimi" (kunlik pass
-- o'tgan kun uchun ham ishlaydi — `coinBlock.service.js` dagi `at`)
CREATE INDEX "student_coin_blocks_student_id_created_at_idx" ON "student_coin_blocks"("student_id", "created_at");
CREATE INDEX "student_coin_blocks_revoked_at_idx" ON "student_coin_blocks"("revoked_at");
CREATE INDEX "student_coin_blocks_batch_id_idx" ON "student_coin_blocks"("batch_id");
CREATE INDEX "student_coin_blocks_created_at_idx" ON "student_coin_blocks"("created_at" DESC);
