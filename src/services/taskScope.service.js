/**
 * KIM KIMGA TOPSHIRIQ BERADI VA KIMNIKINI KO'RADI — bitta qaror nuqtasi.
 *
 * Ikki daraja bor:
 *
 *   `tasks.view` / owner  → BUTUN FILIAL. Avvalgidek, hech narsa o'zgarmadi.
 *   `tasks.team`          → FAQAT O'Z BO'LIMI. Rahbar o'z xodimlariga
 *                           topshiriq beradi va faqat shu kesimni ko'radi.
 *
 * ⚠️ BO'LIM — LAVOZIM ORQALI (`User.positionId` → `Position.departmentId`).
 * Alohida "rahbar → xodimlar" ro'yxati ochilmadi: u darhol lavozimlar
 * katalogidan ajralib ketardi va xodim boshqa bo'limga o'tganda eski
 * rahbarida qolib ketardi. Bo'lim yagona manba.
 *
 * ⚠️ QO'SHIMCHA DARAJA, KUCHSIZLANTIRISH EMAS: `tasks.team` YANGI kalit.
 * Mavjud `tasks.view` egalariga tegilmaydi — aks holda bugun hamma
 * topshiriqni ko'rib turgan admin ertaga faqat o'z bo'limini ko'rib qolardi.
 *
 * ⚠️ TEKSHIRUV SERVERDA. Panel tugmani yashiradi, lekin qaror shu yerda:
 * `assertCanAssign` ro'yxatni har yaratishda qayta o'qiydi.
 *
 * ── UCHINCHI DARAJA: `self` ──
 *
 * `self` — XODIMNING O'ZI O'ZIGA BELGILAGAN topshiriqlari
 * (`selfTask.service.js`). Bu RUXSAT KALITI EMAS: doira id'ni tokendan
 * oladi va "bu qator menikimi" degan savolga javob beradi
 * (`/payroll/my`, `/devices/me/*` bilan AYNI doktrina).
 *
 * ⚠️ NEGA DOIRA ORQALI: shu tufayli tahrirlash, to'xtatish, muddat surish,
 * qayta ochish va o'chirish uchun IKKINCHI NUSXA yozilmadi — mavjud
 * `task.service.js` funksiyalari AYNAN O'SHA holida ishlaydi, faqat doira
 * boshqa. Alohida yozilsa, yakunlash qoidalari va tarix yozilishi ikki
 * joyda bo'lib, biri ikkinchisidan uzoqlashardi.
 */

const prisma = require("../config/prisma");
const { hasPermission, hasRole } = require("../utils/permissions");
const { ROLES } = require("../utils/constants");
const { ForbiddenError } = require("../utils/errors");

const SCOPE_ALL = "all";
const SCOPE_TEAM = "team";
// FAQAT O'ZIM O'ZIMGA BELGILAGANLARIM — ruxsat kaliti emas, egalik
const SCOPE_SELF = "self";
const SCOPE_NONE = "none";

/**
 * Xodimning bo'limi (`Position.departmentId`). Lavozimi yo'q bo'lsa `null`.
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
const getDepartmentId = async (userId) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { positionId: true },
  });
  if (!user?.positionId) return null;

  const position = await prisma.position.findUnique({
    where: { id: user.positionId },
    select: { departmentId: true },
  });
  return position?.departmentId || null;
};

/**
 * Bo'limdagi xodimlar — arxivlanganlar chiqarib tashlanadi (ularga
 * topshiriq berilmaydi, `task.service.js` → `_assertAssignableUsers`).
 * Rahbarning o'zi ham ro'yxatda: bo'lim kesimi uni ham qamraydi.
 *
 * @param {string} departmentId
 * @returns {Promise<string[]>}
 */
const getDepartmentMemberIds = async (departmentId) => {
  if (!departmentId) return [];

  const positions = await prisma.position.findMany({
    where: { departmentId },
    select: { id: true },
  });
  if (positions.length === 0) return [];

  const members = await prisma.user.findMany({
    where: {
      positionId: { in: positions.map((p) => p.id) },
      isArchived: false,
    },
    select: { id: true },
  });
  return members.map((m) => m.id);
};

