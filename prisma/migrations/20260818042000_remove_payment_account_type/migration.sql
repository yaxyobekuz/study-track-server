-- AlterTable
ALTER TABLE "payment_accounts" DROP COLUMN "description",
DROP COLUMN "type";

-- DropEnum
DROP TYPE "PaymentAccountType";

