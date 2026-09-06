const prisma = require("../config/prisma");
// Rollar katalogi PLATFORMADA — barcha filiallarga umumiy
const platformPrisma = require("../config/platformPrisma");
const { getBranch, runWithBranch } = require("../config/branchContext");
const branchService = require("./branch.service");
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
} = require("../utils/errors");
const logger = require("../utils/logger");
const { hashPassword, matchPassword } = require("../utils/password");
const { generateId } = require("../utils/idGenerator");
const userDirectory = require("./userDirectory.service");
const { ROLES } = require("../utils/constants");
const { allRoles, expandLegacyKeys, normalizePermissions, hasRole } = require("../utils/permissions");
const { currentDayDate } = require("../helpers/month.helpers");

// Junction M2M larni eski tekis shaklga qaytaradi:
//   classes  → [{ id, name }]   (UserClass)
//   subjects → [{ id, name }]   (UserSubject)
// Frontend ikkalasini ham shu ko'rinishda kutadi, shuning uchun junction
// qatlami service'dan tashqariga chiqmaydi.
function flattenRelations(user) {
  if (!user) return user;
  const out = { ...user };
  if (Array.isArray(user.classes)) {
    out.classes = user.classes.map((uc) => (uc.class ? uc.class : uc));
  }
  if (Array.isArray(user.subjects)) {
    out.subjects = user.subjects.map((us) => (us.subject ? us.subject : us));
  }
  return out;
}

// `include` bloki — classes va subjects har doim birga yuklanadi, aks holda
// bir joyda bor, ikkinchisida yo'q holat kelib chiqardi.
const USER_RELATIONS = {
  classes: { include: { class: { select: { id: true, name: true } } } },
  subjects: { include: { subject: { select: { id: true, name: true } } } },
};

/**
 * Filialdagi `User` qatorini platformadagi login yo'naltirgichi bilan
 * moslashtiradi.
 *
 * Yo'naltirgichda `username` (global unique kalit) va bir nechta
 * denormalizatsiya ustuni bor: `role`, ism, `isActive`, `isArchived`. Ular
 * yig'ma hisobot va "bu rolda nechta odam bor" savoli uchun ishlatiladi,
 * ya'ni filial qatori o'zgargan har safar yangilanishi kerak.
 *
 * @param {string} id
 */
async function syncDirectory(id) {
  const branch = getBranch();
  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      username: true,
      role: true,
      firstName: true,
      lastName: true,
      isActive: true,
      isArchived: true,
    },
  });
  if (!user) return;

  await userDirectory.sync({
    id: user.id,
    username: user.username,
    branchId: branch.id,
    role: user.role,
    firstName: user.firstName,
    lastName: user.lastName ?? "",
    isActive: user.isActive,
    isArchived: user.isArchived,
  });
}


// ─────────────────────────────────────────────
// KO'P FILIALLI XODIM
// ─────────────────────────────────────────────
//
// Xodim bir nechta filialda ishlashi mumkin. Uning har filialda O'Z `User`
// qatori bor va shu qator o'z `permissions` ini olib yuradi — aynan
// shuning uchun "Chilonzorda kassir, Yunusobodda o'qituvchi" ifodalanadi.
//
// Lekin ba'zi maydonlar ODAMNING O'ZIGA tegishli, filialga emas: login,
// parol, ism va login bayroqlari. Ular hamma qatorda BIR XIL bo'lishi shart,
// aks holda odam bir filialda kira olib, boshqasida kira olmay qolardi.
//
// ⚠️ Bu maydonlarga yozadigan har qanday kod `propagateIdentity()` dan
// o'tishi kerak. To'g'ridan-to'g'ri `prisma.user.update` faqat JORIY
// filialga yozadi va qolgan nusxalar jimgina eskirib qoladi.
const IDENTITY_FIELDS = [
  "username",
  "password",
  "plainPassword",
  "firstName",
  "lastName",
  "gender",
  "isActive",
  "isArchived",
];

/**
 * Odamga tegishli maydonlarni uning BARCHA filiallaridagi qatorlariga yozadi.
 *
 * Joriy filial ham shu ro'yxatda — alohida yozish shart emas.
 *
 * @param {string} userId
 * @param {object} data - faqat `IDENTITY_FIELDS` dagi kalitlar olinadi
 * @returns {Promise<number>} nechta filialda yangilandi
 */
async function propagateIdentity(userId, data) {
  const patch = Object.fromEntries(
    Object.entries(data).filter(([key]) => IDENTITY_FIELDS.includes(key)),
  );
  if (Object.keys(patch).length === 0) return 0;

  const access = await userDirectory.listAccess(userId);
  let updated = 0;

  for (const row of access) {
    const branch = await branchService.findById(row.branchId);
    if (!branch) continue;

    try {
      await runWithBranch(branch, () =>
        prisma.user.update({ where: { id: userId }, data: patch }),
      );
      updated += 1;
    } catch (error) {
      // Qator yo'q bo'lishi mumkin (biriktirish bor, profil hali
      // yaratilmagan) — bu xato emas, o'tkazib yuboramiz.
      if (error.code !== "P2025") {
        logger.warn(
          `[user] "${branch.name}" filialida identifikatsiya yangilanmadi (${userId}): ${error.message}`,
        );
      }
    }
  }

  return updated;
}

// classes/subjects junction bilan user'ni yuklab, password'siz tekislangan
// shaklda qaytaradi
async function loadUser(id, { withPassword = false, withPlain = false } = {}) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: USER_RELATIONS,
    ...(withPassword
      ? {}
      : { omit: { password: true, plainPassword: !withPlain } }),
  });
  return flattenRelations(user);
}

async function getStats() {
  const [telegramUsers, workers, students, premiumUsers] = await Promise.all([
    prisma.tgUser.count(),
    prisma.user.count({ where: { role: { notIn: ["owner", "student"] } } }),
    prisma.user.count({ where: { role: "student", isArchived: false } }),
    prisma.premium.count({ where: { status: "active" } }),
  ]);

  return { telegramUsers, workers, students, premiumUsers };
}

