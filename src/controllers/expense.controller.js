const asyncHandler = require("../middleware/async.middleware");
const expenseService = require("../services/expense.service");

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

module.exports = { getExpenses, createExpense, voidExpense };
