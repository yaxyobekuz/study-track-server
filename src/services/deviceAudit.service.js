/**
 * QURILMA NAZORATI AUDITI — "kim nima qildi".
 *
 * ⚠️ ALOHIDA JADVAL va bu ataylab. Bu modul bolaning shaxsiy qurilmasini
 * cheklaydi: "kim bu sinfni qulfladi", "kim kechqurun ochib berdi" degan
 * savollarga javob HAR DOIM bo'lishi kerak. Ma'lumotning o'zidan (siyosat
 * qatoridan) buni tiklab bo'lmaydi — u faqat OXIRGI holatni biladi.
 *
 * ⚠️ AUDIT ASOSIY AMALNI YIQITMAYDI. Yozuv qo'shilmay qolsa ham biriktirish
 * saqlanadi: aks holda audit jadvalidagi kichik nosozlik butun modulni
 * to'xtatib qo'yardi (`push.service.js` bilan bir xil doktrina). Shu sababli
 * `record()` xato TASHLAMAYDI — faqat log yozadi.
 *
 * ⚠️ Tranzaksiya ichida yozish kerak bo'lsa `recordInTx(tx, ...)`: u esa
 * ataylab xato tashlaydi — chaqiruvchi tranzaksiya baribir orqaga qaytadi
 * va yarim yozilgan holat qolmaydi.
 */

const prisma = require("../config/prisma");
const logger = require("../utils/logger");
const { formatPaginationResponse } = require("../utils/pagination");

/** Amal kalitlari — panelda yorliqqa aylanadi (`devices.data.js`). */
const ACTIONS = Object.freeze({
  POLICY_CREATE: "policy.create",
  POLICY_UPDATE: "policy.update",
  POLICY_ARCHIVE: "policy.archive",
  ASSIGNMENT_SET: "assignment.set",
  ASSIGNMENT_CLEAR: "assignment.clear",
  DEVICE_ENROLL: "device.enroll",
  DEVICE_PAUSE: "device.pause",
  DEVICE_RESUME: "device.resume",
  DEVICE_REMOVE: "device.remove",
  CODE_ISSUE: "code.issue",
  UNLOCK_CREATE: "unlock.create",
  UNLOCK_CANCEL: "unlock.cancel",
  APP_UPSERT: "app.upsert",
  SETTINGS_UPDATE: "settings.update",
});

const SUMMARY_MAX = 300;

const clip = (value, max = SUMMARY_MAX) => String(value || "").trim().slice(0, max);

function buildRow({ action, actorId, studentId, deviceId, policyId, summary, reason, meta }) {
  return {
    action,
    actorId,
    studentId: studentId || null,
    deviceId: deviceId || null,
    policyId: policyId || null,
    summary: clip(summary),
    reason: clip(reason),
    meta: meta ?? undefined,
  };
}

/**
 * Tranzaksiya ICHIDA yozadi — amal bilan bitta atomik qadamda.
 * @param {object} tx - Prisma tranzaksiya client'i
 */
function recordInTx(tx, input) {
  return tx.deviceAudit.create({ data: buildRow(input) });
}

/**
 * Tranzaksiyadan TASHQARIDA yozadi. Xato tashlamaydi (yuqoridagi izoh).
 */
async function record(input) {
  try {
    return await prisma.deviceAudit.create({ data: buildRow(input) });
  } catch (error) {
    logger.warn(`[devices] audit yozilmadi (${input?.action}): ${error.message}`);
    return null;
  }
}

/**
 * Audit tasmasi — panelning "Tarix" bloki.
 *
 * ⚠️ IKKI SHAKLDA QAYTADI: `paginate` berilmasa oddiy massiv (dashboard va
 * o'quvchi kartasidagi qisqa tasma uchun), berilsa sahifalangan javob.
 * Ikkita alohida funksiya yozilsa, filtr mantig'i ikki nusxa bo'lardi.
 *
 * @param {{ studentId?, action?, limit?, page?, paginate? }} filters
 */
async function list({ studentId, action, limit = 50, page, paginate = false } = {}) {
  const where = {
    ...(studentId ? { studentId } : {}),
    ...(action && action !== "all" ? { action } : {}),
  };

  if (!paginate) {
    return prisma.deviceAudit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(Number(limit) || 50, 1), 200),
    });
  }

  const currentPage = Math.max(1, Number(page) || 1);
  const perPage = Math.min(Math.max(Number(limit) || 30, 1), 200);

  const [rows, total] = await Promise.all([
    prisma.deviceAudit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (currentPage - 1) * perPage,
      take: perPage,
    }),
    prisma.deviceAudit.count({ where }),
  ]);

  return formatPaginationResponse(rows, total, currentPage, perPage);
}

module.exports = { ACTIONS, record, recordInTx, list };