// ─────────────────────────────────────────────
// KO'P ROLLILIK
// ─────────────────────────────────────────────
//
// Bir odam bir vaqtning o'zida bir nechta rolda bo'lishi mumkin:
// o'qituvchi + ma'muriyat, qabulxona + kassir.
//
// ⚠️ `role` ASOSIY BO'LIB QOLADI va uning ma'nosi zarracha o'zgarmadi.
// Butun tizimda 120 dan ortiq joy unga qarab shoxlanadi, 78 tasi esa
// BAZA DARAJASIDAGI filtr (`where: { role: "student" }`,
// `{ notIn: ["owner","student"] }`) va ular `@@index([role, isActive])`
// ga tayanadi. Massivga ko'chirilsa: (a) indekslar ishlamay qolardi,
// (b) bitta unutilgan joyda jimgina ruxsat ochilardi. `extraRoles` esa
// FAQAT AVTORIZATSIYA uchun (`hasRole`) — bitta ham filtr o'zgarmaydi.
//
// ⚠️ FILIALGA XOS. `permissions` bilan bir xil qoida: odam Chilonzorda
// o'qituvchi + kassir, Yunusobodda esa faqat o'qituvchi bo'lishi
// mumkin. Shu sababli `IDENTITY_FIELDS` ga KIRMAYDI.
//
// ⚠️ FAQAT OWNER TAHRIRLAYDI (`user.routes.js` dagi `authorize(OWNER)`).

/**
 * ⚠️ QO'SHIMCHA ROL SIFATIDA HAR QANDAY ROL BERILADI — cheklov YO'Q.
 *
 * Ilgari `owner` va `student` taqiqlangan edi. Taqiq OLIB TASHLANDI:
 * bu ro'yxatni faqat tizim EGASI tahrirlaydi (`authorize(ROLES.OWNER)`)
 * va u nima qilayotganini biladi — "kim kimga nima bera oladi" degan
 * qaror unga tegishli, kodga emas.
 *
 * Ikki holatning oqibati foydalanuvchiga OCHIQ aytiladi (admin
 * paneldagi oyna ogohlantiradi):
 *
 *   owner   — TO'LIQ HUQUQ. To'rtala ruxsat darvozasi uni ko'rganda
 *             hech narsa tekshirmasdan o'tkazadi (`hasRole(user,
 *             ROLES.OWNER)`), ya'ni bu odam butun tizimga va barcha
 *             filiallarga ega bo'ladi.
 *
 *   student — O'quvchi panelining yo'llarini ochadi, LEKIN moliya
 *             invariantlariga TEGMAYDI: "bu odam o'quvchimi" degan
 *             savol butun kodbazada `role === "student"` skalyari
 *             bilan o'qiladi (`hasRole` bilan HECH QAYERDA emas), ya'ni
 *             xodimga hisob-faktura ochilmaydi va o'qish davri
 *             yaratilmaydi.
 *
 * ⚠️ ASOSIY ROLI `owner` bo'lgan qatorga baribir tegilmaydi — u har
 * filialda avtomatik seed qilinadi (`initOwner`) va uni tahrirlash
 * boshqa mexanizmni buzardi.
 */

/**
 * Foydalanuvchining qo'shimcha rollarini almashtiradi (to'liq ro'yxat).
 *
 * ⚠️ RUXSATLAR QO'SHILADI, KAMAYTIRILMAYDI. Yangi rol berilganda o'sha
 * rolning boshlang'ich ruxsatlari mavjudlariga QO'SHILADI; rol olib
 * tashlanganda esa ruxsatlar TEGILMAYDI. Sabab: ruxsat — mustaqil
 * qaror (Ruxsatlar sahifasida qo'lda sozlanadi), rol esa faqat
 * boshlang'ich to'plamni beradi. Rol olib tashlanganda ruxsatni ham
 * yechib olsak, xodimning qo'lda berilgan huquqlari jimgina yo'qolardi.
 *
 * @param {string} userId
 * @param {string[]} extraRoles - yangi to'liq ro'yxat
 * @param {object} actor - amalni bajarayotgan (owner)
 * @returns {Promise<object>} - yangilangan foydalanuvchi
 */
