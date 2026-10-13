/**
 * GLOBAL QIDIRUV — admin paneldagi sidebar qidiruvi uchun yagona endpoint.
 *
 * ═════════════════════════════════════════════
 * NIMA UCHUN PLATFORMADAN O'QIYDI
 *
 * Qidiruv BUTUN PLATFORMA bo'yicha: "bu odam qaysi filialda?" degan savolga
 * joriy filial bo'yicha javob berish xato bo'lardi — owner Chilonzorda
 * turib Yunusobodda o'qiydigan o'quvchini qidirsa, hech narsa topilmasdi.
 *
 * Shuning uchun manba — `platform.user_directory`: unda ism, familiya,
 * username va filial DENORMALIZATSIYA qilingan (izoh o'sha modelda), ya'ni
 * bitta so'rov barcha filiallarni qamraydi va filial schema'lari bo'ylab
 * aylanib yurish kerak emas.
 *
 * ⚠️ Shu sababli natijada FAQAT katalogdagi maydonlar bo'ladi (ism,
 * username, rol, filial). Sinf, telefon yoki moliya ma'lumoti kerak bo'lsa
 * — foydalanuvchi kartasi o'z filialidan o'qiydi.
 * ═════════════════════════════════════════════
 *
 * ⚠️ RUXSAT HAR FILIALDA ALOHIDA (`CLAUDE.md`): `users.view` joriy filialda
 * bor degani boshqa filialdagi odamni ko'rish huquqi ham bor degani EMAS.
 * Shuning uchun:
 *
 *   - OWNER barcha filiallarni qidiradi (u har filialda mavjud);
 *   - qolgan xodim FAQAT o'zi kira oladigan filiallarni qidiradi
 *     (`platform.user_branch_access` — ro'yxatning o'zi grant).
 *
 * Sahifalar qidiruvi serverda EMAS: ular frontend marshrutlari va ruxsat
 * bo'yicha filtrlanishi kerak, server esa qaysi sahifa qaysi yo'lda
 * turganini bilmaydi (`AppSidebar` ning `navItems` i — yagona manba).
 */

const platformPrisma = require("../config/platformPrisma");
const branchService = require("./branch.service");
const { getBranch } = require("../config/branchContext");
const { ROLES } = require("../utils/constants");
const { hasRole } = require("../utils/permissions");

/** Qidiruv natijasi — bir martada ko'rsatiladigan maksimal qator. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Ikki harfdan qisqa so'rov butun katalogni qaytarardi — qidiruv emas. */
const MIN_QUERY = 2;

const parseLimit = (value) => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
};

/**
 * Aktyor qidira oladigan filiallar ro'yxati.
 *
 * Owner uchun `null` qaytadi — "cheklov yo'q" degani (filtrsiz so'rov).
 * Bu `[]` dan farq qiladi: bo'sh massiv "hech qaysi filial" degani bo'lib,
 * natijani butunlay bo'shatib qo'yardi.
 *
 * @param {object} actor - `req.user`
 * @returns {Promise<string[]|null>}
 */
const allowedBranchIds = async (actor) => {
  if (hasRole(actor, ROLES.OWNER)) return null;

  const rows = await platformPrisma.userBranchAccess.findMany({
    where: { userId: actor.id },
    select: { branchId: true },
  });
  return rows.map((r) => r.branchId);
};

/**
 * Foydalanuvchilarni butun platforma bo'ylab qidiradi.
 *
 * @param {object} actor - `req.user`
 * @param {object} query - `{ q, limit, role }`
 * @returns {Promise<{users: Array, total: number}>}
 */
const searchUsers = async (actor, query = {}) => {
  const q = String(query.q ?? "").trim();
  if (q.length < MIN_QUERY) return { users: [], total: 0 };

  const limit = parseLimit(query.limit);
  const branchIds = await allowedBranchIds(actor);
  // Ruxsat berilgan filial yo'q — qidiradigan narsa ham yo'q
  if (branchIds && branchIds.length === 0) return { users: [], total: 0 };

  const where = {
    // Arxivlangan odam qidiruvda chiqmaydi: u tizimga kira olmaydi va
    // ro'yxatlarda ham ko'rinmaydi (`education.md` §4 — bu LOGIN bayrog'i).
    isArchived: false,
    ...(branchIds ? { branchId: { in: branchIds } } : {}),
    ...(query.role ? { role: String(query.role) } : {}),
    OR: [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { username: { contains: q, mode: "insensitive" } },
    ],
  };

  const [total, rows] = await Promise.all([
    platformPrisma.userDirectory.count({ where }),
    platformPrisma.userDirectory.findMany({
      where,
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        role: true,
        isActive: true,
        branchId: true,
      },
      // Familiya bo'yicha — ro'yxatlardagi tartib bilan bir xil
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: limit,
    }),
  ]);

  // Filial nomi — reyestrdan (keshlangan), har qator uchun alohida
  // so'rov yubormaslik uchun. `listOperational` — vaqtincha yopilgan
  // filial ham kiradi: odam o'sha yerda bor va nomi ko'rinishi kerak.
  //
  // Rol YORLIG'I ham shu yerda qo'shiladi: rollar dinamik katalog
  // (`platform.roles`), uning endpoint'i esa faqat OWNER uchun ochiq —
  // frontend o'zi tarjima qilsa, oddiy xodimda rol kaliti xom ko'rinardi.
  const [branches, roles] = await Promise.all([
    branchService.listOperational(),
    platformPrisma.role.findMany({ select: { value: true, name: true } }),
  ]);
  const branchName = new Map(branches.map((b) => [b.id, b.name]));
  const roleName = new Map(roles.map((r) => [r.value, r.name]));

  // ⚠️ Odam JORIY filialdami? Foydalanuvchi kartasi joriy filial
  // bazasidan o'qiydi, ya'ni boshqa filialdagi odamning sahifasi bo'sh
  // chiqardi. Panel shu belgiga qarab qatorni bosilmaydigan qiladi.
  const currentBranchId = getBranch()?.id ?? null;

  const users = rows.map((row) => ({
    id: row.id,
    username: row.username,
    firstName: row.firstName,
    lastName: row.lastName,
    fullName: `${row.lastName || ""} ${row.firstName || ""}`.trim() || row.username,
    role: row.role,
    // Katalogda topilmasa kalitning o'zi — rol o'chirilgan bo'lsa ham
    // qator "rolsiz" bo'lib ko'rinmaydi
    roleLabel: roleName.get(row.role) ?? row.role,
    isActive: row.isActive,
    branchId: row.branchId,
    branchName: branchName.get(row.branchId) ?? "",
    isCurrentBranch: row.branchId === currentBranchId,
  }));

  return { users, total };
};

module.exports = { searchUsers, MIN_QUERY };
