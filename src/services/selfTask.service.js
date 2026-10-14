/**
 * XODIM O'ZIGA O'ZI BELGILAGAN TOPSHIRIQLAR — "o'zim belgilagan topshiriq".
 *
 * Lavozimlar markazining AYNI dvigateli (`task.service.js`,
 * `taskSchedule.service.js`, `taskReport.service.js`). Farqi UCHTA va
 * hammasi biznes qarori:
 *
 *   1. JARIMA YO'Q         — ball 0, soatlik jarima cron'i bu qatorlarni
 *                            umuman ko'rmaydi, to'xtatish va muddat
 *                            surishda ham jarima yozilmaydi.
 *   2. IKKINCHI TOMON YO'Q — "Tekshiruvda" bosqichi o'tkazib yuboriladi:
 *                            xodim topshirgani darhol "Yakunlangan".
 *   3. FAQAT O'ZIGA        — ijrochi har doim yaratuvchining O'ZI.
 *
 * ⚠️ BU FAYL — ORKESTRATSIYA, IKKINCHI DVIGATEL EMAS. Bu yerda bitta ham
 * mustaqil SQL, bitta ham mustaqil tekshiruv ro'yxati yo'q: sarlavha
 * uzunligi, muddat chegarasi, yakunlash qoidalari (nechta fayl, izoh
 * majburiymi), havolalar, vaqt holati, tarix yozilishi va hisobot —
 * hammasi mavjud servislardan o'qiladi. Ikkinchi nusxa bo'lsa, bugun bir
 * xil ko'rinadigan ikki ekran ertaga boshqa-boshqa qoidalar bilan
 * ishlardi (`finance.md` — "formula bitta joyda" doktrinasi).
 *
 * ⚠️ EGALIK DOIRA ORQALI: `taskScope.selfScope(userId)` →
 * `{ assignee, selfAssigned: true }`. Shu tufayli tahrirlash, to'xtatish,
 * muddat surish, qayta ochish va o'chirish uchun yangi funksiya
 * yozilmadi — AYNI `task.service.js` funksiyalari ishlaydi, faqat doira
 * boshqa va u har amalda qayta tekshiriladi.
 *
 * ⚠️ IKKI OQIM BIR JADVALDA, LEKIN HECH QAYERDA ARALASHMAYDI
 * (`self_assigned` ustuni): har bir ro'yxat, sanoqchi va hisobot ANIQ bir
 * tomonni oladi. Aralashsa, jarimasiz va o'zi yopiladigan shaxsiy
 * topshiriqlar rahbar bergan ishning bajarilish foizini jimgina ko'tarib
 * yuborardi.
 */

const taskService = require("./task.service");
const taskScheduleService = require("./taskSchedule.service");
const taskReportService = require("./taskReport.service");
const taskScopeService = require("./taskScope.service");
const { getTaskSettings } = require("./settings.service");
const { config } = require("../config/env.config");
const { ForbiddenError } = require("../utils/errors");

// Oqim kesimi — har bir chaqiruvga uzatiladigan YAGONA bayroq
const SELF = { selfAssigned: true };

// ─── XODIMNING O'Z EKRANI (ruxsat kalitisiz, id tokendan) ──────────

/**
 * BIR MARTALIK shaxsiy topshiriq.
 *
 * ⚠️ `assigneeIds` va `penaltyPoints` SO'ROVDAN OLINMAYDI: ijrochi
 * tokendagi odamning o'zi, ball esa 0. `createTasks` buni qayta
 * tekshiradi (panel tugmasiga ishonilmaydi).
 *
 * @param {object} body - title, description, startDate, dueDate, kind, links
 * @param {string} userId
 * @param {object[]} [files]
 */
const createSelfTask = async (body, userId, files = []) => {
  const [task] = await taskService.createTasks({
    title: body.title,
    description: body.description,
    startDate: body.startDate,
    dueDate: body.dueDate,
    kind: body.kind,
    links: body.links,
    assigneeIds: [userId],
    createdBy: userId,
    files,
    ...SELF,
  });
  return task;
};

/**
 * DOIMIY shaxsiy ish ("har dushanba hisobot yozish").
 *
 * ⚠️ Qoida yaratilishi bilan oldinga qarab topshiriqlarni DARHOL yozadi
 * (`materializeSchedule`) — "yaratdim, lekin hech narsa ko'rinmayapti"
 * holati bo'lmasligi uchun. Qoidadan yozilgan topshiriq ham shaxsiy
 * oqimda qoladi (`TaskSchedule.selfAssigned` → `Task.selfAssigned`).
 */
