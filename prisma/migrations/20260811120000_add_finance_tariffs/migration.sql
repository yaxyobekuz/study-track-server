-- CreateTable
CREATE TABLE "tariffs" (
    "id" CHAR(24) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "currency" CHAR(3) NOT NULL DEFAULT 'UZS',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMP(3),
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tariff_versions" (
    "id" CHAR(24) NOT NULL,
    "tariff_id" CHAR(24) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "monthly_amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tariff_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_tariffs" (
    "id" CHAR(24) NOT NULL,
    "student_id" CHAR(24) NOT NULL,
    "tariff_id" CHAR(24) NOT NULL,
    "start_month" INTEGER NOT NULL,
    "end_month" INTEGER,
    "note" TEXT NOT NULL DEFAULT '',
    "created_by" CHAR(24) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "student_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tariffs_name_key" ON "tariffs"("name");

-- CreateIndex
CREATE INDEX "tariffs_is_archived_is_active_name_idx" ON "tariffs"("is_archived", "is_active", "name");

-- CreateIndex
CREATE INDEX "tariff_versions_tariff_id_start_month_idx" ON "tariff_versions"("tariff_id", "start_month" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tariff_versions_tariff_id_start_month_key" ON "tariff_versions"("tariff_id", "start_month");

-- CreateIndex
CREATE INDEX "student_tariffs_student_id_start_month_idx" ON "student_tariffs"("student_id", "start_month" DESC);

-- CreateIndex
CREATE INDEX "student_tariffs_tariff_id_idx" ON "student_tariffs"("tariff_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_tariffs_student_id_start_month_key" ON "student_tariffs"("student_id", "start_month");

-- AddForeignKey
ALTER TABLE "tariff_versions" ADD CONSTRAINT "tariff_versions_tariff_id_fkey" FOREIGN KEY ("tariff_id") REFERENCES "tariffs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
