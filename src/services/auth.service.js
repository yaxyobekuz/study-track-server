/**
 * Autentifikatsiya — FILIALGA yo'naltirish shu yerda boshlanadi.
 *
 * Login ikki qadam:
 *   1) platformada `UserDirectory` bo'yicha username → qaysi filial,
 *   2) o'sha filial schema'sida `User` o'qiladi va parol tekshiriladi.
 *
 * Parol platformada SAQLANMAYDI — u `User` qatorida, filial ichida qoladi.
 * Yo'naltirgich faqat "qayerga qarash kerak"ligini biladi.
 */

const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { generateToken, generateJti, verifyToken } = require("../utils/jwt");
const { matchPassword } = require("../utils/password");
const {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} = require("../utils/errors");
const { ROLES } = require("../utils/constants");
const logger = require("../utils/logger");
const { allRoles, hasRole } = require("../utils/permissions");
const branchService = require("./branch.service");
const userDirectory = require("./userDirectory.service");
const securityService = require("./security.service");

/**
 * SOXTA BCRYPT HASH — vaqtni tenglashtirish uchun.
 *
 * ⚠️ Bu SIR EMAS va bo'lishi ham shart emas: `matchPassword` unga
 * hech qachon mos kelmaydi (`$2b$10$` prefiksi va tasodifiy tuz).
 * Yagona vazifasi — bcrypt'ni bir marta ishga tushirib, "bunday login
 * yo'q" javobini "parol noto'g'ri" javobi bilan bir xil vaqtda
 * qaytarish.
 */
const DUMMY_HASH =
  "$2b$10$CwTycUXWue0Thq9StjUM0uJ8e8Vv1qkP1E1t.6C0m6qKq7Zz9Zz9O";

/** Mijozga chiqadigan qisqa filial shakli. */
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
 * Foydalanuvchi kira oladigan filiallar.
 *
 * OWNER — hammasi: u har filial schema'sida avtomatik mavjud (filial
 * ochilganda aynan o'sha `id` bilan seed qilinadi), shuning uchun unga
 * biriktirish yozuvi kerak emas.
 *
 * QOLGANLAR — faqat BIRIKTIRILGAN filiallar (`platform.user_branch_access`).
 * Ro'yxatning o'zi grant: alohida "almashtirish" ruxsati YO'Q, aks holda
 * ikkita haqiqat manbai bo'lardi.
 *
 * @param {object} user
 * @returns {Promise<object[]>}
 */
const availableBranchesFor = async (user) => {
  if (hasRole(user, ROLES.OWNER)) {
    const usable = await branchService.listUsable();
    return usable.map(publicBranch);
  }

  const access = await userDirectory.listAccess(user.id);
  const branches = await Promise.all(
    access.map((row) => branchService.findById(row.branchId)),
  );

  return branches
    .filter((b) => b && !b.isArchived && b.isActive && b.status === "ready")
    .map(publicBranch);
};

/**
 * Almashtirish tugmasi ko'rinsinmi? Ikkitadan kam filial bo'lsa — yo'q.
 * @param {object[]} available
 * @returns {boolean}
 */
const canSwitchBranch = (available = []) => available.length > 1;

/**
 * TOKENDAN MUDDATNI OLISH.
 *
 * ⚠️ `JWT_EXPIRES_IN` ni qo'lda parse qilmaymiz: sozlama o'zgarganda
 * seans ro'yxatidagi "muddati" haqiqiy token bilan mos kelmay qolardi.
 * Imzolangan yukdagi `exp` — yagona haqiqat.
 *
 * @param {string} token
 * @returns {Date}
 */
function tokenExpiry(token) {
  const decoded = verifyToken(token);
  if (decoded?.exp) return new Date(decoded.exp * 1000);
  // Imzo tekshiruvi yiqilishi mumkin emas (endigina o'zimiz imzoladik),
  // lekin qaytish yo'li bo'lsin: 30 kun — `.env` dagi standart qiymat
  return new Date(Date.now() + 30 * 24 * 3600 * 1000);
}

/**
 * Foydalanuvchini login qilish.
 *
 * ⚠️ HAR URINISH QAYD ETILADI (`security.service.js`) — o'tgani ham,
 * o'tmagani ham. Yozuv PLATFORMAGA tushadi, shuning uchun filial hali
 * aniqlanmagan holat ham qamrab olinadi.
 *
 * @param {string} username - foydalanuvchi nomi
 * @param {string} password - parol
 * @param {object} [client] - `helpers/request.helpers.js` → `clientInfo()`
 * @returns {Promise<{user: object, token: string, branch: object}>}
 */