async function setExtraRoles(userId, extraRoles, actor) {
  const target = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, extraRoles: true, permissions: true },
  });
  if (!target) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (target.role === ROLES.OWNER) {
    throw new ForbiddenError("Owner rollarini o'zgartirib bo'lmaydi");
  }

  const wanted = [
    ...new Set((extraRoles || []).map((r) => String(r).trim()).filter(Boolean)),
  ];

  // Asosiy rol ro'yxatda takrorlanmasin — aks holda "ikkita rol" ko'rinib,
  // aslida bitta bo'lardi
  const next = wanted.filter((r) => r !== target.role);

  // Rollar PLATFORMADA — mavjudligini o'sha yerdan tekshiramiz
  if (next.length > 0) {
    const known = await platformPrisma.role.findMany({
      where: { value: { in: next } },
      select: { value: true },
    });
    const knownSet = new Set(known.map((r) => r.value));
    const unknown = next.filter((r) => !knownSet.has(r));
    if (unknown.length > 0) {
      throw new BadRequestError(`Noma'lum rol: ${unknown.join(", ")}`);
    }
  }

  const before = target.extraRoles || [];
  const added = next.filter((r) => !before.includes(r));
  const removed = before.filter((r) => !next.includes(r));

  // ── RUXSATLARNI QAYTA HISOBLASH ──────────────────────────────────
  //
  // Rol berilganda uning ruxsatlari QO'SHILADI, olib tashlanganda esa
  // QAYTARIB OLINADI — ikkalasi ham avtomatik. Ilgari faqat qo'shish
  // avtomat edi va olib tashlangan rolning huquqlari xodimda qolib
  // ketardi: rol ro'yxatda ko'rinmasa-yu, u bergan bo'limlar ochiq
  // tursa, "bu odam nimaga kira oladi" degan savolga javob
  // ro'yxatdan chiqmasdi.
  //
  // ⚠️ QAYSI RUXSAT QAYTARIB OLINADI. Faqat olib tashlangan rolning
  // standart ruxsatlari va faqat ular QOLGAN rollarning birortasida
  // BO'LMASA. Ya'ni asosiy rol yoki boshqa qo'shimcha rol o'sha
  // ruxsatni baribir berayotgan bo'lsa, u joyida qoladi — aks holda
  // ikkita rolga ega odamdan bittasini olish uni ikkalasidan ham
  // mahrum qilardi.
  //
  // ⚠️ CHEKLOV, ochiq aytilgan: ruxsatning "kimdan kelgani" saqlanmaydi.
  // Agar xodimga "Ruxsatlar" tabidan QO'LDA berilgan ruxsat olib
  // tashlanayotgan rolning standartida ham bo'lsa, u ham qaytarib
  // olinadi. Provenansni saqlash uchun alohida jadval kerak bo'lardi;
  // amalda esa qo'lda berilgan ruxsat rol standartidan tashqarida
  // bo'ladi, shuning uchun bu holat kamdan-kam uchraydi.
  const roleValues = [...new Set([target.role, ...next, ...removed])];
  const roleRows = roleValues.length
    ? await platformPrisma.role.findMany({
        where: { value: { in: roleValues } },
        select: { value: true, permissions: true },
      })
    : [];

  const defaultsOf = new Map(
    roleRows.map((row) => [row.value, expandLegacyKeys(row.permissions || [])]),
  );

  // Qoladigan rollar bergan ruxsatlar — ular hech qachon o'chirilmaydi
  const keep = new Set(
    [target.role, ...next].flatMap((value) => defaultsOf.get(value) ?? []),
  );

  // Olib tashlangan rollar bergan, lekin qolganlarda YO'Q ruxsatlar
  const revoke = new Set(
    removed
      .flatMap((value) => defaultsOf.get(value) ?? [])
      .filter((key) => !keep.has(key)),
  );

  const granted = added.flatMap((value) => defaultsOf.get(value) ?? []);

  // ⚠️ `expandLegacyKeys` `normalizePermissions` DAN OLDIN turadi.
  // Eski yozuvlarda ruxsat amalga bo'linmagan bare bo'lim kaliti
  // bo'lishi mumkin (`"users"` — "users bo'limining hammasi").
  // `normalizePermissions` esa faqat katalogdagi aniq kalitlarni
  // qoldiradi, ya'ni bare kalit JIMGINA TASHLANARDI va xodim rol
  // berilgan zahoti eski huquqlarini yo'qotardi.
  //
  // ⚠️ FILTR `normalizePermissions` DAN OLDIN: u har bo'limga
  // `.view` ni avtomat qo'shadi, ya'ni filtrdan keyin ishlatilsa
  // olib tashlangan bo'limning `.view` i qaytib kelardi.
  const permissions = normalizePermissions(
    expandLegacyKeys([...(target.permissions || []), ...granted]).filter(
      (key) => !revoke.has(key),
    ),
  );

  await prisma.user.update({
    where: { id: userId },
    data: { extraRoles: next, permissions },
  });

  logger.info(
    `[roles] ${userId} qo'shimcha rollari: [${next.join(", ") || "—"}] ` +
      `(+${added.length} / -${removed.length}, ` +
      `${revoke.size} ruxsat qaytarib olindi, aktyor: ${actor?.id ?? "—"})`,
  );

  return loadUser(userId);
}

/**
 * "Bu odamni shu xodim boshqara oladimi?" — YAGONA JOY.
 *
 * ⚠️ Qoida FAQAT O'QITUVCHIGA tegishli. Qabulxona va ma'muriyat butun
 * ro'yxatni boshqaradi (ularning ishi shu), o'qituvchi esa faqat O'ZI
 * QO'SHGAN o'quvchini: `users.update` ruxsati unga berilganda ham u
 * boshqa o'qituvchining o'quvchisini tahrirlay olmasligi kerak.
 *
 * ⚠️ `createdBy = null` — "hech kim qo'shmagan" (tizimga o'tishdan
 * oldingi qatorlar). Ular o'qituvchiga OCHILMAYDI: eski ma'lumot
 * egasizligi sababli hammaga ochiq bo'lib qolardi.
 *
 * Owner bu funksiyaga umuman kelmaydi — `authorizePermission` uni
 * yuqorida o'tkazib yuboradi.
 *
 * @param {string} targetId - kimga tegilyapti
 * @param {{ id: string, role: string }} actor - amalni bajarayotgan xodim
 */
async function assertCanManageUser(targetId, actor) {
  // Ko'p rollilik — qo'shimcha `teacher` roli olgan odam ham shu
  // cheklovga tushadi, aks holda u haqiqiy o'qituvchidan ko'proq
  // huquq olardi
  if (!actor || !hasRole(actor, ROLES.TEACHER)) return;

  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, role: true, createdBy: true },
  });

  if (!target) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (target.role !== ROLES.STUDENT) {
    throw new ForbiddenError("O'qituvchi faqat o'quvchilarni boshqara oladi");
  }

  if (target.createdBy !== actor.id) {
    throw new ForbiddenError("Faqat o'zingiz qo'shgan o'quvchini boshqara olasiz");
  }
}

/**
 * Barcha foydalanuvchilarni sahifalangan holda olish.
 */
