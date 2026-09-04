/**
 * INVENTAR KATALOGI — toifalar, jihoz turlari va xonalar.
 *
 * Uchala katalog bitta faylda: ular bir xil shakldagi CRUD va bitta
 * ekranning ("Katalog" tabi) uch bo'limi. Uchta alohida fayl bir xil
 * yetti qatorni uch marta takrorlardi.
 */

const asyncHandler = require("../middleware/async.middleware");
const categoryService = require("../services/inventoryCategory.service");
const itemService = require("../services/inventoryItem.service");
const locationService = require("../services/inventoryLocation.service");

// ─── Toifalar ────────────────────────────────

const getCategories = asyncHandler(async (req, res) => {
  const data = await categoryService.getCategories(req.query);
  res.json({ success: true, ...data });
});

const createCategory = asyncHandler(async (req, res) => {
  const data = await categoryService.createCategory(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateCategory = asyncHandler(async (req, res) => {
  const data = await categoryService.updateCategory(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveCategory = asyncHandler(async (req, res) => {
  const { message, ...data } = await categoryService.archiveCategory(
    req.params.id,
    req.body.isArchived,
  );
  res.json({ success: true, data, message });
});

// ─── Jihoz turlari ───────────────────────────

const getItems = asyncHandler(async (req, res) => {
  const data = await itemService.getItems(req);
  res.json({ success: true, ...data });
});

const getActiveItems = asyncHandler(async (req, res) => {
  const items = await itemService.getActiveItems(req.query);
  res.json({ success: true, items });
});

const createItem = asyncHandler(async (req, res) => {
  const data = await itemService.createItem(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateItem = asyncHandler(async (req, res) => {
  const data = await itemService.updateItem(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveItem = asyncHandler(async (req, res) => {
  const { message, ...data } = await itemService.archiveItem(
    req.params.id,
    req.body.isArchived,
  );
  res.json({ success: true, data, message });
});

// ─── Xonalar ─────────────────────────────────

const getLocations = asyncHandler(async (req, res) => {
  const data = await locationService.getLocations(req);
  res.json({ success: true, ...data });
});

const getActiveLocations = asyncHandler(async (req, res) => {
  const items = await locationService.getActiveLocations();
  res.json({ success: true, items });
});

const getLocationById = asyncHandler(async (req, res) => {
  const data = await locationService.getLocationById(req.params.id);
  res.json({ success: true, data });
});

const createLocation = asyncHandler(async (req, res) => {
  const data = await locationService.createLocation(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateLocation = asyncHandler(async (req, res) => {
  const data = await locationService.updateLocation(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveLocation = asyncHandler(async (req, res) => {
  const { message, ...data } = await locationService.archiveLocation(
    req.params.id,
    req.body.isArchived,
  );
  res.json({ success: true, data, message });
});

module.exports = {
  getCategories,
  createCategory,
  updateCategory,
  archiveCategory,
  getItems,
  getActiveItems,
  createItem,
  updateItem,
  archiveItem,
  getLocations,
  getActiveLocations,
  getLocationById,
  createLocation,
  updateLocation,
  archiveLocation,
};
