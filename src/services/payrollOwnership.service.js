/**
 * ASOSIY OYLIK EGASI — bir xodim, bir oy, BITTA filial.
 *
 * Xodim bir nechta filialda ishlashi mumkin (`platform.user_branch_access`).
 * Oylik ikki qismdan iborat va ular boshqacha bo'linadi:
 *
 *   ASOSIY OYLIK — lavozim maoshi (shaxsiy maosh), qo'shimcha fiksa,
 *     ustamalar, bonuslar va ularga bog'liq kelmagan kun ayirmasi. Bu
 *     SHARTNOMA: odamga oyiga BIR MARTA to'lanadi. Faqat EGA filialda
 *     hisoblanadi, boshqa filiallarda nol (`payrollEngine.computeForStaff`).
 *
 *   ISH — dars soati × stavka va tyutor guruhi. Bu o'sha filialda BAJARILGAN
 *     ish: boshqa filialdagi dars — boshqa dars, ya'ni ikki marta hisoblash
 *     emas. Har filial o'zida o'tilgan darsga to'laydi (filial kassasi va
 *     xarajati ham to'g'ri chiqadi).
 *
 * EGA QANDAY ANIQLANADI (shu tartibda):
 *   1) `payroll_month_owners` da qator bor — o'sha filial (muhr);
 *   2) xodimning bitta filiali bor — o'sha filial;
 *   3) bir nechta filial: asosiy oylik sharti (lavozim yoki qo'shimcha fiksa)
 *      faqat bitta UY BO'LMAGAN filialda bo'lsa — o'sha; aks holda UY filiali.
 *
 * 3-band eski ma'lumot uchun: ko'p filialli xodimning asosiy oyligi uy
 * bo'lmagan filialda belgilangan bo'lishi mumkin edi. Faqat uy filialiga
 * qarasak, uning oyligi jimgina nolga tushardi.
 *
 * MUHR NIMA UCHUN: ko'chirishda uy filiali o'zgaradi. Muhrsiz o'tgan oylarning
 * egasi ham u bilan birga o'zgarib, manba filialdagi to'lanmagan oylik keyingi
 * shakllantirishda bekor bo'lib ketardi. Muhrni oylik shakllantirish (ega
 * filialning o'zi) va ko'chirish yozadi.
 */

const platformPrisma = require("../config/platformPrisma");
const { config } = require("../config/env.config");
const { getBranch } = require("../config/branchContext");
const branchService = require("./branch.service");
const { qualified } = require("../helpers/crossSchema.helpers");
const logger = require("../utils/logger");

const SOURCES = Object.freeze({ GENERATION: "generation", TRANSFER: "transfer" });

const OWNERS_TABLE = () => qualified(config.platformSchema, "payroll_month_owners");

/**
 * Oylarni filialga MUHRLAYDI. Mavjud muhrga tegmaydi (`ON CONFLICT DO
 * NOTHING`): oy egasi bir marta aniqlanadi.
 *
 * `db` — platforma client'i yoki filiallararo tranzaksiya (ko'chirish o'z
 * tranzaksiyasida muhrlaydi — ko'chish va muhr birga o'tadi yoki birga yo'q).
 *
 * @param {object} db
 * @param {{rows: Array<{userId: string, month: number}>, branchId: string, source: string}} input
 * @returns {Promise<number>} yangi muhrlar soni
 */
const pinMonths = async (db, { rows, branchId, source }) => {
  const unique = new Map();
  for (const row of rows) {
    if (row?.userId && Number.isInteger(row.month)) unique.set(`${row.userId}|${row.month}`, row);
  }
  if (unique.size === 0) return 0;

  const list = [...unique.values()];
  return db.$executeRawUnsafe(
    `INSERT INTO ${OWNERS_TABLE()} (user_id, month, branch_id, source, created_at)
     SELECT u, m, $3, $4, NOW() FROM unnest($1::text[], $2::int[]) AS t(u, m)
     ON CONFLICT (user_id, month) DO NOTHING`,
    list.map((r) => r.userId),
    list.map((r) => r.month),
    branchId,
    source,
  );
};

/**
 * Berilgan filiallarda kimning ASOSIY OYLIK sharti bor (oy uchun).
 *
 * Dvigateldagi "fiksa" bilan AYNI ta'rif: lavozim (`position_id`) yoki oyni
 * qamragan eski qoidadagi qo'shimcha fiksa (`staff_salaries.fixed_amount`).
 *
 * @param {Array<{id: string, schemaName: string}>} branches
 * @param {string[]} staffIds
 * @param {number} month
 * @returns {Promise<Map<string, Set<string>>>} branchId → xodimlar
 */
