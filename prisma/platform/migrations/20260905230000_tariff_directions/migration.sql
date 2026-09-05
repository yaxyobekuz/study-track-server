-- YO'NALISH — tarif ustidagi daraja ("Maktab", "Bog'cha", "Yotoqxona").
--
-- QO'SHIMCHA: mavjud tariflarda `direction_id` null bo'lib qoladi va
-- hisobotda ular tarif nomi bilan guruhlanaveradi.

CREATE TABLE IF NOT EXISTS "tariff_directions" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariff_directions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tariff_directions_name_key"
  ON "tariff_directions"("name");

CREATE INDEX IF NOT EXISTS "tariff_directions_is_archived_is_active_sort_order_idx"
  ON "tariff_directions"("is_archived", "is_active", "sort_order");

ALTER TABLE "tariffs" ADD COLUMN IF NOT EXISTS "direction_id" CHAR(24);

CREATE INDEX IF NOT EXISTS "tariffs_direction_id_idx" ON "tariffs"("direction_id");

DO $$
BEGIN
  ALTER TABLE "tariffs"
    ADD CONSTRAINT "tariffs_direction_id_fkey"
    FOREIGN KEY ("direction_id") REFERENCES "tariff_directions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
