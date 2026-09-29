/**
 * QURILMA SIYOSATLARI VA ILOVALAR KATALOGI — kontroller (yupqa).
 * Biznes mantiq servislarda (`devicePolicy.service.js`, `deviceApp.service.js`).
 */

const asyncHandler = require("../middleware/async.middleware");
const devicePolicyService = require("../services/devicePolicy.service");
const deviceAppService = require("../services/deviceApp.service");

/* ─────────────────────── SIYOSATLAR ─────────────────────── */

const listPolicies = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.listPolicies(req.query);
  res.json({ success: true, data });
});

const getPolicy = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.getPolicy(req.params.id);
  res.json({ success: true, data });
});

const createPolicy = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.createPolicy(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Siyosat yaratildi", data });
});

const updatePolicy = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.updatePolicy(req.params.id, req.body, req.user.id);
  res.json({ success: true, message: "Siyosat saqlandi", data });
});

const archivePolicy = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.archivePolicy(req.params.id, req.user.id);
  res.json({ success: true, message: "Siyosat arxivlandi", data });
});

const restorePolicy = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.restorePolicy(req.params.id, req.user.id);
  res.json({ success: true, message: "Siyosat arxivdan qaytarildi", data });
});

/**
 * Siyosat nechta o'quvchiga ta'sir qilishini OLDINDAN aytadi.
 *
 * ⚠️ Biriktirishdan OLDIN ko'rsatiladi: "butun maktab" tugmasini
 * bosayotgan odam aniq nechta bolaning telefoni cheklanishini bilishi
 * kerak (arxivlashda qarz tushirish oynasi bilan bir xil naqsh).
 */
const previewPolicyImpact = asyncHandler(async (req, res) => {
  const studentIds = await devicePolicyService.affectedStudentIds(req.params.id);
  res.json({ success: true, data: { students: studentIds.length } });
});

/* ─────────────────────── BIRIKTIRISH ─────────────────────── */

const listAssignments = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.listAssignments(req.query);
  res.json({ success: true, data });
});

const setAssignment = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.setAssignment(req.body, req.user.id);
  res.json({ success: true, message: "Siyosat biriktirildi", data });
});

const clearAssignment = asyncHandler(async (req, res) => {
  const data = await devicePolicyService.clearAssignment(
    req.params.id,
    req.user.id,
    req.body?.reason,
  );
  res.json({
    success: true,
    // ⚠️ Sanoq bilan: nechta o'quvchi cheklovdan chiqqanini aytmaslik
    // jim yo'qotish bo'lardi.
    message: `Biriktirish olib tashlandi (${data.affected} ta o'quvchi)`,
    data,
  });
});

/* ─────────────────────── ILOVALAR KATALOGI ─────────────────────── */

const listApps = asyncHandler(async (req, res) => {
  const result = await deviceAppService.list(req.query);
  res.json(result);
});

/**
 * Ommaviy arxivlash — "yangi aniqlangan" uyumini tozalash.
 * ⚠️ Yiqilganlari SANOQ bilan qaytadi: "12 tadan 10 tasi arxivlandi"
 * degan holat jim qolmasligi kerak.
 */
const bulkArchiveApps = asyncHandler(async (req, res) => {
  const data = await deviceAppService.bulkArchive(req.body?.ids, req.user.id);
  const failed = data.failed.length ? `, ${data.failed.length} tasi arxivlanmadi` : "";
  res.json({ success: true, message: `${data.archived} ta ilova arxivlandi${failed}`, data });
});

const appOptions = asyncHandler(async (req, res) => {
  const data = await deviceAppService.options();
  res.json({ success: true, data });
});

const createApp = asyncHandler(async (req, res) => {
  const data = await deviceAppService.create(req.body, req.user.id);
  res.status(201).json({ success: true, message: "Ilova qo'shildi", data });
});

const updateApp = asyncHandler(async (req, res) => {
  const data = await deviceAppService.update(req.params.id, req.body, req.user.id);
  res.json({ success: true, message: "Ilova saqlandi", data });
});

const archiveApp = asyncHandler(async (req, res) => {
  const data = await deviceAppService.setArchived(req.params.id, true, req.user.id);
  res.json({ success: true, message: "Ilova arxivlandi", data });
});

const restoreApp = asyncHandler(async (req, res) => {
  const data = await deviceAppService.setArchived(req.params.id, false, req.user.id);
  res.json({ success: true, message: "Ilova arxivdan qaytarildi", data });
});

module.exports = {
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  archivePolicy,
  restorePolicy,
  previewPolicyImpact,
  listAssignments,
  setAssignment,
  clearAssignment,
  listApps,
  bulkArchiveApps,
  appOptions,
  createApp,
  updateApp,
  archiveApp,
  restoreApp,
};