/**
 * Foydalanuvchining topshiriqlar bo'yicha ko'rish/berish doirasi.
 *
 * @param {{ id: string, role: string, extraRoles?: string[], permissions?: string[] }} user
 * @returns {Promise<{ mode: "all"|"team"|"none", memberIds: string[], departmentId: string|null, where: object|null }>}
 */
const resolveTaskScope = async (user) => {
  const permissions = user?.permissions || [];

  if (hasRole(user, ROLES.OWNER) || hasPermission(permissions, "tasks.view")) {
    return { mode: SCOPE_ALL, memberIds: [], departmentId: null, where: null };
  }

  if (hasPermission(permissions, "tasks.team")) {
    const departmentId = await getDepartmentId(user.id);
    const memberIds = await getDepartmentMemberIds(departmentId);

    // Bo'limi bo'lmagan rahbar ham o'zi bergan topshiriqlarni ko'radi —
    // aks holda "berdim-u, keyin topa olmayapman" holati chiqardi.
    return {
      mode: SCOPE_TEAM,
      memberIds,
      departmentId,
      where: {
        OR: [
          ...(memberIds.length ? [{ assignee: { in: memberIds } }] : []),
          { createdBy: user.id },
        ],
      },
    };
  }

  return { mode: SCOPE_NONE, memberIds: [], departmentId: null, where: null };
};

/**
 * XODIMNING O'Z SHAXSIY TOPSHIRIQLARI doirasi — ruxsat kalitisiz.
 *
 * ⚠️ IKKI SHART BIRGA: qator `selfAssigned` BO'LISHI va ijrochi SHU ODAM
 * bo'lishi kerak. Faqat `assignee` bo'yicha tekshirilsa, xodim o'ziga
 * berilgan ODDIY topshiriqni ham shaxsiy yo'ldan — ya'ni rahbar tasdig'ini
 * chetlab o'tib va jarimasiz — yopib qo'ya olardi.
 *
 * @param {string} userId
 */
const selfScope = (userId) => ({
  mode: SCOPE_SELF,
  memberIds: [String(userId)],
  departmentId: null,
  where: { assignee: String(userId), selfAssigned: true },
});

/**
 * BOSHQARUVCHI QAYSI XODIMLARNING shaxsiy topshiriqlarini ko'radi.
 *
 * Tartib — mavjud doktrinaning o'zi: butun filial (`tasks.view` / owner) →
 * o'z bo'limi (`tasks.team`) → `tasks.self` kalitining o'zi butun filialni
 * beradi.
 *
 * ⚠️ `tasks.self` — ALOHIDA KALIT (`permissions.js`): topshiriq registrini
 * ko'rish huquqi xodimlarning o'zlariga yozgan shaxsiy rejasini ochib
 * bermasligi kerak. Shuning uchun u `tasks.view` ichidagi amal emas.
 *
 * ⚠️ `tasks.team` BIRINCHI tekshirilmaydi: bo'lim rahbari aynan o'z bo'limi
 * kesimida qoladi, lekin butun filialni ko'rish huquqi bor odam (`view`)
 * uni ham ko'rishda davom etadi.
 *
 * @param {{ id: string, role: string, extraRoles?: string[], permissions?: string[] }} user
 */
const resolveSelfViewScope = async (user) => {
  const permissions = user?.permissions || [];

  if (hasRole(user, ROLES.OWNER) || hasPermission(permissions, "tasks.view")) {
    return { mode: SCOPE_ALL, memberIds: [], departmentId: null, where: null };
  }

  if (hasPermission(permissions, "tasks.team")) {
    const departmentId = await getDepartmentId(user.id);
    const memberIds = await getDepartmentMemberIds(departmentId);
    return {
      mode: SCOPE_TEAM,
      memberIds,
      departmentId,
      // ⚠️ `createdBy` SHARTI YO'Q (oddiy doiradan farqi): shaxsiy
      // topshiriqni har doim xodimning O'ZI yozadi, ya'ni "men bergan
      // topshiriqlar" degan ikkinchi shox bu kesimda ma'nosiz — u rahbarga
      // o'zining shaxsiy rejasidan boshqa hech narsa qo'shmasdi.
      // Bo'limi bo'lmagan rahbarga hech narsa ko'rinmaydi — xato emas,
      // BO'SH ro'yxat (Prisma bo'sh `in` ni "hech biri" deb o'qiydi).
      where: { assignee: { in: memberIds } },
    };
  }

  if (hasPermission(permissions, "tasks.self")) {
    return { mode: SCOPE_ALL, memberIds: [], departmentId: null, where: null };
  }

  return { mode: SCOPE_NONE, memberIds: [], departmentId: null, where: null };
};

