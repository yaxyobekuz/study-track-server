const asyncHandler = require("../middleware/async.middleware");
const invoicePaymentService = require("../services/invoicePayment.service");

const getPayments = asyncHandler(async (req, res) => {
  const result = await invoicePaymentService.getPayments(req);
  res.json(result);
});

const updatePayment = asyncHandler(async (req, res) => {
  const payment = await invoicePaymentService.updatePaymentNote(
    req.params.id,
    req.body.note,
  );
  res.json({ success: true, data: payment });
});

/**
 * DELETE fe'li — REST kutilmasi bo'yicha, lekin amalda SOFT VOID:
 * moliyaviy yozuv bazadan hech qachon chiqmaydi. Ro'yxatlar bekor qilinganlarni
 * ko'rsatmaydi (`?includeVoided=true` bo'lmasa), shuning uchun mijoz uchun
 * "o'chirildi" tasavvuri saqlanadi.
 */
const voidPayment = asyncHandler(async (req, res) => {
  const result = await invoicePaymentService.voidPayment(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, message: "To'lov bekor qilindi", data: result });
});

module.exports = { getPayments, updatePayment, voidPayment };
