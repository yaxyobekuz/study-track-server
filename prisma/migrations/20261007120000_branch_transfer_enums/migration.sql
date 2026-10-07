-- FILIALLARARO KO'CHIRISH — ikki enumga bitta qiymat.
--
-- `CoinTransactionType.branch_transfer` — o'quvchi ko'chganda tanga qoldig'i
-- yozuv bilan ko'chadi: manba filialda chiqim (qoldiq 0), maqsad filialda
-- kirim. Tarix o'z filialida qoladi, qoldiq esa izohsiz paydo bo'lmaydi.
--
-- `StudentClassChangeSource.branch_transfer` — o'quvchi boshqa filialga
-- o'tganda manba filialdagi sinfidan chiqishi jurnalga shu manba bilan
-- yoziladi (`education.md` §5: sinfdan chiqarish sababsiz bo'lmaydi).
--
-- Mavjud birorta qator o'zgarmaydi.

ALTER TYPE "CoinTransactionType" ADD VALUE IF NOT EXISTS 'branch_transfer';

ALTER TYPE "StudentClassChangeSource" ADD VALUE IF NOT EXISTS 'branch_transfer';
