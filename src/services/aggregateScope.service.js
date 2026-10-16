/**
 * UMUMIY KO'RINISH — "barcha filiallar birga" rejimining XAVFSIZLIK YADROSI.
 *
 * Tizim egasi filial almashtirgichdan "Umumiy" ni tanlaganda u bitta filial
 * schema'siga emas, BARCHA filiallarga qaraydi: ro'yxatlar birlashadi va har
 * qatorga u qaysi filialdan kelgani yoziladi (`_branch`).
 *
 * BU FAYL BITTA SAVOLGA JAVOB BERADI: "kim, qaysi filiallarni ko'radi va
 * qaysi filialga yozadi". Birlashtirish mantig'i
 * `helpers/aggregateMerge.helpers.js` da, so'rovni filiallar bo'ylab
 * yuborish `middleware/aggregate.middleware.js` da.
 *
 * ⚠️ UCHTA O'ZGARMAS QOIDA (buzilsa butun filiallashtirish ma'nosini
 * yo'qotadi):
 *
 *  1. **Umumiy ko'rinish FAQAT TIZIM EGASIGA.** Tekshiruv har so'rovda
 *     QAYTA bajariladi va rol JORIY FILIALDAN o'qiladi (`User.role`
 *     filialga xos — root `CLAUDE.md`), tokendan EMAS: token berilgandan
 *     keyin rol olib qo'yilishi mumkin.
 *
 *  2. **Umumiy ko'rinish — mavjud huquqlar YIG'INDISI, yangi huquq EMAS.**
 *     Ro'yxatga faqat odam o'zi KIRA OLADIGAN filiallar tushadi
 *     (`accessibleBranches`, `auth.service.availableBranchesFor` bilan
 *     AYNI manba). Shu sababli "umumiy" orqali hech kim yangi filial
 *     ma'lumotini ko'rib olmaydi.
 *
 *  3. **Yozuv HAR DOIM AYNAN BITTA FILIALDA bajariladi.** "Hamma filialga
 *     yozish" degan yo'l YO'Q: qator qaysi filialda bo'lsa, yozuv o'sha
 *     filial kontekstida, o'sha filialning tranzaksiyasida ketadi
 *     (`resolveWriteBranch`). Aks holda "qaysi filialga yozildi" degan
 *     JIM xato tug'ilardi — eng qimmat xato turi.
 */

const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const branchService = require("./branch.service");
const userDirectory = require("./userDirectory.service");
const { hasRole } = require("../utils/permissions");
const { ROLES, ALL_BRANCHES_ID } = require("../utils/constants");
const {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} = require("../utils/errors");

/**
 * Umumiy ko'rinish ochiq bo'lishi uchun kerakli eng kam filial soni.
 *
 * Bitta filialda "umumiy" ning ma'nosi yo'q — u o'sha filialning o'zi.
 * Almashtirgichda ham ko'rsatilmaydi (`auth.service.canViewAllBranches`).
 */
const MIN_BRANCHES = 2;

/**
 * Xatoga MASHINA O'QIYDIGAN sabab qo'shadi.
 *
 * ⚠️ `ForbiddenError` va `NotFoundError` konstruktorida `details` yo'q
 * (`utils/errors.js` — faqat `BadRequestError`/`ConflictError` da bor), lekin
 * panel sababni matndan emas, `details.reason` dan o'qiydi. Umumiy ko'rinishda
 * bu MUHIM: "filial tanlang" va "ruxsat yo'q" bir xil ko'rinmasligi kerak.
 * Shu sababli umumiy xato sinflariga tegilmaydi — sabab shu yerda qo'shiladi.
 */
const withReason = (error, details) => Object.assign(error, { details });

/**
 * Foydalanuvchi KIRA OLADIGAN filiallar (to'liq qatorlar, `schemaName` bilan).
 *
 * `auth.service.availableBranchesFor` AYNI shu funksiyadan o'qiydi — ikkita
 * haqiqat manbai bo'lsa, biri "almashtirish mumkin" deb, ikkinchisi
 * "umumiyda ko'rinadi" deb boshqa ro'yxat berardi.
 *
 * @param {object} user - `req.user` (yoki roli o'qilgan profil)
 * @returns {Promise<object[]>}
 */
const accessibleBranches = async (user) => {
  if (hasRole(user, ROLES.OWNER)) return branchService.listUsable();

  const access = await userDirectory.listAccess(user.id);
  const rows = await Promise.all(
    access.map((row) => branchService.findById(row.branchId)),
  );

  return rows.filter(
    (b) => b && !b.isArchived && b.isActive && b.status === "ready",
  );
};

