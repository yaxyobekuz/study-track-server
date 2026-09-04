/**
 * JIHOZLARNI O'TKAZISH — topshirish-qabul qilish akti.
 *
 * Xatlovdan (`inventoryStock.controller.js`) ALOHIDA, chunki o'tkazma
 * hujjat: uning o'z registri, o'z tafsilot ekrani va o'z filtrlari bor
 * (`accountTransfer` moliya modulida kassadan ajratilgani bilan bir xil).
 */

const asyncHandler = require("../middleware/async.middleware");
const transferService = require("../services/inventoryTransfer.service");

const getTransfers = asyncHandler(async (req, res) => {
  const data = await transferService.getTransfers(req);
  res.json({ success: true, ...data });
});

const getTransferById = asyncHandler(async (req, res) => {
  const data = await transferService.getTransferById(req.params.id);
  res.json({ success: true, data });
});

const createTransfer = asyncHandler(async (req, res) => {
  const data = await transferService.createTransfer(req.body, req.user.id);
  res.status(201).json({ success: true, data, message: "Jihozlar o'tkazildi" });
});

module.exports = {
  getTransfers,
  getTransferById,
  createTransfer,
};