const loadFixedContracts = async (branches, staffIds, month) => {
  const result = new Map();
  await Promise.all(
    branches.map(async (branch) => {
      try {
        const rows = await platformPrisma.$queryRawUnsafe(
          `SELECT id AS staff_id FROM ${qualified(branch.schemaName, "users")}
             WHERE id = ANY($1::text[]) AND position_id IS NOT NULL AND is_archived = false
           UNION
           SELECT staff_id FROM ${qualified(branch.schemaName, "staff_salaries")}
             WHERE staff_id = ANY($1::text[]) AND fixed_amount > 0
               AND start_month <= $2 AND (end_month IS NULL OR end_month >= $2)`,
          staffIds,
          month,
        );
        result.set(branch.id, new Set(rows.map((r) => String(r.staff_id).trim())));
      } catch (error) {
        // Filial o'qilmasa (masalan, provisioning yarim qolgan) — shart yo'q
        // deb hisoblanadi: qaror uy filialiga tushadi, jimgina emas — logda
        logger.warn(
          `[payrollOwnership] "${branch.name}" filialida shartnomalar o'qilmadi: ${error.message}`,
        );
        result.set(branch.id, new Set());
      }
    }),
  );
  return result;
};

/**
 * Xodimlar uchun oyning ASOSIY OYLIK egasi.
 *
 * @param {number} month - YYYYMM
 * @param {string[]} staffIds
 * @returns {Promise<Map<string, {branchId: string, pinned: boolean}>>} —
 *   platformada yozuvi YO'Q xodim (filiallashtirishdan oldingi) ro'yxatda
 *   bo'lmaydi: u joriy filialniki deb qaraladi
 */
const resolveOwners = async (month, staffIds) => {
  const ids = [...new Set((staffIds || []).filter(Boolean).map(String))];
  const owners = new Map();
  if (ids.length === 0) return owners;

  const [claims, directory, access] = await Promise.all([
    platformPrisma.payrollMonthOwner.findMany({
      where: { month, userId: { in: ids } },
      select: { userId: true, branchId: true },
    }),
    platformPrisma.userDirectory.findMany({
      where: { id: { in: ids } },
      select: { id: true, branchId: true },
    }),
    platformPrisma.userBranchAccess.findMany({
      where: { userId: { in: ids } },
      select: { userId: true, branchId: true },
      orderBy: [{ isHome: "desc" }, { createdAt: "asc" }],
    }),
  ]);

  for (const claim of claims) owners.set(claim.userId, { branchId: claim.branchId, pinned: true });

  const homeOf = new Map(directory.map((d) => [d.id, d.branchId]));
  const accessOf = new Map();
  for (const row of access) {
    if (!accessOf.has(row.userId)) accessOf.set(row.userId, []);
    accessOf.get(row.userId).push(row.branchId);
  }

  // Muhrsiz, bir nechta filialli xodimlar — shartnoma qayerdaligi kerak
  const shared = [];
  for (const id of ids) {
    if (owners.has(id) || !homeOf.has(id)) continue;
    const branches = accessOf.get(id) ?? [];
    if (branches.length <= 1) {
      owners.set(id, { branchId: branches[0] ?? homeOf.get(id), pinned: false });
    } else {
      shared.push(id);
    }
  }

  if (shared.length > 0) {
    const branchIds = [...new Set(shared.flatMap((id) => accessOf.get(id)))];
    const branches = (await Promise.all(branchIds.map((id) => branchService.findById(id)))).filter(
      Boolean,
    );
    const contracts = await loadFixedContracts(branches, shared, month);

    for (const id of shared) {
      const home = homeOf.get(id);
      const withContract = accessOf
        .get(id)
        .filter((branchId) => contracts.get(branchId)?.has(id));
      const owner =
        withContract.length === 0 || withContract.includes(home) ? home : withContract[0];
      owners.set(id, { branchId: owner, pinned: false });
    }
  }

  return owners;
};

/**
 * JORIY filialda asosiy oyligi HISOBLANMAYDIGAN xodimlar — egasi boshqa filial.
 *
 * @param {number} month
 * @param {string[]} staffIds
 * @returns {Promise<Map<string, {branchId: string, branchName: string}>>}
 */
const foreignFixedStaff = async (month, staffIds) => {
  const current = getBranch();
  const result = new Map();
  if (!current || !staffIds?.length) return result;

  const owners = await resolveOwners(month, staffIds);
  for (const [staffId, owner] of owners) {
    if (owner.branchId && owner.branchId !== current.id) {
      const branch = await branchService.findById(owner.branchId);
      result.set(staffId, {
        branchId: owner.branchId,
        branchName: branch?.name ?? "boshqa filial",
      });
    }
  }
  return result;
};

/**
 * Oylik shakllantirgan EGA filial o'z oylarini muhrlaydi (xato yutiladi:
 * muhr — himoya qavati, uning yozilmagani shakllantirishni yiqitmasligi
 * kerak; keyingi pass qayta urinadi).
 *
 * @param {string[]} staffIds - shu filial egasi bo'lgan xodimlar
 * @param {number} month
 */
const pinGeneratedMonth = async (staffIds, month) => {
  const current = getBranch();
  if (!current || !staffIds?.length) return;
  try {
    await pinMonths(platformPrisma, {
      rows: staffIds.map((userId) => ({ userId, month })),
      branchId: current.id,
      source: SOURCES.GENERATION,
    });
  } catch (error) {
    logger.warn(`[payrollOwnership] ${month} oyi muhrlanmadi: ${error.message}`);
  }
};

module.exports = {
  SOURCES,
  pinMonths,
  resolveOwners,
  foreignFixedStaff,
  pinGeneratedMonth,
};