/**
 * Doira bo'yicha `where` ni mavjud filtr bilan BIRLASHTIRADI (ustiga yozmaydi).
 *
 * `team` ham, `self` ham shu yerdan o'tadi: ikkinchisining `where` i
 * `{ assignee, selfAssigned: true }` bo'lgani uchun qo'shimcha shoxlanish
 * kerak emas.
 *
 * ⚠️ `none` — ro'yxat huquqi umuman yo'q. Route bunday so'rovni allaqachon
 * to'sadi (`tasks.view` yoki `tasks.team` talab qilinadi), shuning uchun bu
 * yerdagi xato — ZAXIRA QAVAT: yangi yo'l qo'shilganda u jim ochilib
 * ketmasligi uchun (fail closed).
 */
const applyScope = (filter, scope) => {
  if (!scope || scope.mode === SCOPE_ALL) return filter;
  if (scope.mode === SCOPE_NONE) throw new ForbiddenError("Topshiriqlarni ko'rishga ruxsat yo'q");
  return { AND: [filter, scope.where] };
};

/** Bitta topshiriq doiraga tushadimi. */
const isInScope = (task, scope, userId) => {
  if (!scope || scope.mode === SCOPE_ALL) return true;
  if (scope.mode === SCOPE_NONE) return false;

  // ⚠️ SHAXSIY DOIRA — IKKI SHART BIRGA va `createdBy` SHOXI YO'Q.
  // Odam o'ziga ODDIY topshiriq ham bera oladi (o'z bo'limi ro'yxatida u
  // ham bor): u paytda `createdBy === assignee === userId` bo'ladi-yu,
  // `selfAssigned` esa `false` qoladi. Umumiy shox ishlatilsa, xodim shu
  // qatorni shaxsiy yo'ldan — rahbar tasdig'ini chetlab o'tib va jarimasiz
  // — yopib qo'ya olardi.
  if (scope.mode === SCOPE_SELF) {
    return task.selfAssigned === true && String(task.assignee) === String(userId);
  }

  return (
    String(task.createdBy) === String(userId) ||
    scope.memberIds.includes(String(task.assignee))
  );
};

/**
 * Tanlangan ijrochilar doiraga tushadimi — YARATISHDAN OLDIN.
 *
 * ⚠️ FAQAT `team` REJIMIDA cheklaydi. `tasks.create` egasi avvalgidek
 * butun filialga topshiriq beradi, chunki `tasks.team` — QO'SHIMCHA kalit:
 * u mavjud huquqlarni kuchsizlantirmaydi. Aks holda bugun hammaga
 * topshiriq berib turgan admin ertaga "bo'limingiz yo'q" degan xato
 * olardi (uning lavozimi bo'lmasligi mumkin).
 *
 * @param {string[]} assigneeIds
 * @param {object} scope
 */
const assertCanAssign = (assigneeIds, scope) => {
  if (!scope || scope.mode !== SCOPE_TEAM) return;

  const outside = assigneeIds.filter((id) => !scope.memberIds.includes(String(id)));
  if (outside.length > 0) {
    throw new ForbiddenError(
      "Faqat o'z bo'limingizdagi xodimlarga topshiriq bera olasiz",
    );
  }
};