async function getAllUsers(query, actor = null) {
  const {
    role,
    class: classId,
    page = 1,
    limit = 24,
    search,
    archived,
    createdBy,
  } = query;

  const where = {};

  // "Faqat men qo'shganlar" — o'qituvchining ro'yxati. `me` ataylab
  // qo'llab-quvvatlanadi: frontend o'z id sini bilishi shart emas va
  // boshqa xodimning id sini yozib qo'yish ham mumkin bo'lmaydi.
  if (createdBy === "me") {
    // Aktyor yo'q bo'lsa (skript chaqiruvi) filtr qo'llanmaydi
    if (actor?.id) where.createdBy = actor.id;
  } else if (createdBy) {
    where.createdBy = String(createdBy);
  }
  // "staff" — rol emas, guruh: o'quvchilardan boshqa hamma (admin paneldagi
  // "Xodimlar" tabi shu bilan ishlaydi). Owner ham xodim — ro'yxatdan
  // yo'qolmasligi uchun chiqarib tashlanmaydi.
  if (role === "staff") where.role = { not: "student" };
  else if (role) where.role = role;
  if (classId) where.classes = { some: { classId } };

  // Arxivlangan tab faqat arxivlanganlarni, Asosiy tab esa qolganlarni ko'rsatadi
  if (archived === "true" || archived === true) {
    where.isArchived = true;
  } else {
    where.isArchived = false;
  }

  if (search && search.trim()) {
    const s = search.trim();
    where.OR = [
      { firstName: { contains: s, mode: "insensitive" } },
      { lastName: { contains: s, mode: "insensitive" } },
      { username: { contains: s, mode: "insensitive" } },
    ];
  }

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      omit: { password: true, plainPassword: true },
      include: USER_RELATIONS,
      orderBy: { createdAt: "desc" },
      skip,
      take: limitNum,
    }),
  ]);

  // Har bir foydalanuvchi uchun effektiv default ish vaqti (rol → user merosi).
  const roles = await platformPrisma.role.findMany({
    select: { value: true, workStartTime: true, workEndTime: true },
  });
  const roleMap = {};
  roles.forEach((r) => {
    roleMap[r.value] = r;
  });

  const usersWithSchedule = users.map((u) => {
    const obj = flattenRelations(u);
    if (u.role === "student" || u.role === "owner") {
      obj.effectiveSchedule = null;
    } else {
      const role = roleMap[u.role];
      const hasUserOverride = u.workStartTime && u.workEndTime;
      obj.effectiveSchedule = {
        workStartTime: hasUserOverride
          ? u.workStartTime
          : role?.workStartTime || null,
        workEndTime: hasUserOverride
          ? u.workEndTime
          : role?.workEndTime || null,
        source: hasUserOverride ? "user" : "role",
      };
    }
    return obj;
  });

  const totalPages = Math.ceil(total / limitNum);

  return {
    users: usersWithSchedule,
    pagination: {
      total,
      page: pageNum,
      limit: limitNum,
      totalPages,
      hasNextPage: pageNum < totalPages,
      hasPrevPage: pageNum > 1,
    },
  };
}

/**
 * Yangi foydalanuvchi yaratish.
 *
 * O'QUVCHI uchun shu yerda O'QISH DAVRI ham ochiladi — bugungi sanadan,
 * ochiq (tugash sanasiz). Bu ixtiyoriy qadam EMAS: "davri yo'q = o'qimaydi"
 * qoidasi tufayli davrsiz o'quvchiga hisob-faktura umuman yozilmaydi.
 * Shuning uchun ikkalasi BITTA TRANZAKSIYADA yoziladi — yarim yaratilgan
 * o'quvchi (bor, lekin to'lov yozilmaydi) paydo bo'lishi mumkin emas.
 *
 * ⚠️ `createdBy` — AUDIT emas, RUXSAT maydoni: o'qituvchi keyinchalik
 * faqat o'zi qo'shgan o'quvchini tahrirlay va o'chira oladi
 * (`assertCanManageUser`). Shuning uchun u `actorId` bo'lmaganda ham
 * (skript, seed) `null` bo'lib qoladi — "hech kim qo'shmagan" degani.
 *
 * @param {object} data
 * @param {string} [actorId] - kim yaratdi (o'qish davri auditi va egalik uchun)
 * @param {{ role?: string }} [actor] - yaratuvchining o'zi (rol cheklovi uchun)
 */
