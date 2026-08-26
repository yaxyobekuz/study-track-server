const asyncHandler = require("../middleware/async.middleware");
const externalIncomeService = require("../services/externalIncome.service");

const getIncomes = asyncHandler(async (req, res) => {
  const data = await externalIncomeService.getIncomes(req);
  res.json({ success: true, ...data });
});

const createIncome = asyncHandler(async (req, res) => {
  const data = await externalIncomeService.createIncome(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const voidIncome = asyncHandler(async (req, res) => {
  const data = await externalIncomeService.voidIncome(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, data, message: "Kirim bekor qilindi" });
});

module.exports = { getIncomes, createIncome, voidIncome };