/**
 * BIRIKTIRISH (QAYTA YO'NALTIRISH) DOIRASI — "Topshiriqlarim" ekranidan.
 *
 * `delegateTask` — o'ziga berilgan ishni boshqasiga biriktirish. Unga
 * RUXSAT KALITI kerak emas (qaror egalikdan kelib chiqadi), lekin
 * "kimga" degan savol HAR DOIM cheklanadi.
 *
 * ⚠️ NEGA ALOHIDA FUNKSIYA: `assertCanAssign` faqat `team` rejimini
 * cheklaydi va `none` ni ERKIN o'tkazadi — bu YARATISH yo'li uchun to'g'ri
 * (route allaqachon `tasks.create` talab qilgan, ya'ni `none` u yerga
 * yetib bormaydi). Biriktirish yo'lida esa kalit TALAB QILINMAYDI, ya'ni
 * `none` rejimidagi oddiy xodim ham shu yerga keladi. O'sha funksiya qayta
 * ishlatilsa, u butun filialga topshiriq berib yubora olardi — ruxsatlarni
 * chetlab o'tishning aynan o'zi.
 *
 * Qoida:
 *   `all`  → butun filial (avvalgidek, `tasks.view` / owner)
 *   `team` → faqat o'z bo'limi
 *   `none` → HECH KIM: biriktirish uchun yo bo'lim (`tasks.team`), yo
 *            butun filial (`tasks.view`) kerak. Oddiy xodim o'ziga
 *            berilgan ishni O'ZI bajaradi — uni birovga o'tkazish
 *            boshqaruv qarori.
 *
 * @param {string[]} assigneeIds
 * @param {object} scope
 */
const assertCanDelegate = (assigneeIds, scope) => {
  if (!scope || scope.mode === SCOPE_ALL) return;

  if (scope.mode === SCOPE_TEAM) {
    const outside = assigneeIds.filter((id) => !scope.memberIds.includes(String(id)));
    if (outside.length > 0) {
      throw new ForbiddenError(
        "Faqat o'z bo'limingizdagi xodimlarga biriktira olasiz",
      );
    }
    return;
  }

  throw new ForbiddenError(
    "Topshiriqni boshqa xodimga biriktirish uchun ruxsatingiz yo'q",
  );
};

/**
 * TOPSHIRIQ BERISH MUMKIN BO'LGAN ODAMLAR — doira bo'yicha.
 *
 * ⚠️ Nima uchun alohida yo'l: xodimlar ro'yxati (`GET /users`) `users.view`
 * ortida turadi, bo'lim rahbarida esa u bo'lmasligi mumkin. Usiz rahbar
 * "topshiriq berish" tugmasini ko'rib turib, ijrochini tanlay olmasdi.
 * Bu yo'l FAQAT ism va rolni beradi — kadrlar ro'yxatini ochmaydi.
 *
 * @param {object} scope - `resolveTaskScope` natijasi
 * @param {{ search?: string, group?: "staff"|"student", limit?: number }} options
 * @returns {Promise<Array<object>>}
 */
const getAssignableUsers = async (scope, { search, group = "staff", limit = 50 } = {}) => {
  const where = {
    isArchived: false,
    // Owner — topshiriq beruvchi, ijrochi emas (`task.service.js` ham rad etadi)
    role: group === "student" ? "student" : { notIn: ["owner", "student"] },
  };

  if (scope?.mode === SCOPE_TEAM) {
    // Bo'limi bo'lmagan rahbarga hech kim ko'rinmaydi — xato emas, bo'sh ro'yxat
    if (scope.memberIds.length === 0) return [];
    where.id = { in: scope.memberIds };
  }

  const query = String(search ?? "").trim();
  if (query) {
    where.OR = [
      { firstName: { contains: query, mode: "insensitive" } },
      { lastName: { contains: query, mode: "insensitive" } },
      { username: { contains: query, mode: "insensitive" } },
    ];
  }

  return prisma.user.findMany({
    where,
    select: { id: true, firstName: true, lastName: true, role: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: Math.min(Math.max(Number(limit) || 50, 1), 500),
  });
};

module.exports = {
  SCOPE_ALL,
  SCOPE_TEAM,
  SCOPE_SELF,
  SCOPE_NONE,
  getDepartmentId,
  getDepartmentMemberIds,
  getAssignableUsers,
  resolveTaskScope,
  resolveSelfViewScope,
  selfScope,
  applyScope,
  isInScope,
  assertCanAssign,
  assertCanDelegate,
};