/**
 * Umumiy ko'rinishga HUQUQ bormi? (almashtirgichda ko'rsatish uchun)
 *
 * @param {object} user
 * @param {object[]} [branches] - allaqachon o'qilgan ro'yxat
 * @returns {Promise<boolean>}
 */
const canViewAll = async (user, branches) => {
  if (!hasRole(user, ROLES.OWNER)) return false;
  const list = branches ?? (await accessibleBranches(user));
  return list.length >= MIN_BRANCHES;
};

/**
 * Umumiy ko'rinish uchun "joriy filial" o'rniga qaytariladigan yorliq.
 *
 * Mijozga haqiqiy filial kabi ko'rinadi (`id`, `name`), lekin `isAggregate`
 * bayrog'i bilan: panel shu bayroqqa qarab "Umumiy" holatini biladi va
 * filialga xos tugmalarni yopadi.
 */
const AGGREGATE_BRANCH = Object.freeze({
  id: ALL_BRANCHES_ID,
  code: "all",
  name: "Umumiy (barcha filiallar)",
  shortName: "Umumiy",
  isAggregate: true,
});

/** Mijozga chiqadigan qisqa filial shakli (`auth.service.publicBranch` nusxasi). */
const publicBranch = (branch) =>
  branch
    ? {
        id: branch.id,
        code: branch.code,
        name: branch.name,
        shortName: branch.shortName || branch.name,
      }
    : null;

/**
 * UY FILIALI — umumiy rejimdagi "langar".
 *
 * Umumiy rejimda ham ba'zi so'rovlar AYNAN BITTA filialda bajarilishi kerak:
 * `/auth/me`, shaxsiy ekranlar, sozlamalar. Ularning filiali — odamning o'z
 * (uy) filiali; u ro'yxatda bo'lmasa (reyestr qoldiqi) birinchi kiradigan
 * filial olinadi.
 *
 * @param {string} userId
 * @param {object[]} branches - `accessibleBranches` natijasi
 * @returns {Promise<object>}
 */
const resolveAnchor = async (userId, branches) => {
  const entry = await userDirectory.findByUserId(userId);
  const home = entry ? branches.find((b) => b.id === entry.branchId) : null;
  return home ?? branches[0];
};

/**
 * SO'ROV UCHUN UMUMIY KONTEKST — dispatcher shuni oladi.
 *
 * Tartib ataylab shunday: avval langar filial topiladi, keyin AYNAN O'SHA
 * filialdan profil o'qiladi va roli tekshiriladi. Profil o'qilmasdan
 * filiallar ro'yxatini qurib bo'lmaydi, chunki ro'yxat rolga bog'liq.
 *
 * @param {object} decoded - `verifyToken` natijasi (imzosi tekshirilgan)
 * @returns {Promise<{user: object, anchor: object, branches: object[]}>}
 */
const resolveScope = async (decoded) => {
  const entry = await userDirectory.findByUserId(decoded.id);
  const anchorCandidate = entry
    ? await branchService.findById(entry.branchId)
    : await branchService.getDefaultBranch();

  if (!anchorCandidate) {
    throw new UnauthorizedError(
      "Filial aniqlanmadi — administratorga murojaat qiling",
    );
  }

  const user = await runWithBranch(anchorCandidate, () =>
    prisma.user.findUnique({
      where: { id: decoded.id },
      select: {
        id: true,
        role: true,
        extraRoles: true,
        isActive: true,
        isArchived: true,
      },
    }),
  );

  if (!user) throw new UnauthorizedError("Foydalanuvchi topilmadi");
  if (!user.isActive) throw new UnauthorizedError("Sizning hisobingiz faol emas");
  if (user.isArchived) throw new UnauthorizedError("Sizning hisobingiz arxivlangan");

  // ⚠️ ROL HAR SO'ROVDA QAYTA TEKSHIRILADI (qoida 1): tokenda rol yo'q va
  // bo'lishi ham kerak emas.
  if (!hasRole(user, ROLES.OWNER)) {
    throw withReason(
      new ForbiddenError("Umumiy ko'rinish faqat tizim egasi uchun"),
      { reason: "aggregate_forbidden" },
    );
  }

  const branches = await accessibleBranches(user);

  if (branches.length < MIN_BRANCHES) {
    throw new ConflictError(
      "Umumiy ko'rinish uchun kamida ikkita filial kerak — filialni tanlang",
      { reason: "aggregate_unavailable" },
    );
  }

  const anchor = (await resolveAnchor(user.id, branches)) ?? anchorCandidate;

  return { user, anchor, branches };
};

