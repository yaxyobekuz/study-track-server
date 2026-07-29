-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];
