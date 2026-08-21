const asyncHandler = require("../middleware/async.middleware");
const branchService = require("../services/branch.service");
const branchProvision = require("../services/branchProvision.service");
const { BadRequestError } = require("../utils/errors");

// Ro'yxat
const getBranches = asyncHandler(async (req, res) => {
  const data = await branchService.list(req.query);
  res.json({ success: true, data });
});

// Bitta filial
const getBranch = asyncHandler(async (req, res) => {
  const data = await branchService.getById(req.params.id);
  res.json({ success: true, data });
});

// Yaratish — qator darhol `provisioning` holatida qaytadi, schema fonda
// tayyorlanadi (`migrate deploy` bir necha soniya davom etadi).
const createBranch = asyncHandler(async (req, res) => {
  const branch = await branchService.create(req.body, req.user.id);
  branchProvision.provisionInBackground(branch);

  res.status(201).json({
    success: true,
    message: `"${branch.name}" yaratildi — baza tayyorlanmoqda`,
    data: branch,
  });
});

// Tahrirlash (`code` va `schemaName` o'zgarmaydi)
const updateBranch = asyncHandler(async (req, res) => {
  const data = await branchService.update(req.params.id, req.body);
  res.json({ success: true, message: "Filial yangilandi", data });
});

// Arxivlash — o'chirish YO'Q, ortida moliyaviy tarix bor
const archiveBranch = asyncHandler(async (req, res) => {
  const data = await branchService.archive(req.params.id, req.body?.reason);
  res.json({ success: true, message: "Filial arxivlandi", data });
});

// Arxivdan qaytarish
const restoreBranch = asyncHandler(async (req, res) => {
  const data = await branchService.restore(req.params.id);
  res.json({ success: true, message: "Filial arxivdan qaytarildi", data });
});

// Provisioning'ni qayta urinish (`failed` holatidan chiqish)
const retryProvision = asyncHandler(async (req, res) => {
  const branch = await branchService.getById(req.params.id);

  if (branch.status === "ready") {
    throw new BadRequestError("Filial allaqachon tayyor");
  }

  branchProvision.provisionInBackground(branch);
  res.json({
    success: true,
    message: "Qayta urinish boshlandi",
    data: { ...branch, status: "provisioning" },
  });
});

module.exports = {
  getBranches,
  getBranch,
  createBranch,
  updateBranch,
  archiveBranch,
  restoreBranch,
  retryProvision,
};
