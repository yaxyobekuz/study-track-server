const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { findInBranches } = require("../helpers/branchIterator");
const branchService = require("../services/branch.service");
const asyncHandler = require("./async.middleware");
const { UnauthorizedError } = require("../utils/errors");

/**
 * Monitor kodi → filial keshi.
 *
 * Monitorda token yo'q, faqat kod: qaysi filialdaligini AVVAL topish kerak.
 * Qidiruv filiallar bo'ylab ketadi, shuning uchun natija keshlanadi —
 * monitor ekrani har bir necha soniyada so'rov yuboradi.
 *
 * TTL qisqa: monitor boshqa filialga ko'chirilishi yoki o'chirilishi mumkin.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const codeToBranch = new Map(); // code -> { branchId, at }

/**
 * Monitor kodini tekshiruvchi middleware.
 * x-monitor-code headerdan kodni o'qiydi va FILIALLAR BO'YLAB qidiradi.
 *
 * `next()` filial kontekstida chaqiriladi — controller'lardagi
 * `prisma.class`, `prisma.schedule` shundan keyin to'g'ri filialga boradi.
 */
const verifyMonitor = asyncHandler(async (req, res, next) => {
  const code = req.headers["x-monitor-code"];

  if (!code) {
    throw new UnauthorizedError("Monitor kodi taqdim etilmagan");
  }

  const findMonitor = () =>
    prisma.monitor.findFirst({ where: { code, isActive: true } });

  // ── 1. Keshdan ────────────────────────────
  const cached = codeToBranch.get(code);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    const branch = await branchService.findById(cached.branchId);
    if (branch && !branch.isArchived && branch.status === "ready") {
      const monitor = await runWithBranch(branch, findMonitor);
      if (monitor) {
        req.monitor = monitor;
        req.branch = branch;
        return runWithBranch(branch, () => next());
      }
    }
    codeToBranch.delete(code); // kesh eskirdi — to'liq qidiruvga tushamiz
  }

  // ── 2. Filiallar bo'ylab qidiruv ──────────
  const hit = await findInBranches(findMonitor);

  if (!hit) {
    throw new UnauthorizedError("Monitor kodi noto'g'ri yoki faol emas");
  }

  codeToBranch.set(code, { branchId: hit.branch.id, at: Date.now() });

  req.monitor = hit.value;
  req.branch = hit.branch;
  return runWithBranch(hit.branch, () => next());
});

module.exports = { verifyMonitor };
