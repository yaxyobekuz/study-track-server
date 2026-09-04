/** XATLOV va MIQDOR DAFTARI. */

const asyncHandler = require("../middleware/async.middleware");
const stockService = require("../services/inventoryStock.service");

const getStocks = asyncHandler(async (req, res) => {
  const data = await stockService.getStocks(req);
  res.json({ success: true, ...data });
});

const getStockByLocation = asyncHandler(async (req, res) => {
  const data = await stockService.getStockByLocation(req.params.locationId, {
    includeEmpty: req.query.includeEmpty === "true",
  });
  res.json({ success: true, data });
});

const getMovements = asyncHandler(async (req, res) => {
  const data = await stockService.getMovements(req);
  res.json({ success: true, ...data });
});

const addStock = asyncHandler(async (req, res) => {
  const data = await stockService.addStock(req.body, req.user.id);
  res.status(201).json({ success: true, data, message: "Xatlov yangilandi" });
});

const repairStock = asyncHandler(async (req, res) => {
  const data = await stockService.repairStock(req.body, req.user.id);
  res.json({ success: true, data, message: "Ta'mirlangani qayd etildi" });
});

const writeOffStock = asyncHandler(async (req, res) => {
  const data = await stockService.writeOffStock(req.body, req.user.id);
  res.json({ success: true, data, message: "Hisobdan chiqarildi" });
});

const adjustStock = asyncHandler(async (req, res) => {
  const data = await stockService.adjustStock(req.body, req.user.id);
  res.json({ success: true, data, message: "Xatlov to'g'rilandi" });
});

const transferStock = asyncHandler(async (req, res) => {
  const data = await stockService.transferStock(req.body, req.user.id);
  res.json({ success: true, data, message: "Jihoz ko'chirildi" });
});

module.exports = {
  getStocks,
  getStockByLocation,
  getMovements,
  addStock,
  repairStock,
  writeOffStock,
  adjustStock,
  transferStock,
};
