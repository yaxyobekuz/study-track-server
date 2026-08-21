-- XODIM QAYSI FILIALLARDA ISHLAY OLADI
--
-- Ilgari bitta odam faqat bitta filialga tegishli edi (`user_directory.branch_id`).
-- Endi u bir nechta filialda ishlay oladi va HAR FILIALDA O'Z RUXSATLARI
-- bo'ladi — ruxsatlar filial schema'sidagi `users.permissions` da yotgani
-- uchun bu tabiiy ravishda ishlaydi.
--
-- Bu jadval faqat REYESTR: "kirishga ruxsat berilganmi". Ruxsatlarning o'zi
-- bu yerda saqlanmaydi.

CREATE TABLE "user_branch_access" (
    "user_id" CHAR(24) NOT NULL,
    "branch_id" CHAR(24) NOT NULL,
    "role" TEXT NOT NULL,
    "is_home" BOOLEAN NOT NULL DEFAULT false,
    "created_by" CHAR(24),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_branch_access_pkey" PRIMARY KEY ("user_id","branch_id")
);

CREATE INDEX "user_branch_access_branch_id_role_idx" ON "user_branch_access"("branch_id", "role");

ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "user_directory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_branch_access" ADD CONSTRAINT "user_branch_access_branch_id_fkey"
    FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BACKFILL: mavjud har bir foydalanuvchi o'z UY filialiga biriktiriladi.
-- Busiz hech kim hech qayerga kira olmasdi — `switchBranch` va
-- `availableBranches` aynan shu jadvalga qaraydi.
INSERT INTO "user_branch_access" ("user_id", "branch_id", "role", "is_home", "created_at", "updated_at")
SELECT d."id", d."branch_id", d."role", true, d."created_at", d."updated_at"
  FROM "user_directory" d
ON CONFLICT DO NOTHING;
