-- XATLOVGA JIHOZ KIRITISHDA RASM (dalil).
--
-- Rasm MIQDOR DAFTARI qatoriga biriktiriladi, xatlov qatoriga
-- (`inventory_stocks`) EMAS: xatlov qatori hodisalarning YIG'INDISI
-- ("hozir 20 ta parta bor") va uning sanasi yo'q, rasm esa bitta ONGA
-- tegishli. Yig'indiga biriktirilsa, keyingi har bir kirim eski rasmni
-- "hozirgi holat" qilib ko'rsatardi.
--
-- Shakli `inventory_damages.attachments` bilan AYNI:
-- [{ key, url, type, originalName, sizeBytes }] — yagona yuklovchi
-- `file.service.js`. Eski qatorlar bo'sh massiv bilan qoladi.

-- AlterTable
ALTER TABLE "inventory_movements"
    ADD COLUMN "attachments" JSONB NOT NULL DEFAULT '[]';