async function createUser(data, actorId, actor = null) {
  const {
    username,
    password,
    firstName,
    lastName,
    role,
    gender,
    classes: userClasses,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  if (!username || !password || !firstName || !lastName || !role) {
    throw new BadRequestError("Barcha majburiy maydonlarni to'ldiring");
  }

  if (role === "owner") {
    throw new BadRequestError("Owner rolini yaratish mumkin emas");
  }

  // ⚠️ O'QITUVCHI FAQAT O'QUVCHI QO'SHADI. `users.create` ruxsati unga
  // berilishi mumkin (qabulxona yo'q kichik filialda o'qituvchining o'zi
  // yozadi), lekin xodim yaratish huquqi bu bilan birga ketmasligi kerak:
  // aks holda o'qituvchi o'ziga ikkinchi, to'liq ruxsatli hisob ochib
  // olardi.
  if (hasRole(actor, ROLES.TEACHER) && role !== ROLES.STUDENT) {
    throw new ForbiddenError("O'qituvchi faqat o'quvchi qo'sha oladi");
  }

  const roleExists = await platformPrisma.role.findUnique({
    where: { value: role },
  });
  if (!roleExists) {
    throw new BadRequestError("Noto'g'ri rol");
  }

  if (role === "student" && userClasses && userClasses.length > 0) {
    for (const classId of userClasses) {
      const classExists = await prisma.class.findUnique({
        where: { id: classId },
      });
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }
  }

  const hashed = await hashPassword(password);
  const branch = getBranch();
  const normalizedUsername = username.toLowerCase().trim();

  // ⚠️ IKKI SCHEMA — BITTA TRANZAKSIYA YO'Q.
  // Username butun tizim bo'ylab yagona bo'lishi kerak (login qaysi filialga
  // borishni platformadagi yo'naltirgichdan biladi), lekin `platform.user_directory`
  // va `br_x.users` alohida ulanishlarda. Shuning uchun tartib qat'iy:
  // AVVAL platformada band qilinadi, KEYIN filialda yoziladi, xato bo'lsa
  // band qilish orqaga olinadi. Teskari tartibda ikki filialda bir xil
  // username paydo bo'lishi mumkin edi.
  const id = generateId();

  await userDirectory.claim({
    id,
    username: normalizedUsername,
    branchId: branch.id,
    role,
    firstName,
    lastName,
  });

  let created;
  try {
    created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          id,
          username: normalizedUsername,
          password: hashed,
          plainPassword: password,
          firstName,
          lastName,
          role,
          gender: gender || null,
          createdBy: actorId ?? null,
          ...(role === "student" && userClasses && userClasses.length > 0
            ? {
                classes: {
                  create: userClasses.map((classId) => ({ classId })),
                },
              }
            : {}),
          ...(role !== "student" && {
            workStartTime: workStartTime || null,
            workEndTime: workEndTime || null,
            workDays: workDays || [],
            weeklySchedule: weeklySchedule || {},
            // Rolning boshlang'ich ruxsatlari (Rollar sahifasida sozlanadi).
            // Keyinchalik rol o'zgarsa, mavjud foydalanuvchiga ta'sir qilmaydi.
            permissions: roleExists.permissions || [],
          }),
        },
      });

      // Davr yo'q = o'qimaydi. Yangi o'quvchi darhol o'qiy boshlaydi,
      // shuning uchun davr bugundan ochiladi va yopilmaydi.
      if (role === "student") {
        await tx.studentEnrollment.create({
          data: {
            studentId: user.id,
            startDate: currentDayDate(),
            createdBy: actorId ?? user.id,
            reason: "O'quvchi yaratilganda avtomatik ochildi",
          },
        });
      }

      return user;
    });
  } catch (error) {
    await userDirectory.release(id);
    throw error;
  }

  return loadUser(created.id);
}

/**
 * Foydalanuvchini yangilash.
 */
async function updateUser(id, data) {
  const {
    firstName,
    lastName,
    gender,
    classes: userClasses,
    subjects: userSubjects,
    isActive,
    workStartTime,
    workEndTime,
    workDays,
    weeklySchedule,
  } = data;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      classes: { select: { classId: true } },
      subjects: { select: { subjectId: true } },
    },
  });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError(
      "Egasi foydalanuvchisini o'zgartirish mumkin emas",
    );
  }

  const update = {};
  if (firstName) update.firstName = firstName;
  if (lastName) update.lastName = lastName;
  if (isActive !== undefined) update.isActive = isActive;
  if (gender !== undefined) update.gender = gender || null;

  // Ish jadvali override (davomat uchun)
  if (user.role !== "student") {
    if (workStartTime !== undefined)
      update.workStartTime = workStartTime || null;
    if (workEndTime !== undefined) update.workEndTime = workEndTime || null;
    if (workDays !== undefined) update.workDays = workDays || [];
    if (weeklySchedule !== undefined)
      update.weeklySchedule = weeklySchedule || {};
  }

  let classesChanged = false;
  let nextClassIds = null;
  if (user.role === "student" && userClasses) {
    if (user.isArchived && userClasses.length > 0) {
      throw new BadRequestError(
        "Arxivlangan o'quvchiga sinf biriktirish mumkin emas",
      );
    }
    for (const classId of userClasses) {
      const classExists = await prisma.class.findUnique({
        where: { id: classId },
      });
      if (!classExists) {
        throw new BadRequestError(`Sinf topilmadi: ${classId}`);
      }
    }

    const prevClasses = user.classes.map((c) => c.classId).sort();
    nextClassIds = [...userClasses].sort();
    classesChanged =
      prevClasses.length !== nextClassIds.length ||
      prevClasses.some((c, i) => c !== nextClassIds[i]);
  }

  // O'QITUVCHI FANLARI — sinflarning ko'zgusi, lekin TESKARI rol uchun:
  // sinf o'quvchiga, fan esa xodimga biriktiriladi. Fan dars jadvalini
  // rejalashtirishning kirimi (planner_loads satri shundan tug'iladi).
  //
  // ⚠️ Bu maydon propagateIdentity() dan O'TMAYDI: u identifikatsiya emas.
  // Bir odam Chilonzorda matematikadan, Yunusobodda fizikadan dars berishi
  // mumkin, ya'ni fan har filialda alohida hal qilinadi.
  let subjectsChanged = false;
  if (user.role !== "student" && userSubjects) {
    for (const subjectId of userSubjects) {
      const subjectExists = await prisma.subject.findUnique({
        where: { id: subjectId },
        select: { id: true },
      });
      if (!subjectExists) {
        throw new BadRequestError(`Fan topilmadi: ${subjectId}`);
      }
    }

    const prevSubjects = user.subjects.map((us) => us.subjectId).sort();
    const nextSubjectIds = [...userSubjects].sort();
    subjectsChanged =
      prevSubjects.length !== nextSubjectIds.length ||
      prevSubjects.some((v, i) => v !== nextSubjectIds[i]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id }, data: update });
    if (classesChanged) {
      await tx.userClass.deleteMany({ where: { userId: id } });
      await tx.userClass.createMany({
        data: userClasses.map((classId) => ({ userId: id, classId })),
        skipDuplicates: true,
      });
    }
    if (subjectsChanged) {
      await tx.userSubject.deleteMany({ where: { userId: id } });
      await tx.userSubject.createMany({
        data: userSubjects.map((subjectId) => ({ userId: id, subjectId })),
        skipDuplicates: true,
      });
    }
  });

  // Ism, jins va login bayrog'i — odamga tegishli, ya'ni barcha
  // filiallardagi qatorlariga yoziladi. Ish jadvali va sinflar esa ATAYLAB
  // faqat joriy filialda qoladi: ular filialga xos.
  await propagateIdentity(id, update);

  // Yo'naltirgichdagi denormalizatsiyani yangilaymiz (ism/holat qidiruvda
  // va yig'ma hisobotda platformadan o'qiladi).
  await syncDirectory(id);

  return loadUser(id);
}

