const asyncHandler = require("../middleware/async.middleware");
const prisma = require("../config/prisma");
const expenseService = require("../services/expense.service");
const expenseExport = require("../services/expenseExport.service");

const getExpenses = asyncHandler(async (req, res) => {
  const data = await expenseService.getExpenses(req);
  res.json({ success: true, ...data });
});

const createExpense = asyncHandler(async (req, res) => {
  const data = await expenseService.createExpense(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const voidExpense = asyncHandler(async (req, res) => {
  const data = await expenseService.voidExpense(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data, message: "Xarajat bekor qilindi" });
});

// Tahrirlash — eskisi bekor qilinib, to'g'ri qiymatlar bilan yangisi
// yoziladi (append-only daftar, bitta tranzaksiya). Nomi `replace`:
// `PUT /expenses/:id` emas, chunki yozuv JOYIDA o'zgarmaydi.
const replaceExpense = asyncHandler(async (req, res) => {
  const data = await expenseService.editExpense(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data, message: "Xarajat tahrirlandi" });
});

/**
 * CHIQIMLARNI EXCEL'GA YUKLAB OLISH.
 *
 * ⚠️ FILTRLAR EKRANDAGIDEK QO'LLANADI — `req.query` o'zgarishsiz
 * uzatiladi: foydalanuvchi kategoriya tanlab Excel bossa, faylda ham
 * aynan o'sha qatorlar bo'lishi kerak. Fayl ekrandan boshqa ma'lumot
 * bersa, ikkalasiga ham ishonch yo'qolardi.
 *
 * Filtr NOMLARI (ID emas) sarlavha ostiga yoziladi — fayl boshqa odamga
 * yuborilganda "qaysi kategoriya" degan savolga ID javob bermaydi.
 */
const exportExpenses = asyncHandler(async (req, res) => {
  const { categoryId, accountId } = req.query;

  const [category, account] = await Promise.all([
    categoryId
      ? prisma.expenseCategory.findUnique({
          where: { id: categoryId },
          select: { name: true },
        })
      : null,
    accountId
      ? prisma.paymentAccount.findUnique({
          where: { id: accountId },
          select: { name: true },
        })
      : null,
  ]);

  await expenseExport.exportExpensesToExcel(res, req.query, {
    categoryName: category?.name,
    accountName: account?.name,
  });
});

module.exports = {
  getExpenses,
  createExpense,
  voidExpense,
  replaceExpense,
  exportExpenses,
};