/**
 * YOZUV QAYSI FILIALGA KETADI — umumiy rejimdagi eng nozik savol.
 *
 * Ikki manba, shu tartibda:
 *
 *  1. `X-Branch-Id` sarlavhasi — panel qatorning O'Z filialini yuboradi
 *     (ro'yxatdagi har qator `_branch` bilan keladi). Qiymat RUXSAT
 *     RO'YXATIGA solishtiriladi, ya'ni sarlavha bilan begona filialga
 *     yozib bo'lmaydi.
 *  2. Yo'lning o'zidagi id (`locate` qoidasi, `aggregateRoute.registry.js`):
 *     server o'sha id ni filiallar bo'ylab qidiradi va TOPILGAN filialda
 *     bajaradi. Shu tufayli ko'pchilik tahrir/bekor qilish amallari
 *     paneldan hech narsa yubormasdan ishlaydi.
 *
 * ⚠️ IKKI FILIALDAN TOPILSA — RAD ETILADI. Tizim egasining qatori har
 * filialda AYNI `id` bilan turadi (filial seed'i), ya'ni "qaysi biri"
 * degan savol haqiqatan ham noaniq. Taxmin qilib yozish — jim xato;
 * shuning uchun panel aniq filialni ko'rsatishi talab qilinadi.
 *
 * @param {object} params
 * @param {object[]} params.branches - ruxsat etilgan filiallar
 * @param {string} [params.headerBranchId] - `X-Branch-Id`
 * @param {{model: string, param: string}|null} [params.locate]
 * @param {object} [params.params] - yo'l parametrlari (`req.params`)
 * @returns {Promise<object>} filial qatori
 */
const resolveWriteBranch = async ({
  branches,
  headerBranchId,
  locate = null,
  params = {},
}) => {
  if (headerBranchId) {
    if (headerBranchId === ALL_BRANCHES_ID) {
      throw new BadRequestError(
        "Umumiy ko'rinishda yozuv uchun aniq filial kerak",
        { reason: "branch_required" },
      );
    }

    const branch = branches.find((b) => b.id === headerBranchId);
    if (!branch) {
      // Ruxsat yo'q yoki filial ishga yaroqli emas — ikkalasi ham bir xil
      // javob beradi: mavjudligini oshkor qilishning hojati yo'q.
      throw withReason(
        new ForbiddenError("Bu filialga yozish huquqingiz yo'q"),
        { reason: "branch_forbidden" },
      );
    }
    return branch;
  }

  if (locate) {
    const id = params?.[locate.param];
    if (id) {
      const found = await locateBranchesById(branches, locate.model, id);

      if (found.length === 1) return found[0];
      if (found.length === 0) {
        throw withReason(
          new NotFoundError("Yozuv birorta filialda topilmadi"),
          { reason: "row_not_found" },
        );
      }
      throw new ConflictError(
        "Bu yozuv bir nechta filialda bor — filialni tanlang",
        { reason: "branch_ambiguous", branches: found.map(publicBranch) },
      );
    }
  }

  throw new ConflictError(
    "Umumiy ko'rinishda bu amal uchun filialni tanlang",
    { reason: "branch_required" },
  );
};

/**
 * Berilgan `id` qaysi filial(lar)da bor.
 *
 * ⚠️ Model nomi FAQAT registrdan keladi (`aggregateRoute.registry.js`),
 * so'rovdan EMAS: aks holda mijoz istalgan jadvalni so'rab tekshirib
 * ko'rardi.
 *
 * @param {object[]} branches
 * @param {string} model - Prisma model nomi ("user", "monthlyInvoice")
 * @param {string} id
 * @returns {Promise<object[]>}
 */
const locateBranchesById = async (branches, model, id) => {
  const hits = await Promise.all(
    branches.map(async (branch) => {
      try {
        const row = await runWithBranch(branch, () =>
          prisma[model].findUnique({ where: { id }, select: { id: true } }),
        );
        return row ? branch : null;
      } catch {
        // Bitta filialdagi xato (migratsiya orqada qolgan, jadval yo'q)
        // qolganlarini to'xtatmaydi — `branchIterator` doktrinasi.
        return null;
      }
    }),
  );

  return hits.filter(Boolean);
};

module.exports = {
  MIN_BRANCHES,
  withReason,
  AGGREGATE_BRANCH,
  accessibleBranches,
  canViewAll,
  resolveScope,
  resolveAnchor,
  resolveWriteBranch,
  locateBranchesById,
  publicBranch,
};