/**
 * Foydalanuvchi parolini tiklash.
 */
async function resetPassword(id, newPassword) {
  if (!newPassword) {
    throw new BadRequestError("Yangi parol majburiy");
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError(
      "Egasi foydalanuvchisi parolini tiklash mumkin emas",
    );
  }

  const hashed = await hashPassword(newPassword);

  // BARCHA filiallarga: parol odamga tegishli, filialga emas. Faqat joriy
  // filialga yozilsa, xodim boshqa filialda eski parol bilan qolib ketardi.
  await propagateIdentity(id, { password: hashed, plainPassword: newPassword });
}

/**
 * Foydalanuvchi parolini olish (plainPassword).
 */
async function getUserPassword(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { plainPassword: true },
  });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  return user.plainPassword || "Hisob eski, parolni ko'rsatib bo'lmaydi";
}

/**
 * Foydalanuvchini o'chirish.
 */
async function deleteUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini o'chirish mumkin emas");
  }

  if (user.role === "student") {
    throw new BadRequestError(
      "O'quvchini o'chirib bo'lmaydi. Uning o'rniga arxivlang",
    );
  }

  await prisma.user.delete({ where: { id } });

  // Yo'naltirgichdan ham olib tashlaymiz — aks holda username abadiy band
  // bo'lib qolardi va o'sha odamni qayta kiritib bo'lmasdi.
  await userDirectory.remove(id);
}

/**
 * Foydalanuvchini arxivlash (yumshoq o'chirish).
 *
 * O'quvchi ham, xodim ham arxivlanadi: qatori o'chmaydi, shuning uchun uning
 * davomati, baholari va moliyaviy tarixi hisobotlarda qolaveradi. Arxivlangan
 * foydalanuvchi tizimga kira olmaydi (`auth.service` va `auth.middleware`
 * `isArchived` ni tekshiradi).
 */
async function archiveUser(id, options = {}) {
  const { resetCoins = false, resetPenalties = false } = options;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (user.role === "owner") {
    throw new ForbiddenError("Egasi foydalanuvchisini arxivlash mumkin emas");
  }

  if (user.isArchived) {
    throw new BadRequestError("Foydalanuvchi allaqachon arxivlangan");
  }

  const update = {
    // 0lashtirishdan oldingi asl qiymatlarni saqlab qo'yamiz
    archiveSnapshot: {
      coinBalance: user.coinBalance,
      penaltyPoints: user.penaltyPoints,
    },
    isArchived: true,
    archivedAt: new Date(),
  };
  if (resetCoins) update.coinBalance = 0;
  if (resetPenalties) update.penaltyPoints = 0;

  // Arxivlangan o'quvchi barcha sinflardan avtomatik chiqariladi
  // (xodimda sinf biriktirmasi yo'q — u yerda bu amal bo'sh o'tadi)
  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: update }),
    prisma.userClass.deleteMany({ where: { userId: id } }),
  ]);

  // `isArchived` — LOGIN bayrog'i, ya'ni odamga tegishli: arxivlangan xodim
  // HECH BIR filialga kira olmasligi kerak. Bitta filialdan chiqarish uchun
  // arxivlash emas, biriktirishni bekor qilish ishlatiladi
  // (`detachFromBranch`).
  await propagateIdentity(id, { isArchived: true });

  // Arxivlangan foydalanuvchi login qila olmaydi — yo'naltirgich ham shuni
  // bilishi kerak (yig'ma sanoqlar arxivlanganlarni chiqarib tashlaydi).
  await syncDirectory(id);

  return loadUser(id);
}

/**
 * Arxivlangan foydalanuvchini qaytarish.
 * Sinf biriktirmalari qaytarilmaydi — ular qo'lda belgilanadi.
 */
async function restoreUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  if (!user.isArchived) {
    throw new BadRequestError("Foydalanuvchi arxivlanmagan");
  }

  await prisma.user.update({
    where: { id },
    data: { isArchived: false, archivedAt: null },
  });

  await propagateIdentity(id, { isArchived: false });

  await syncDirectory(id);

  return loadUser(id);
}

/**
 * Excel eksport uchun foydalanuvchilar ma'lumotlarini tayyorlash.
 */
async function getUsersForExport(role) {
  const where = {};
  // `getAllUsers` bilan bir xil qoida — "staff" guruhi ham eksport qilinadi.
  // "all" — filtr yo'qligini bildiradi (UI shu qiymatni yuboradi).
  if (role === "staff") {
    where.role = { notIn: ["student", "owner"] };
  } else if (role && role !== "all") {
    where.role = role;
  } else {
    where.role = { not: "owner" };
  }

  const users = await prisma.user.findMany({
    where,
    include: { classes: { include: { class: { select: { name: true } } } } },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });

  const allRoles = await platformPrisma.role.findMany();
  const roleMap = {};
  allRoles.forEach((r) => {
    roleMap[r.value] = r.name;
  });

  return users.map((user) => ({
    fullName: `${user.firstName} ${user.lastName || ""}`.trim(),
    username: user.username,
    password: user.plainPassword || "N/A",
    role: roleMap[user.role] || user.role,
    classes:
      user.classes && user.classes.length > 0
        ? user.classes.map((c) => c.class.name).join(", ")
        : "-",
    // Ro'yxat jadvalidagi "Tangalar" va "Jarimalar" ustunlari bilan bir xil
    // manba: eksport shu ikki raqamsiz ro'yxatning to'liq nusxasi bo'lmaydi.
    coinBalance: user.coinBalance ?? 0,
    penaltyPoints: user.penaltyPoints ?? 0,
  }));
}

