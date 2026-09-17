-- ARXIVLASH IZOHI.
--
-- `users.archive_note` — nega arxivlangani (admin kiritadi, ixtiyoriy).
-- Arxivdan qaytarilganda `archived_at` bilan birga tozalanadi.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "archive_note" TEXT;
