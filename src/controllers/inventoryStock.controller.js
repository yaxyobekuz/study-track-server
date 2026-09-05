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

// TAHRIRLASH — ANIQ MIQDOR bilan (`adjustStock` esa FARQ bilan; ikkalasi
// ham bitta `adjustment` qatorini yozadi, eski mijoz buzilmasin deb
// ikkalasi ham qoladi).
//
// ⚠️ Xona yoki jihoz almashtirilgan bo'lsa bu TAHRIR emas, KO'CHIRISH
// (`data.moved === true`) — xabar ham boshqa bo'lishi kerak, aks holda
// xodim "yangilandi" degan matnni o'qib, miqdor boshqa xonaga o'tganini
// bilmay qolardi.
const updateStock = asyncHandler(async (req, res) => {
  const data = await stockService.updateStock(req.params.id, req.body, req.user.id);
  res.json({
    success: true,
    data,
    message: data.moved
      ? `"${data.itemName}" ${data.locationName} xonasiga ko'chirildi`
      : "Xatlov qatori yangilandi",
  });
});

const deleteStock = asyncHandler(async (req, res) => {
  const { message, ...data } = await stockService.deleteStock(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data, message });
});

const getStockUsage = asyncHandler(async (req, res) => {
  const data = await stockService.getStockUsage(req.params.id);
  res.json({ success: true, data });
});

module.exports = {
  getStocks,
  getStockByLocation,
  getMovements,
  addStock,
  repairStock,
  writeOffStock,
  adjustStock,
  updateStock,
  deleteStock,
  getStockUsage,
};
