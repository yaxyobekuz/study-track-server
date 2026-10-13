-- GURUH KUZATUVI — rasmiy guruhlardan kelgan xabarlar va AI signallari.
--
-- Ikki jadval, ikki xil umr:
--
--   group_messages — NAVBAT. Bot rasmiy guruhdan o'qigan xom xabar.
--                    Server har 30 daqiqada tahlil qiladi va KEYIN
--                    O'CHIRADI. Guruh yozishmalari saqlanmaydi.
--
--   group_signals  — NATIJA. AI "bu muammo/taklif/savol" degan xulosa.
--                    Saqlanadi, chunki ma'muriyat u bilan ishlaydi.
--
-- ⚠️ SIGNAL — MUAMMO EMAS. `issues` jadvaliga ataylab tushmaydi: xulosani
-- AI chiqargan va u xato bo'lishi mumkin. Odam kategoriya tanlab
-- "biriktirish" bosgandagina muammo yaratiladi, `issue_id` esa o'sha
-- muammoga ishora bo'lib qoladi.
--
-- ⚠️ `issue_id` + `branch_id` — FOREIGN KEY EMAS va bo'la olmaydi:
-- `issues` har FILIAL schema'sida, bu jadval esa platformada. Bog'lanish
-- kod darajasida o'qiladi (`groupSignal.service.js`).

-- CreateTable
CREATE TABLE "group_messages" (
    "id" CHAR(24) NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "sender_tg_id" TEXT,
    "sender_name" TEXT,
    "text" TEXT NOT NULL,
    "reply_to_text" TEXT,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "analyzed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Bir xabar ikki marta yozilmaydi (bot qayta ishga tushsa ham).
CREATE UNIQUE INDEX "group_messages_chat_id_message_id_key" ON "group_messages"("chat_id", "message_id");

-- CreateIndex
-- Tahlil navbati: tahlil qilinmaganini vaqt bo'yicha olish.
CREATE INDEX "group_messages_analyzed_at_sent_at_idx" ON "group_messages"("analyzed_at", "sent_at");

-- CreateTable
CREATE TABLE "group_signals" (
    "id" CHAR(24) NOT NULL,
    "chat_id" TEXT NOT NULL,
    "message_id" TEXT,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'normal',
    "summary" TEXT NOT NULL,
    "quote" TEXT,
    "sender_tg_id" TEXT,
    "sender_name" TEXT,
    "sent_at" TIMESTAMP(3),
    "message_count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'new',
    "issue_id" CHAR(24),
    "branch_id" CHAR(24),
    "attached_by" CHAR(24),
    "attached_at" TIMESTAMP(3),
    "dismissed_by" CHAR(24),
    "dismissed_at" TIMESTAMP(3),
    "model" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_signals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_signals_status_created_at_idx" ON "group_signals"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "group_signals_chat_id_idx" ON "group_signals"("chat_id");