/**
 * Barcha faol foydalanuvchilarning qisqa ro'yxatini olish (owner bundan mustasno).
 */
async function getAllUsersShort() {
  return prisma.user.findMany({
    where: { isActive: true, isArchived: false, role: { not: "owner" } },
    select: { id: true, firstName: true, lastName: true, role: true },
    orderBy: [{ role: "asc" }, { firstName: "asc" }],
  });
}

/**
 * Talabalar ro'yxatini olish (qidiruv bilan).
 */
async function getStudents(query) {
  const { search, limit = 500 } = query;

  const where = { role: "student", isArchived: false };

  if (search && search.trim()) {
    const s = search.trim();
    where.OR = [
      { firstName: { contains: s, mode: "insensitive" } },
      { lastName: { contains: s, mode: "insensitive" } },
      { username: { contains: s, mode: "insensitive" } },
    ];
  }

  const users = await prisma.user.findMany({
    where,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      penaltyPoints: true,
      classes: { include: { class: { select: { id: true, name: true } } } },
    },
    orderBy: { firstName: "asc" },
    take: parseInt(limit, 10),
  });

  return users.map(flattenRelations);
}

/**
 * Foydalanuvchining o'z profilini yangilash.
 */
async function updateSelfProfile(userId, data) {
  const { firstName, lastName, username, currentPassword, newPassword } = data;

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    throw new NotFoundError("Foydalanuvchi topilmadi");
  }

  const update = {};
  if (firstName !== undefined) update.firstName = firstName;
  if (lastName !== undefined) update.lastName = lastName;

  // Username o'zgartirish — unikallik BUTUN TIZIM bo'yicha tekshiriladi.
  // Filial ichida tekshirish yetarli emas: login qaysi filialga borishni
  // platformadagi yo'naltirgichdan biladi, ya'ni ikki filialda bir xil
  // username bo'lsa ulardan biri kira olmay qolardi.
  if (username !== undefined) {
    const normalizedUsername = String(username).toLowerCase().trim();
    if (normalizedUsername !== user.username) {
      await userDirectory.assertUsernameFree(normalizedUsername, userId);
      update.username = normalizedUsername;
    }
  }

  // Parol o'zgartirish - joriy parolni tasdiqlash talab qilinadi
  if (newPassword) {
    if (!currentPassword) {
      throw new BadRequestError("Joriy parolni kiriting");
    }

    const isMatch = await matchPassword(currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestError("Joriy parol noto'g'ri");
    }

    update.password = await hashPassword(newPassword);
    update.plainPassword = newPassword;
  }

  // Ism, username va parol — odamning o'zi haqidagi ma'lumot: barcha
  // filiallardagi qatorlariga yoziladi.
  await propagateIdentity(userId, update);

  await syncDirectory(userId);

  return loadUser(userId);
}

// ─────────────────────────────────────────────
// XODIMNI FILIALGA BIRIKTIRISH
// ─────────────────────────────────────────────

/**
 * Xodimning barcha filiallari — har birida O'Z roli va O'Z ruxsatlari bilan.
 *
 * Ruxsatlar filial bazasidan o'qiladi (`User.permissions`), chunki aynan
 * shu narsa har filialda boshqacha bo'lishi kerak: Chilonzorda kassir,
 * Yunusobodda o'qituvchi.
 *
 * @param {string} userId
 * @returns {Promise<object[]>}
 */
async function getUserBranches(userId) {
  const access = await userDirectory.listAccess(userId);

  const rows = await Promise.all(
    access.map(async (row) => {
      const branch = await branchService.findById(row.branchId);
      if (!branch) return null;

      // Profil o'sha filialda yo'q bo'lishi mumkin (biriktirish qolib
      // ketgan) — bu holat `profileMissing` bilan OCHIQ ko'rsatiladi,
      // jimgina "ruxsati yo'q" sifatida emas.
      const profile = await runWithBranch(branch, () =>
        prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            role: true,
            permissions: true,
            isActive: true,
            workStartTime: true,
            workEndTime: true,
            workDays: true,
          },
        }),
      );

      return {
        branch: {
          id: branch.id,
          code: branch.code,
          name: branch.name,
          shortName: branch.shortName || branch.name,
          isArchived: branch.isArchived,
        },
        isHome: row.isHome,
        role: profile?.role ?? row.role,
        permissions: profile?.permissions ?? [],
        isActive: profile?.isActive ?? true,
        effectiveSchedule: profile
          ? {
              workStartTime: profile.workStartTime,
              workEndTime: profile.workEndTime,
              workDays: profile.workDays,
            }
          : null,
        profileMissing: !profile,
      };
    }),
  );

  return rows.filter(Boolean);
}

/**
 * Xodimni BOSHQA filialga biriktiradi.
 *
 * Ikki qadam, ikki schema (tranzaksiya bo'lishi mumkin emas):
 *   1) maqsad filialda `User` qatori yaratiladi — AYNAN O'SHA `id` bilan
 *      (owner naqshi: `utils/initOwner.js`),
 *   2) platformada biriktirish yozuvi qo'yiladi.
 *
 * Tartib shunday: qator AVVAL yaratiladi, biriktirish esa oxirida — aks
 * holda "kira olaman deb yozilgan, lekin profili yo'q" holati paydo bo'lardi.
 *
 * RUXSATLAR yangi filialda ROLNING standart ruxsatlaridan boshlanadi
 * (Rollar sahifasida sozlanadi) — yangi xodim yaratilgandagi bilan bir xil
 * mantiq. Boshqa filialdagi ruxsatlar KO'CHIRILMAYDI: kassa huquqi
 * tasodifan ikkinchi filialga o'tib ketmasligi kerak.
 *
 * @param {string} userId
 * @param {{branchId: string, role?: string, actorId?: string}} params
 */