async function login(username, password, client = {}) {
  if (!username || !password) {
    throw new BadRequestError("Username va parol majburiy");
  }

  /** Urinishni yozib, xatoni qaytaradi (chaqiruvchi `throw` qiladi). */
  const fail = (reason, error, extra = {}) => {
    securityService.recordAttempt({
      username,
      success: false,
      reason,
      client,
      ...extra,
    });
    securityService
      .checkFailedStreak({ username, client, ...extra })
      .catch(() => {});
    return error;
  };

  // ── 1. Qaysi filial? ──────────────────────
  const entry = await userDirectory.findByUsername(username);
  if (!entry) {
    // ⚠️ SOXTA PAROL TEKSHIRUVI. Xabar bir xil bo'lgani YETARLI EMAS:
    // mavjud nomda bcrypt (cost=10) ~60-100 ms ishlaydi, mavjud
    // bo'lmaganda esa javob ~1 ms da qaytardi. Bu farq tarmoq
    // shovqinidan o'nlab marta katta va hujumchi username ro'yxatini
    // shunchaki VAQTNI o'lchab yig'ib olardi.
    //
    // Shu sababli bu yerda ham bir marta bcrypt chaqiriladi — natijasi
    // ishlatilmaydi, faqat vaqtni tenglashtiradi.
    await matchPassword(password, DUMMY_HASH);

    // Ataylab bir xil xabar: mavjud username'ni oshkor qilmaslik uchun.
    // ⚠️ Yozuvda esa HAQIQAT turadi (`unknown_user`) — aynan bu qator
    // "mavjud bo'lmagan nomlar bilan urinishmoqda" degan hujumni ko'rsatadi.
    throw fail(
      "unknown_user",
      new BadRequestError("Username yoki parol noto'g'ri"),
    );
  }

  // ⚠️ FILIAL HOLATI XATOSI HAM JURNALGA TUSHADI va xabari
  // UMUMLASHTIRILADI. `getUsableById` "Filial arxivlangan", "Filial
  // hali tayyorlanmoqda" kabi aniq xabarlar tashlaydi va ular FAQAT
  // username MAVJUD bo'lganda chiqardi — ya'ni xabarning o'zi
  // "bunday login bor" deb aytib turardi. Bundan tashqari bu yo'lda
  // urinish umuman yozilmasdi.
  let branch;
  try {
    branch = await branchService.getUsableById(entry.branchId);
  } catch (error) {
    logger.warn(
      `[auth] "${username}" login qila olmadi — filial holati: ${error.message}`,
    );
    throw fail(
      "branch_unusable",
      new BadRequestError("Username yoki parol noto'g'ri"),
      { userId: entry.id, branchId: entry.branchId },
    );
  }

  // ── 2. O'sha filialda parol tekshiruvi ────
  return runWithBranch(branch, async () => {
    const user = await prisma.user.findUnique({
      where: { id: entry.id },
      include: { classes: { include: { class: { select: { id: true, name: true } } } } },
    });

    const scope = { userId: entry.id, branchId: branch.id };

    if (!user || !(await matchPassword(password, user.password))) {
      throw fail(
        "bad_password",
        new BadRequestError("Username yoki parol noto'g'ri"),
        scope,
      );
    }

    if (!user.isActive) {
      throw fail(
        "inactive",
        new ForbiddenError("Sizning hisobingiz faol emas"),
        scope,
      );
    }

    if (user.isArchived) {
      throw fail(
        "archived",
        new ForbiddenError("Sizning hisobingiz arxivlangan"),
        scope,
      );
    }

    // ⚠️ `jti` TOKENDAN OLDIN tug'iladi: seans qatori va token AYNI
    // qiymatga ega bo'lishi kerak, aks holda "seansni tugat" tugmasi
    // boshqa tokenni qidirib topmasdi.
    const jti = generateJti();
    const token = generateToken(user.id, branch.id, jti);
    const available = await availableBranchesFor(user);

    securityService.recordAttempt({
      username,
      userId: user.id,
      branchId: branch.id,
      success: true,
      reason: "ok",
      client,
    });

    // ⚠️ `await` QILINMAYDI: qoidalar (bir vaqtdagi seans, yangi qurilma,
    // brute-force) bir nechta so'rov yuboradi va login javobini kutib
    // turishi kerak emas.
    securityService
      .openSession({
        user,
        branchId: branch.id,
        jti,
        expiresAt: tokenExpiry(token),
        client,
      })
      .catch(() => {});

    return {
      user: {
        id: user.id,
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        fullName: user.fullName,
        role: user.role,
        // ⚠️ `role` ASOSIY rol bo'lib qoladi (panellar va bot unga
        // tayanadi), `roles` esa BARCHA rollar — ko'p rollilik shu
        // maydondan o'qiladi.
        roles: allRoles(user),
        extraRoles: user.extraRoles || [],
        classes: user.classes.map((uc) => uc.class),
        branch: publicBranch(branch),
      },
      token,
      branch: publicBranch(branch),
      availableBranches: available,
    };
  });
}

/**
 * Joriy foydalanuvchi ma'lumotlari.
 *
 * `branch` — hozir ishlanayotgan filial (owner uni almashtirgan bo'lishi
 * mumkin), `homeBranch` — foydalanuvchining o'z filiali.
 *
 * @param {string} userId
 * @param {object} activeBranch - `req.branch`
 * @returns {Promise<object|null>}
 */
