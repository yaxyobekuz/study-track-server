/**
 * REAL VAQT HODISALARINI YUBORISH — servislar uchun YUPQA fasad.
 *
 * Nima uchun alohida fayl: `story.service` va `chat.service` socket
 * serverini TO'G'RIDAN-TO'G'RI import qilsa, aylanma `require` paydo
 * bo'lardi (socket → handlers → chat.service → socket). Bu fayl esa hech
 * nimani import qilmaydi: socket server ishga tushganda o'zini shu yerga
 * REGISTRATSIYA qiladi.
 *
 * ⚠️ SOCKET BO'LMASA HAM ISHLAYDI (jim o'tadi). Server socket'siz ham
 * ko'tarilishi mumkin (test, skript, cron jarayoni) va o'sha paytda
 * "xabar yuborildi" degan amal YIQILMASLIGI kerak — `push.service`
 * doktrinasi bilan AYNI: real vaqt — tezlatgich, haqiqat manbai esa
 * baza va `seq`.
 *
 * ⚠️ XONA — `user:<id>`, suhbat xonasi EMAS. A'zolik o'zgarganda (sinf
 * sinxroni, guruhdan chiqish) odamni o'nlab suhbat xonasidan qo'shib-olib
 * yurish kerak bo'lardi va bitta o'tkazib yuborilgan joyda odam o'zi
 * a'zo bo'lmagan suhbatning xabarini olib turardi. `user:` xonasi esa
 * ulanish bilan birga tug'iladi va o'ladi.
 */

let io = null;
let logger = null;

/** Socket server tayyor bo'lganda o'zini shu yerda ro'yxatga oladi. */
function register(server, log) {
  io = server;
  logger = log;
}

/** Socket o'chirilganda (graceful shutdown) tozalanadi. */
function unregister() {
  io = null;
}

const isReady = () => Boolean(io);

/**
 * Bir nechta odamning BARCHA ochiq ilovalariga hodisa yuboradi.
 *
 * ⚠️ XATO YUTILADI va yuqoriga chiqmaydi: hodisa yetib bormasa, ilova
 * qayta ulanganda `GET /chat/sync` bilan o'zini to'ldiradi — shuning
 * uchun bu yo'l hech qachon biznes amalini yiqitmaydi.
 *
 * @param {string[]} userIds
 * @param {string} event
 * @param {object} payload
 */
function emitToUsers(userIds, event, payload) {
  if (!io) return;
  try {
    const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
    if (ids.length === 0) return;
    io.to(ids.map((id) => `user:${id}`)).emit(event, payload);
  } catch (error) {
    logger?.warn(`[socket] "${event}" yuborilmadi: ${error.message}`);
  }
}

/** Bitta odamga. */
function emitToUser(userId, event, payload) {
  emitToUsers([userId], event, payload);
}

/**
 * Odam HOZIR onlaynmi — `user:<id>` xonasida kamida bitta socket bormi.
 *
 * ⚠️ PUSH QARORI SHU YERDAN: onlayn odamga bildirishnoma yuborilmaydi
 * (ilova xabarni socket orqali oladi). Socket o'chiq bo'lsa funksiya
 * `false` qaytaradi — ya'ni push HAR DOIM yuboriladi. Teskarisi xavfli
 * bo'lardi: "onlayn" deb taxmin qilib, xabarni hech kimga yetkazmaslik.
 *
 * ⚠️ BIR NECHTA NUSXADA (PM2 cluster) bu faqat SHU nusxani biladi —
 * shuning uchun `REDIS_URL` bilan adapter yoqiladi va hisob butun
 * klasterga umumiy bo'ladi (`socket.js`).
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isOnline(userId) {
  if (!io) return false;
  try {
    const sockets = await io.in(`user:${String(userId)}`).fetchSockets();
    return sockets.length > 0;
  } catch {
    return false;
  }
}

/**
 * Ro'yxatdan onlayn bo'lmaganlarni qaytaradi — push aynan shularga ketadi.
 *
 * ⚠️ BITTA `fetchSockets()` CHAQIRUVI, har odam uchun alohida EMAS.
 * 200 kishilik sinf guruhida har xabarda 200 ta xona so'rovi bo'lardi va
 * Redis adapter bilan (bir nechta nusxa) bu 200 ta tarmoq murojaati
 * degani — xabar yuborish sekinlashardi.
 *
 * ⚠️ Socket o'chiq bo'lsa HAMMASI oflayn hisoblanadi, ya'ni push HAR
 * DOIM ketadi. Teskarisi xavfli bo'lardi: "onlayn" deb taxmin qilib,
 * xabarni hech kimga yetkazmaslik.
 *
 * @param {string[]} userIds
 * @returns {Promise<string[]>}
 */
async function filterOffline(userIds = []) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!io || ids.length === 0) return ids;

  try {
    const sockets = await io.fetchSockets();
    const online = new Set(sockets.map((socket) => socket.data?.userId).filter(Boolean));
    return ids.filter((id) => !online.has(id));
  } catch (error) {
    logger?.warn(`[socket] onlayn ro'yxat olinmadi: ${error.message}`);
    return ids;
  }
}

/** Seans yopilganda (logout, "seansni tugat") socketni ham uzadi. */
async function disconnectSession(jti) {
  if (!io || !jti) return;
  try {
    const sockets = await io.fetchSockets();
    for (const socket of sockets) {
      if (socket.data?.jti === jti) socket.disconnect(true);
    }
  } catch (error) {
    logger?.warn(`[socket] seansni uzishda xato: ${error.message}`);
  }
}

module.exports = {
  register,
  unregister,
  isReady,
  emitToUsers,
  emitToUser,
  isOnline,
  filterOffline,
  disconnectSession,
};