async function attachToBranch(userId, { branchId, role, actorId = null }) {
  const entry = await userDirectory.findByUserId(userId);
  if (!entry) throw new NotFoundError("Foydalanuvchi topilmadi");

  if (entry.role === "student") {
    throw new BadRequestError(
      "O'quvchini bir nechta filialga biriktirib bo'lmaydi — o'quvchi bitta filialda o'qiydi",
    );
  }

  const target = await branchService.getUsableById(branchId);

  if (await userDirectory.findAccess(userId, branchId)) {
    throw new BadRequestError(
      `Xodim "${target.name}" filialiga allaqachon biriktirilgan`,
    );
  }

  // Manba profil — UY filialidan (login, parol, ism shu yerdan olinadi).
  const home = await branchService.findById(entry.branchId);
  if (!home) throw new NotFoundError("Xodimning asosiy filiali topilmadi");

  const source = await runWithBranch(home, () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        password: true,
        plainPassword: true,
        firstName: true,
        lastName: true,
        gender: true,
        isActive: true,
        isArchived: true,
      },
    }),
  );

  if (!source) throw new NotFoundError("Xodim profili topilmadi");
  if (source.isArchived) {
    throw new BadRequestError(
      "Arxivlangan xodimni filialga biriktirib bo'lmaydi",
    );
  }

  const nextRole = role || entry.role;

  const roleRow = await platformPrisma.role.findUnique({
    where: { value: nextRole },
  });
  if (!roleRow) throw new BadRequestError("Noto'g'ri rol");

  // ── 1. Maqsad filialda profil ──
  await runWithBranch(target, () =>
    prisma.user.upsert({
      where: { id: userId },
      create: {
        id: source.id,
        username: source.username,
        password: source.password,
        plainPassword: source.plainPassword,
        firstName: source.firstName,
        lastName: source.lastName,
        gender: source.gender,
        role: nextRole,
        isActive: source.isActive,
        permissions: roleRow.permissions || [],
        workStartTime: roleRow.workStartTime,
        workEndTime: roleRow.workEndTime,
        workDays: roleRow.workDays || [],
        weeklySchedule: roleRow.weeklySchedule || {},
      },
      // Qator allaqachon bor bo'lsa (ilgari chiqarilgan xodim qaytdi) —
      // RUXSATLARGA TEGMAYMIZ, faqat identifikatsiyani tiklaymiz.
      update: {
        username: source.username,
        password: source.password,
        plainPassword: source.plainPassword,
        firstName: source.firstName,
        lastName: source.lastName,
        isActive: source.isActive,
        isArchived: false,
      },
      select: { id: true },
    }),
  );

  // ── 2. Biriktirish yozuvi ──
  await userDirectory.grantAccess({
    userId,
    branchId,
    role: nextRole,
    actorId,
  });

  logger.info(
    `[user] ${source.username} → "${target.name}" filialiga biriktirildi (${nextRole})`,
  );

  return getUserBranches(userId);
}

/**
 * Xodimni filialdan chiqaradi.
 *
 * Profil qatori O'CHIRILMAYDI, faqat `isActive: false` qilinadi: o'sha
 * filialdagi davomat, jarima va topshiriqlar unga ishora qiladi va
 * hisobotlardan yo'qolmasligi kerak (`User` soft-ref naqshi).
 *
 * UY filialidan chiqarib bo'lmaydi — login aynan o'sha yerga tushadi
 * (`userDirectory.revokeAccess` tekshiradi).
 *
 * @param {string} userId
 * @param {string} branchId
 */
async function detachFromBranch(userId, branchId) {
  const access = await userDirectory.revokeAccess(userId, branchId);
  if (!access) {
    throw new NotFoundError("Bu filialga biriktirish topilmadi");
  }

  const branch = await branchService.findById(branchId);
  if (branch) {
    await runWithBranch(branch, () =>
      prisma.user
        .update({
          where: { id: userId },
          // Ruxsatlar ham tozalanadi: biriktirish qaytarilsa ular rolning
          // standartidan qayta boshlanishi kerak, eskisi tirilib qolmasin.
          // ⚠️ `extraRoles` HAM tozalanadi. Darvozalar rolni ruxsatdan
          // MUSTAQIL o'tkazadi (`hasRole` `permissions` ga umuman
          // qaramaydi), shuning uchun faqat `permissions` ni bo'shatish
          // yetarli emas edi: filialdan chiqarilgan odam qayta
          // biriktirilganda eski qo'shimcha roli tirilib, u bilan
          // birga o'sha rolga bog'langan hamma joy qayta ochilardi.
          data: { isActive: false, permissions: [], extraRoles: [] },
        })
        .catch(() => {}),
    );
  }

  logger.info(
    `[user] ${userId} → "${branch?.name ?? branchId}" filialidan chiqarildi`,
  );

  return getUserBranches(userId);
}

module.exports = {
  setExtraRoles,
  assertCanManageUser,
  getStats,
  // Bitta foydalanuvchi — classes VA subjects bilan (`loadUser` nomining
  // tashqi ko'rinishi). Controller o'z so'rovini yozmasligi kerak: aynan
  // shunday nusxa `subjects` ni unutgani uchun detal sahifasida fanlar
  // umuman ko'rinmay yurgan edi.
  getUserById: loadUser,
  getAllUsers,
  createUser,
  updateUser,
  resetPassword,
  getUserPassword,
  deleteUser,
  archiveUser,
  restoreUser,
  getUsersForExport,
  getAllUsersShort,
  getStudents,
  updateSelfProfile,
  // Bir martalik migratsiya skripti (branch-bootstrap) yo'naltirgichni shu
  // bilan to'ldiradi.
  syncDirectory,
  // Ko'p filialli xodim
  getUserBranches,
  attachToBranch,
  detachFromBranch,
  propagateIdentity,
};