async function getMe(userId, activeBranch) {
  // ⚠️ `omit` MAJBURIY. Javob `...user` bilan tarqatiladi, ya'ni
  // `password` (bcrypt hash) va `plainPassword` (OCHIQ MATNDAGI parol)
  // to'g'ridan-to'g'ri mijozga ketardi — brauzer konsolida ham,
  // devtools tarmoq panelida ham ko'rinadigan holda. `auth.middleware`
  // va `user.service.loadUser` allaqachon shu bayroq bilan o'qiydi;
  // bu yagona chetlab o'tilgan joy edi.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    omit: { password: true, plainPassword: true },
    include: {
      classes: { include: { class: { select: { id: true, name: true } } } },
      profileImage: true,
    },
  });

  if (!user) return null;

  const entry = await userDirectory.findByUserId(userId);
  const homeBranch = entry ? await branchService.findById(entry.branchId) : null;
  const available = await availableBranchesFor(user);

  return {
    ...user,
    // Ko'p rollilik — `role` asosiy bo'lib qoladi, `roles` esa hammasi
    roles: allRoles(user),
    classes: user.classes.map((uc) => uc.class),
    profilePicture: user.profileImage || null,
    branch: publicBranch(activeBranch),
    homeBranch: publicBranch(homeBranch ?? activeBranch),
    canSwitchBranch: canSwitchBranch(available),
    availableBranches: available,
  };
}

/**
 * Filial almashtirish — yangi token qaytaradi.
 *
 * Header bilan emas, TOKEN bilan: filial imzolangan yuk ichida bo'lsa, uni
 * mijoz tomondan o'zgartirib bo'lmaydi va har so'rovda qayta tekshirish
 * shart emas.
 *
 * ⚠️ ESKI SEANS YOPILADI (`superseded`). Almashtirish har safar YANGI
 * token beradi va eskisi hali 30 kun amal qiladi — u seanslar ro'yxatida
 * ochiq qolsa, bir odamning BITTA brauzerdagi ishi "ikkita bir vaqtdagi
 * seans" bo'lib ko'rinardi va birinchi kunning o'zidayoq soxta
 * ogohlantirish chiqardi.
 *
 * @param {object} user - `req.user`
 * @param {string} branchId
 * @param {object} [context]
 * @param {object} [context.client] - `clientInfo()`
 * @param {string} [context.currentJti] - joriy tokenning `jti` si
 * @returns {Promise<{token: string, branch: object}>}
 */
async function switchBranch(user, branchId, { client = {}, currentJti } = {}) {
  if (!branchId) throw new BadRequestError("Filial tanlanmadi");

  const branch = await branchService.getUsableById(branchId);

  // ── 1. Biriktirilganmi? ───────────────────
  // Owner ISTISNO: u har filialda avtomatik mavjud (filial ochilganda aynan
  // o'sha `id` bilan seed qilinadi), shuning uchun unga biriktirish yozuvi
  // kerak emas. Qolganlar uchun ro'yxatning O'ZI — grant.
  if (!hasRole(user, ROLES.OWNER)) {
    const access = await userDirectory.findAccess(user.id, branchId);
    if (!access) {
      throw new ForbiddenError(
        `Siz "${branch.name}" filialiga biriktirilmagansiz`,
      );
    }
  }

  // ── 2. Profil haqiqatan bormi? ────────────
  // Biriktirish bor, lekin qator yo'q bo'lishi mumkin (yarim qolgan
  // biriktirish). Bu holat JIM qolmasligi kerak — token berib qo'ysak,
  // foydalanuvchi "Foydalanuvchi topilmadi" bilan tizimdan uchib chiqardi.
  const profile = await runWithBranch(branch, () =>
    prisma.user.findUnique({
      where: { id: user.id },
      select: { id: true, isActive: true },
    }),
  );

  if (!profile) {
    throw new NotFoundError(
      `"${branch.name}" filialida sizning profilingiz yo'q`,
    );
  }

  if (!profile.isActive) {
    throw new ForbiddenError(
      `"${branch.name}" filialidagi profilingiz faol emas`,
    );
  }

  const jti = generateJti();
  const token = generateToken(user.id, branch.id, jti);

  securityService
    .openSession({
      user,
      branchId: branch.id,
      jti,
      expiresAt: tokenExpiry(token),
      client,
      supersedeJti: currentJti,
    })
    .catch(() => {});

  return { token, branch: publicBranch(branch) };
}

/**
 * CHIQISH — seansni yopadi.
 *
 * ⚠️ Token BEKOR QILINMAYDI (JWT stateless), lekin seans `logout` bilan
 * yopiladi va `auth.middleware` shundan keyin uni o'tkazmaydi — ya'ni
 * amalda token ishlamay qoladi. Bu "blacklist" ning eng arzon shakli:
 * qo'shimcha jadval ham, Redis ham kerak emas.
 *
 * ⚠️ `jti` siz eski token bilan chiqilsa hech narsa qilinmaydi va bu
 * xato EMAS: mijoz baribir tokenni o'chiradi.
 *
 * @param {string} [jti]
 * @returns {Promise<{closed: number}>}
 */
async function logout(jti) {
  const closed = jti
    ? await securityService.closeSession({ jti, reason: "logout" })
    : 0;
  return { closed };
}

module.exports = {
  login,
  getMe,
  switchBranch,
  logout,
  canSwitchBranch,
  publicBranch,
};
