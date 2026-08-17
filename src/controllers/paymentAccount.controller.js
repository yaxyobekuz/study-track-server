const asyncHandler = require("../middleware/async.middleware");
const paymentAccountService = require("../services/paymentAccount.service");
const accountTransferService = require("../services/accountTransfer.service");

// ── Hisoblar ─────────────────────────────────

const getAccounts = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.getAccounts(req.query);
  res.json({ success: true, ...data });
});

const getAccount = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.getAccountById(req.params.id);
  res.json({ success: true, data });
});

const createAccount = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.createAccount(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const updateAccount = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.updateAccount(req.params.id, req.body);
  res.json({ success: true, data });
});

const archiveAccount = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.setAccountArchived(
    req.params.id,
    req.body.isArchived !== false,
  );
  res.json({ success: true, data });
});

const adjustAccount = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.adjustBalance(
    req.params.id,
    req.body,
    req.user.id,
  );
  res.json({ success: true, data });
});

// ── Daftar va hisobot ────────────────────────

const getAccountEntries = asyncHandler(async (req, res) => {
  const result = await paymentAccountService.getAccountEntries(req.params.id, req);
  res.json(result);
});

const getReport = asyncHandler(async (req, res) => {
  const data = await paymentAccountService.getAccountsReport(req.query);
  res.json({ success: true, ...data });
});

// ── O'tkazmalar ──────────────────────────────

const getTransfers = asyncHandler(async (req, res) => {
  const result = await accountTransferService.getTransfers(req);
  res.json(result);
});

const createTransfer = asyncHandler(async (req, res) => {
  const data = await accountTransferService.createTransfer(req.body, req.user.id);
  res.status(201).json({ success: true, data });
});

const voidTransfer = asyncHandler(async (req, res) => {
  const result = await accountTransferService.voidTransfer(
    req.params.id,
    req.body.reason,
    req.user.id,
  );
  res.json({ success: true, ...result });
});

module.exports = {
  getAccounts,
  getAccount,
  createAccount,
  updateAccount,
  archiveAccount,
  adjustAccount,
  getAccountEntries,
  getReport,
  getTransfers,
  createTransfer,
  voidTransfer,
};
