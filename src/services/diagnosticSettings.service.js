/**
 * DIAGNOSTIKA SOZLAMALARI (filial singleton).
 *
 * ⚠️ CHEGARALAR SOZLAMADA, KODDA EMAS. `goodScore` / `mediumScore` —
 * diagnostikaning butun tili: "Yaxshi / O'rta / Zaif" yorliqlari, heatmap
 * ranglari, zaif mavzular ro'yxati va e'tibor talab qiladigan o'quvchilar
 * ro'yxati hammasi shu ikki sondan chiqadi. Har maktabning "yaxshi"
 * tushunchasi har xil, shuning uchun u qattiq yozilmaydi.
 *
 * ⚠️ CHEGARA O'ZGARSA O'TGAN NATIJA QAYTA BAHOLANMAYDI: urinishda daraja
 * MUHRLANGAN (`DiagnosticAttempt.grade`). Aks holda sozlamani o'zgartirish
 * butun tarixni jimgina qayta yozib yuborardi.
 */

const { BadRequestError } = require("../utils/errors");
const prisma = require("../config/prisma");
const { getDiagnosticSettings } = require("./settings.service");
const {
  LEVELS,
  DEFAULT_LEVEL_TIERS,
  resolveLevelTiers,
} = require("../helpers/diagnostic.helpers");

const DECLARED_LEVELS = Object.keys(DEFAULT_LEVEL_TIERS);

async function getSettings() {
  const settings = await getDiagnosticSettings();
  return {
    ...settings,
    // Bo'sh/yaroqsiz qiymat o'rniga amaldagi default qaytariladi —
    // panel har doim to'ldirilgan forma ko'rsatadi.
    levelTiers: resolveLevelTiers(settings.levelTiers),
  };
}

function _parseInt(value, { min, max, field }) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new BadRequestError(`${field} ${min} dan ${max} gacha bo'lishi kerak`);
  }
  return parsed;
}

async function updateSettings(data, updatedBy) {
  const current = await getDiagnosticSettings();
  const update = {};

  if (data.aiEnabled !== undefined) update.aiEnabled = Boolean(data.aiEnabled);

  if (data.defaultQuestionCount !== undefined) {
    update.defaultQuestionCount = _parseInt(data.defaultQuestionCount, {
      min: 1,
      max: 100,
      field: "Savollar soni",
    });
  }
  if (data.defaultDurationMin !== undefined) {
    update.defaultDurationMin = _parseInt(data.defaultDurationMin, {
      min: 1,
      max: 300,
      field: "Davomiylik",
    });
  }
  if (data.defaultAttempts !== undefined) {
    update.defaultAttempts = _parseInt(data.defaultAttempts, {
      min: 1,
      max: 20,
      field: "Urinishlar soni",
    });
  }

  if (data.goodScore !== undefined) {
    update.goodScore = _parseInt(data.goodScore, {
      min: 1,
      max: 100,
      field: "\"Yaxshi\" chegarasi",
    });
  }
  if (data.mediumScore !== undefined) {
    update.mediumScore = _parseInt(data.mediumScore, {
      min: 0,
      max: 99,
      field: "\"O'rta\" chegarasi",
    });
  }
  if (data.weakTopicScore !== undefined) {
    update.weakTopicScore = _parseInt(data.weakTopicScore, {
      min: 1,
      max: 100,
      field: "Zaif mavzu chegarasi",
    });
  }

  // ⚠️ TARTIB TEKSHIRUVI MAJBURIY. `medium >= good` bo'lsa "O'rta"
  // toifasi umuman bo'sh qolardi va taqsimot diagrammasi ikki ustunli
  // bo'lib qolardi — buni foydalanuvchi hech qachon tushunmasdi.
  const good = update.goodScore ?? current.goodScore;
  const medium = update.mediumScore ?? current.mediumScore;
  if (medium >= good) {
    throw new BadRequestError(
      "\"O'rta\" chegarasi \"Yaxshi\" chegarasidan kichik bo'lishi kerak",
    );
  }

  if (data.levelTiers !== undefined) {
    const raw = data.levelTiers;
    if (raw && typeof raw === "object") {
      const cleaned = {};
      for (const key of DECLARED_LEVELS) {
        const value = Array.isArray(raw[key])
          ? raw[key].filter((l) => LEVELS.includes(l))
          : [];
        if (!value.length) {
          throw new BadRequestError(
            `"${key}" darajasi uchun kamida bitta qiyinlik tanlanishi kerak`,
          );
        }
        cleaned[key] = [...new Set(value)];
      }
      update.levelTiers = cleaned;
    } else {
      update.levelTiers = null; // default'ga qaytarish
    }
  }

  const saved = await prisma.diagnosticSettings.update({
    where: { id: "singleton" },
    data: { ...update, updatedBy },
  });

  return { ...saved, levelTiers: resolveLevelTiers(saved.levelTiers) };
}

module.exports = { getSettings, updateSettings, DECLARED_LEVELS };
