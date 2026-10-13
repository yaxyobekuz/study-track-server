/**
 * GURUH KUZATUVI — rasmiy guruh xabarlarini AI bilan tahlil qilish.
 *
 * Har 30 daqiqada: bot to'plagan xabarlar o'qiladi, AI ularning orasidan
 * shikoyat / taklif / javobsiz savolni ajratadi va natija "Guruh
 * signallari" tabida ko'rinadi.
 *
 * ⚠️ `branchCron` ISHLATILMAYDI va bu ataylab. Guruhlar ham, xabarlar ham,
 * signallar ham PLATFORMA schema'sida: guruh birorta filialga tegishli
 * emas (`bot/src/services/group.service.js` izohi). Filiallar bo'ylab
 * aylantirilsa, bitta xabar har filialda qayta tahlil qilinib, bir signal
 * filiallar soniga ko'payib ketardi — va AI hisobi ham shuncha oshardi.
 *
 * ⚠️ NIMA UCHUN 30 DAQIQA, har xabarda emas: bitta so'rovga o'nlab xabar
 * birga ketadi va model SUHBATNI ko'radi. "Ha, bizda ham shunday" degan
 * gap yolg'iz o'zi ma'nosiz, oldingi xabar bilan birga esa shikoyatning
 * davomi. Ustiga bu arzonroq — har xabar uchun alohida so'rov yuborish
 * kerak emas.
 *
 * ⚠️ TAHLIL QILINMAGAN XABAR YO'QOLMAYDI: nosozlikda u navbatda qoladi va
 * keyingi aylanishda qayta ko'riladi (`groupSignal.service.js#runAnalysis`).
 */

const cron = require("node-cron");

const logger = require("../utils/logger");
const groupSignalService = require("../services/groupSignal.service");
const groupSignalAi = require("../services/groupSignalAi.service");

/**
 * HOZIR ISHLAYOTGAN aylanish (bo'lmasa `null`).
 *
 * ⚠️ BIR VAQTDA BITTA AYLANISH. Panelda "Hozir tekshirish" tugmasi bor
 * va u cron bilan ustma-ust tushishi mumkin: ikki aylanish bir vaqtda
 * ketsa, IKKALASI ham ayni xabarlarni o'qib (`analyzedAt` hali
 * qo'yilmagan), ayni signalni IKKI MARTA yozardi — ustiga AI hisobi
 * ham ikki barobar bo'lardi. Shuning uchun ikkinchi chaqiruv yangi
 * aylanish boshlamaydi, BIRINCHISINI KUTADI va uning natijasini oladi.
 */
let _running = null;

/**
 * Bitta aylanish. Panel ham, cron ham shuni chaqiradi.
 *
 * ⚠️ XATO YUQORIGA CHIQMAYDI: bu fon ishi va yiqilishi jarayonni
 * to'xtatmasligi kerak. Panel javobni `error` bayrog'idan biladi.
 */
async function runGroupSignalPass() {
  if (_running) return _running;

  _running = _runPass().finally(() => {
    _running = null;
  });

  return _running;
}

async function _runPass() {
  try {
    const result = await groupSignalService.runAnalysis();

    if (result.skipped) {
      // Kalit yo'q — har 30 daqiqada ogohlantirish yozmaymiz, log
      // shunchaki to'lib ketardi. Ishga tushishda bir marta aytilgan.
      return result;
    }

    if (result.analyzed > 0) {
      logger.info(
        `[GroupSignal] ${result.groups} guruh, ${result.analyzed} xabar tahlil qilindi — ` +
          `${result.signals} ta signal`,
      );
    }

    // Eski, tahlil qilingan xabarlarni tozalash — guruh yozishmasi
    // bizda saqlanib qolmasligi kerak.
    const swept = await groupSignalService.sweep();
    if (swept.deleted > 0) {
      logger.info(`[GroupSignal] ${swept.deleted} ta eski xabar o'chirildi`);
    }

    return result;
  } catch (error) {
    logger.error("[GroupSignal] Tahlil aylanishida xato", error);
    return { analyzed: 0, signals: 0, groups: 0, skipped: false, error: true };
  }
}

const startGroupSignalCron = () => {
  cron.schedule("*/30 * * * *", runGroupSignalPass, {
    scheduled: true,
    timezone: "Asia/Tashkent",
  });

  if (!groupSignalAi.isEnabled()) {
    logger.warn(
      "[GroupSignal] OPENAI_API_KEY yo'q — guruh xabarlari to'planadi, lekin tahlil qilinmaydi",
    );
    return;
  }

  logger.info(
    `[GroupSignal] Cron ishga tushdi: har 30 daqiqada, ${groupSignalAi.MODEL} (Asia/Tashkent)`,
  );
};

module.exports = { startGroupSignalCron, runGroupSignalPass };
