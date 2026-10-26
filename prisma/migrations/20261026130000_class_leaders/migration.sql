-- SINF RAHBARI — xodimga sinf biriktirish.
--
-- Bitta vazifasi bor: shu sinfning KUNLIK davomatini belgilash huquqi. Huquq
-- ruxsat kalitidan emas, BIRIKTIRISHDAN keladi (`/tutor-groups/my` bilan AYNI
-- qoida) va har so'rovda qayta hisoblanadi.
--
-- ⚠️ `tutor_groups` NING PULSIZ KO'ZGUSI, lekin NUSXASI EMAS: u yerda
-- stavkalar va DAVR bor, chunki summa oylik majburiyatiga muhrlanadi va
-- o'tgan oylar eski summada qolishi kerak. Bu yerda pul yo'q, ya'ni
-- muhrlanadigan fakt ham yo'q — davr ustunlari qo'shilsa, ular hech narsani
-- himoya qilmasdi va "qaysi oydan" degan savol har ekranga bekordan-bekor
-- chiqib turardi.
--
-- ⚠️ BIR SINFGA BITTA RAHBAR — unique indeks. Tyutorda bu advisory lock
-- ichida tekshiriladi (davr kesishuvini indeks bilan ifodalab bo'lmaydi), bu
-- yerda esa indeksning O'ZI kafolat beradi: ikki parallel so'rov bitta sinfni
-- ikki kishiga yoza OLMAYDI.

CREATE TABLE "class_leaders" (
    "id" CHAR(24) NOT NULL,
    -- soft ref → users (FK yo'q): xodim arxivlansa ham qator qoladi va
    -- ro'yxatda "arxivlangan" bo'lib ko'rinadi (`tutor_groups` bilan AYNI)
    "leader_id" CHAR(24) NOT NULL,
    "class_id" CHAR(24) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "class_leaders_pkey" PRIMARY KEY ("id")
);

-- BIR SINFGA BITTA RAHBAR
CREATE UNIQUE INDEX "class_leaders_class_id_key" ON "class_leaders"("class_id");

-- "Bu xodim qaysi sinflarga rahbar" — davomat darvozasining har so'rovdagi yo'li
CREATE INDEX "class_leaders_leader_id_idx" ON "class_leaders"("leader_id");

-- Restrict: sinf o'chirilishidan oldin service tushunarli xato beradi
ALTER TABLE "class_leaders" ADD CONSTRAINT "class_leaders_class_id_fkey"
    FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