const createSelfSchedule = (body, userId, files = []) =>
  taskScheduleService.createSchedule({ ...body, files }, userId, null, SELF);

const listSelfTasks = (userId, req) =>
  taskService.getMyTasks(userId, req, SELF);

/**
 * XODIMNING O'Z HISOBLAGICHLARI + FORMA QOIDALARI.
 *
 * ⚠️ YARATISH QOIDALARI (`createRules`) HAM SHU YERDAN. Panel ularni
 * `/tasks/settings` dan ola olmaydi: u yo'l `tasks.view` / `tasks.settings`
 * kabi kalitlar ortida, oddiy xodimda esa ular yo'q. Usiz forma sarlavha
 * va tavsif uzunligini TAXMIN qilardi va filial sozlamasi boshqa bo'lsa,
 * xodim faqat serverdan qaytgan xato bilan bilib olardi.
 */
const getSelfStats = async (userId) => {
  const [stats, settings] = await Promise.all([
    taskService.getTaskStats(taskScopeService.selfScope(userId), SELF),
    getTaskSettings(),
  ]);

  return {
    ...stats,
    createRules: {
      minTitleLength: settings.minTitleLength,
      minDescriptionLength: settings.minDescriptionLength,
      minLeadHours: settings.minLeadHours,
      requireCreateAttachments: settings.requireCreateAttachments,
      // ⚠️ HAJM CHEGARASI PANELGA HAM BERILADI: usiz panel katta faylni
      // yuborib qo'yardi va foydalanuvchi "CORS xatosi" ni ko'rardi —
      // chegaraga urilgan so'rovni oldingi qavat rad etadi va uning
      // javobida CORS sarlavhalari bo'lmaydi (`task.service.js` izohi).
      maxFileSizeMb: config.maxUploadFileSizeMb,
    },
  };
};

const listSelfSchedules = (req, userId) =>
  taskScheduleService.listSchedules(req, taskScopeService.selfScope(userId), SELF);

// ─── BOSHQARUVCHI EKRANI (`tasks.self`) ───────────────────────────

/**
 * DASHBOARD VA HISOBOT — Lavozimlar markazidagi dvigatelning O'ZI, faqat
 * shaxsiy oqim kesimida.
 *
 * ⚠️ `full: false` — yetakchilar, e'tibor talab qiladiganlar, rollar va
 * topshiriq beruvchilar reytingi QAYTARILMAYDI: ular `tasks.reports`
 * ortidagi kesim (`taskReport.service.js` dagi izoh). `tasks.self`
 * kalitining o'zi ularni ochib bermasligi kerak.
 *
 * ⚠️ "Topshiriq beruvchilar" kesimi shaxsiy oqimda ma'nosiz ham: beruvchi
 * har doim ijrochining o'zi.
 *
 * @param {object} query - period | from/to
 * @param {object} scope - `resolveSelfViewScope` natijasi
 */
const getSelfOverview = (query, scope) =>
  taskReportService.getTaskReport({ ...query, scope, full: false, ...SELF });

/**
 * Boshqaruvchi uchun ro'yxat — xodim, holat, vaqt holati, tur va qidiruv
 * bo'yicha. Doira `resolveSelfViewScope` dan (butun filial yoki o'z
 * bo'limi).
 */
const listAllSelfTasks = (req, scope) => taskService.getTasks(req, scope, SELF);

/**
 * ⚠️ ZAXIRA QAVAT. Route allaqachon `tasks.self` ni talab qiladi, lekin
 * doira `none` bo'lib qolishi mumkin (kalitlar keyin o'zgarsa) — u paytda
 * so'rov JIM ochilib ketmasligi kerak (fail closed, `applyScope`
 * doktrinasi).
 */
const assertSelfViewScope = (scope) => {
  if (!scope || scope.mode === taskScopeService.SCOPE_NONE) {
    throw new ForbiddenError("Xodimlarning shaxsiy topshiriqlarini ko'rishga ruxsat yo'q");
  }
};

module.exports = {
  SELF,
  createSelfTask,
  createSelfSchedule,
  listSelfTasks,
  getSelfStats,
  listSelfSchedules,
  getSelfOverview,
  listAllSelfTasks,
  assertSelfViewScope,
};
