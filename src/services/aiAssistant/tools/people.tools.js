/**
 * AI YORDAMCHI — "Foydalanuvchilar" bo'limi o'qish vositalari.
 *
 * Qamrov: odam qidirish va profili (`core` — doim ochiq), ro'yxatlar,
 * sinflar, fanlar, rollar, ruxsatlar, xodimlar hisoboti, filiallar.
 *
 * ⚠️ MAXFIYLIK. Bu bo'limdagi servislarning bir qismi parolni qaytaradi
 * (`getClassById` — `plainPassword`, eksport yordamchilari — `password`).
 * Shu sababli har bir natija `pick` bilan OQ RO'YXAT bo'yicha quriladi:
 * servis qatorini "borligicha" modelga uzatish taqiqlangan. Telefon raqami
 * faqat `get_person` da (bitta odam, egasi so'raganda) chiqadi.
 *
 * ⚠️ ISM TARTIBI. Bazada "Ism Familiya", og'zaki nutqda esa ko'pincha
 * "Familiya Ism" ("Aliyev Vali") yoki bosh harf ("Aliyev V"). Mavjud
 * `getAllUsers({ search })` bitta so'zni qidiradi va "Aliyev Vali" ga hech
 * narsa topmaydi — shuning uchun qidiruv so'z tartibidan mustaqil
 * (`rankPeople`), kalit esa sheet moslashtirish bilan AYNI
 * (`scheduleSheet.helpers.normalizeKey`).
 */

const prisma = require("../../../config/prisma");
const userService = require("../../user.service");
const classService = require("../../class.service");
const subjectService = require("../../subject.service");
const roleService = require("../../role.service");
const permissionService = require("../../permission.service");
const branchService = require("../../branch.service");
const userDirectory = require("../../userDirectory.service");
const staffReportService = require("../../staffReport.service");
const staffSalaryService = require("../../staffSalary.service");
const studentEnrollmentService = require("../../studentEnrollment.service");
const tariffResolutionService = require("../../tariffResolution.service");
const studentDiscountService = require("../../studentDiscount.service");
const studentAccountService = require("../../studentAccount.service");
const invoiceService = require("../../invoice.service");
const { ROLES } = require("../../../utils/constants");
const {
  PERMISSION_SECTIONS,
  PERMISSION_KEYS,
  KEYS_BY_SECTION,
  expandLegacyKeys,
  hasPermission,
} = require("../../../utils/permissions");
const { normalizeKey, editDistance } = require("../../../helpers/scheduleSheet.helpers");
const { formatPhoneUz } = require("../../../helpers/phone.helpers");
const { formatDateUz, formatDateTimeUz } = require("../../../helpers/date.helpers");
const { formatMonthKey } = require("../../../helpers/month.helpers");
const {
  AiToolError,
  defineTool,
  idSchema,
  monthSchema,
  limitSchema,
  requireId,
  monthArg,
  formatMoneyUz,
  sliceList,
  pick,
  personName,
} = require("../assistant.toolkit");

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yorliqlar
// ─────────────────────────────────────────────────────────────────────────

const GENDER_LABELS = { male: "Erkak", female: "Ayol" };

const BRANCH_STATUS_LABELS = {
  provisioning: "Tayyorlanmoqda",
  ready: "Ishlayapti",
  failed: "Yaratishda xato",
};

/** Qidiruvda ko'rsatiladigan nomzodlar chegarasi. */
const SEARCH_MAX_CANDIDATES = 15;

/** Qidiruv so'rovidagi so'zlar chegarasi (ism, familiya, otasining ismi, login). */
const MAX_QUERY_WORDS = 4;

/**
 * Rol qiymati → nomi. Rollar PLATFORMADA; `owner` katalogda yo'q bo'lishi
 * mumkin, shuning uchun uning yorlig'i `staffReport` dagi bilan bir xil.
 * @returns {Promise<(role: string) => string>}
 */
async function loadRoleLabeler() {
  const options = await roleService.getRoleOptions();
  const map = new Map(options.map((r) => [r.value, r.name]));
  map.set(ROLES.OWNER, "Ega");
  return (role) => map.get(role) || role || "—";
}

/** Faoliyat holati — model "faol emas" va "arxivlangan" ni chalkashtirmasligi uchun. */
function statusLabel(user) {
  if (user.isArchived) return "Arxivlangan";
  if (user.isActive === false) return "Login o'chirilgan";
  return "Faol";
}

/** Ruxsat kaliti → { bo'lim, amal } yorliqlari (katalogdan). */
const PERMISSION_INDEX = new Map(
  PERMISSION_SECTIONS.flatMap((section) =>
    section.actions.map((action) => [
      `${section.key}.${action.key}`,
      {
        section: section.key,
        sectionLabel: section.label,
        group: section.group,
        actionLabel: action.label,
      },
    ]),
  ),
);

/**
 * Kalitlarni bo'limlar bo'yicha guruhlaydi (katalog tartibida).
 * @param {string[]} keys - normallashtirilgan kalitlar
 */
function groupPermissions(keys) {
  const set = new Set(keys);
  return PERMISSION_SECTIONS.map((section) => ({
    section: section.key,
    sectionLabel: section.label,
    group: section.group,
    actions: section.actions
      .filter((action) => set.has(`${section.key}.${action.key}`))
      .map((action) => ({ key: `${section.key}.${action.key}`, label: action.label })),
  })).filter((section) => section.actions.length > 0);
}

/** Kalit → "Bo'lim: amal" yorlig'i. */
function permissionLabel(key) {
  const entry = PERMISSION_INDEX.get(key);
  return entry ? `${entry.sectionLabel}: ${entry.actionLabel}` : key;
}

// ─────────────────────────────────────────────────────────────────────────
// Ism bo'yicha qidiruv (sof funksiyalar)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Moslik darajalari. Raqam katta — moslik kuchli.
 *
 * ⚠️ `fuzzy` va `partial` HECH QACHON "topildi" degani emas: ular faqat
 * egaga "shulardan birimi?" deb so'rash uchun. Amal taklif qilishdan oldin
 * model aniq odamni tanlashi shart (`design.md` §3.2 qoida 1).
 */
const MATCH = Object.freeze({ exact: 4, strong: 3, fuzzy: 2, partial: 1, none: 0 });

const MATCH_LABELS = {
  exact: "To'liq mos",
  strong: "Mos (ismning bir qismi, qisqartma yoki bosh harf)",
  fuzzy: "O'xshash (imlo farqi)",
  partial: "Qisman mos",
};

/**
 * Bitta so'zning bitta ism bo'lagiga mosligi.
 *   3 — teng; 2 — boshlanishi ("Ali" → "aliyev") yoki bosh harf ("V");
 *   1 — imlo farqi ("Aliev" → "aliyev", 4+ harfda ko'pi bilan 1-2 harf).
 */
function tokenLevel(query, target) {
  if (!query || !target) return 0;
  if (query === target) return 3;
  if (query.length === 1) return target.startsWith(query) ? 2 : 0;
  if (query.length >= 2 && target.startsWith(query)) return 2;
  if (query.length >= 4) {
    const limit = query.length >= 8 ? 2 : 1;
    if (Math.abs(query.length - target.length) <= limit && editDistance(query, target) <= limit) {
      return 1;
    }
  }
  return 0;
}

/**
 * So'rov so'zlarini ism bo'laklariga BIR-BIRIGA (har bo'lak bir marta)
 * taqsimlaydi va eng yaxshi taqsimotni qaytaradi. Bo'laklar soni kichik
 * (ism + familiya, odatda 2-4), shuning uchun to'liq qidiruv arzon.
 *
 * @param {string[]} queryTokens
 * @param {string[]} nameTokens
 * @returns {{ matched: number, minLevel: number, sum: number }}
 */
function bestAssignment(queryTokens, nameTokens) {
  let best = { matched: 0, minLevel: 0, sum: 0 };
  const used = new Array(nameTokens.length).fill(false);

  const walk = (i, levels) => {
    if (i === queryTokens.length) {
      const positive = levels.filter((l) => l > 0);
      const candidate = {
        matched: positive.length,
        minLevel: positive.length === queryTokens.length ? Math.min(...levels) : 0,
        sum: positive.reduce((a, b) => a + b, 0),
      };
      if (
        candidate.matched > best.matched ||
        (candidate.matched === best.matched && candidate.sum > best.sum)
      ) {
        best = candidate;
      }
      return;
    }
    for (let j = 0; j < nameTokens.length; j += 1) {
      if (used[j]) continue;
      const level = tokenLevel(queryTokens[i], nameTokens[j]);
      if (level === 0) continue;
      used[j] = true;
      walk(i + 1, [...levels, level]);
      used[j] = false;
    }
    // So'z hech bir bo'lakka tushmasligi ham mumkin ("Aliyev Vali aka") —
    // shu shox ham ko'riladi, aks holda qisman moslik yo'qolardi.
    walk(i + 1, [...levels, 0]);
  };

  walk(0, []);
  return best;
}

/**
 * Bitta odamning so'rovga mosligi.
 *
 * ⚠️ `exact` — so'zlar TO'PLAMI ism+familiya bo'laklari to'plamiga teng
 * (tartib ahamiyatsiz, tutuq belgisi/kirill ko'rinishli harflar
 * `normalizeKey` bilan tekislangan) yoki login aynan teng.
 *
 * @param {string[]} queryTokens - `normalizeKey` dan o'tgan so'zlar
 * @param {{firstName?: string, lastName?: string|null, username?: string}} person
 * @returns {{ match: keyof MATCH, score: number }} score — so'z darajalari yig'indisi (bir xil moslik ichida saralash uchun)
 */
function matchPerson(queryTokens, person) {
  if (queryTokens.length === 0) return { match: "none", score: 0 };
  const nameTokens = normalizeKey(`${person.firstName ?? ""} ${person.lastName ?? ""}`)
    .split(" ")
    .filter(Boolean);
  const usernameKey = normalizeKey(person.username ?? "");

  if (usernameKey && queryTokens.length === 1 && queryTokens[0] === usernameKey) {
    return { match: "exact", score: 3 };
  }

  const { matched, minLevel, sum } = bestAssignment(queryTokens, nameTokens);

  if (matched === queryTokens.length) {
    if (minLevel === 3 && queryTokens.length === nameTokens.length) return { match: "exact", score: sum };
    return { match: minLevel >= 2 ? "strong" : "fuzzy", score: sum };
  }

  // Qisman: hech bo'lmasa bitta 3+ harfli so'z ism bo'lagi yoki login bilan mos
  const meaningful = queryTokens.filter((t) => t.length >= 3);
  const partialName = matched > 0 && meaningful.some((t) => nameTokens.some((n) => tokenLevel(t, n) >= 2));
  const partialLogin = Boolean(usernameKey) && meaningful.some((t) => usernameKey.includes(t));
  return partialName || partialLogin ? { match: "partial", score: sum } : { match: "none", score: 0 };
}

/**
 * Nomzodlarni saralaydi: moslik → faol (arxivlanmagan, login yoqilgan) →
 * ism. Moslik yo'qlari tashlanadi.
 *
 * @param {string} query
 * @param {object[]} people
 * @returns {Array<{ person: object, match: string, score: number }>}
 */
function rankPeople(query, people) {
  const tokens = normalizeKey(query).split(" ").filter(Boolean);
  const ranked = people
    .map((person) => ({ person, ...matchPerson(tokens, person) }))
    .filter((row) => row.match !== "none");
  // Aniqroq moslik bo'lsa "qisman"lar shovqin: "Sultonova Dilnoza" so'rovida
  // hamma Sultonovalar ro'yxatni to'ldirib, to'g'ri javobni ko'mib yuborardi.
  const hasBetter = ranked.some((row) => MATCH[row.match] > MATCH.partial);
  const relevant = (hasBetter ? ranked.filter((row) => row.match !== "partial") : ranked)
    .sort((a, b) => {
      const byMatch = MATCH[b.match] - MATCH[a.match];
      if (byMatch) return byMatch;
      if (a.score !== b.score) return b.score - a.score;
      const activeA = !a.person.isArchived && a.person.isActive !== false ? 1 : 0;
      const activeB = !b.person.isArchived && b.person.isActive !== false ? 1 : 0;
      if (activeA !== activeB) return activeB - activeA;
      return personName(a.person).localeCompare(personName(b.person));
    });
  return relevant;
}

/**
 * Umumiy moslik xulosasi — model keyingi qadamni shundan tanlaydi.
 * @param {Array<{match: string}>} ranked
 */
function summarizeMatch(ranked) {
  if (ranked.length === 0) return "none";
  const exact = ranked.filter((r) => r.match === "exact").length;
  if (exact === 1) return "exact_unique";
  if (exact > 1) return "exact_multiple";
  const strong = ranked.filter((r) => r.match === "strong").length;
  if (strong === 1 && ranked.length === 1) return "strong_unique";
  if (strong > 0) return "strong_multiple";
  return ranked[0].match === "fuzzy" ? "similar_only" : "partial_only";
}

const MATCH_HINTS = {
  exact_unique: "Bitta odam to'liq mos keldi — shu id bilan davom etish mumkin.",
  exact_multiple: "Bir nechta odam bir xil ismga ega — egadan qaysi biri ekanini so'rang (sinf, rol yoki lavozim bo'yicha).",
  strong_unique: "Bitta odam qisqartma yoki bosh harf bo'yicha mos keldi — amal taklif qilishdan oldin egadan tasdiqlang.",
  strong_multiple: "Bir nechta nomzod — egadan aniqlashtiring.",
  similar_only: "Faqat imlosi o'xshash nomzodlar bor — egadan qaysi biri ekanini so'rang.",
  partial_only: "Faqat qisman mos nomzodlar — egadan to'liq ism-familiyani so'rang.",
  none: "Hech kim topilmadi — imloni tekshiring yoki arxivlanganlarni ham qidiring (includeArchived).",
};

// ─────────────────────────────────────────────────────────────────────────
// Qidiruv uchun o'quvchi/xodim ro'yxati
// ─────────────────────────────────────────────────────────────────────────

/** Qidiruv ro'yxatining xavfsizlik chegarasi (bitta filialdagi odamlar). */
const ROSTER_LIMIT = 10000;

const ROLE_FILTERS = {
  staff: { role: { notIn: [ROLES.STUDENT, ROLES.OWNER] } },
  student: { role: ROLES.STUDENT },
  // Ko'p rollilik: qo'shimcha roli o'qituvchi bo'lgan xodim ham o'qituvchi (`hasRole`)
  teacher: {
    OR: [{ role: ROLES.TEACHER }, { extraRoles: { has: ROLES.TEACHER }, role: { notIn: [ROLES.STUDENT, ROLES.OWNER] } }],
  },
  any: { role: { not: ROLES.OWNER } },
};

/**
 * Qidiruv nomzodlari — filialdagi odamlarning YENGIL ro'yxati.
 *
 * Mavjud servislardan hech biri bu savolga to'g'ri kelmaydi:
 * `getAllUsersShort` arxivlangan va login o'chirilganlarni tashlab
 * yuboradi ("arxivdagi Aliyevni qaytar" topilmasdi), `getAllUsers` esa
 * sahifalangan va har qatorga ish jadvalini hisoblaydi. Shuning uchun
 * `getAllUsers` filtri (rol, `isArchived`) bilan AYNI shartdagi o'qish
 * so'rovi shu yerda — faqat ism, rol, holat va sinf nomi olinadi.
 *
 * ⚠️ Owner ro'yxatga kirmaydi: u amallarning nishoni bo'la olmaydi va
 * "Administrator" kabi ism bilan chalkashlik tug'dirardi.
 */
async function loadRoster({ role, includeArchived }) {
  return prisma.user.findMany({
    where: {
      ...(ROLE_FILTERS[role] ?? ROLE_FILTERS.any),
      ...(includeArchived ? {} : { isArchived: false }),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      username: true,
      role: true,
      extraRoles: true,
      isActive: true,
      isArchived: true,
      positionId: true,
      salaryCategoryId: true,
      classes: { select: { class: { select: { name: true } } } },
    },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: ROSTER_LIMIT,
  });
}

/** Lavozim/toifa nomlari — faqat natijaga tushgan xodimlar uchun. */
async function loadStaffPlacement(people) {
  const positionIds = [...new Set(people.map((p) => p.positionId).filter(Boolean))];
  const categoryIds = [...new Set(people.map((p) => p.salaryCategoryId).filter(Boolean))];
  const [positions, categories] = await Promise.all([
    positionIds.length
      ? prisma.position.findMany({ where: { id: { in: positionIds } }, select: { id: true, name: true } })
      : [],
    categoryIds.length
      ? prisma.salaryCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } })
      : [],
  ]);
  return {
    positions: new Map(positions.map((p) => [p.id, p.name])),
    categories: new Map(categories.map((c) => [c.id, c.name])),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Profil bo'laklari
// ─────────────────────────────────────────────────────────────────────────

/**
 * Bo'lim o'qilmasa butun profil yiqilmasligi kerak: moliya ma'lumoti
 * bo'lmasa ham ism, sinf va holat foydali. Xato ochiq yoziladi —
 * model "qarzi yo'q" deb taxmin qilmasligi uchun.
 */
function settledValue(result, build) {
  if (result.status === "fulfilled") return build(result.value);
  return { unavailable: true, reason: result.reason?.message || "O'qib bo'lmadi" };
}

async function buildStudentFinance(userId, monthKey) {
  const [enrollment, tariff, discounts, account, invoices] = await Promise.allSettled([
    studentEnrollmentService.getStudentEnrollments(userId),
    tariffResolutionService.resolveForStudent(userId, monthKey),
    studentDiscountService.getStudentDiscounts(userId),
    studentAccountService.getStudentAccount(userId),
    invoiceService.getInvoices({
      query: { studentId: userId, month: String(monthKey), includeCancelled: "true", limit: "3" },
    }),
  ]);

  return {
    enrollment: settledValue(enrollment, (e) => ({
      isStudying: e.isStudying,
      hasPeriods: e.hasPeriods,
      stateLabel: !e.hasPeriods
        ? "O'qish davri yo'q (hisob-faktura yozilmaydi)"
        : e.isStudying
          ? e.isFrozen
            ? "O'qiyapti, muzlatilgan"
            : "O'qiyapti"
          : "O'qimayapti",
      financeStatusLabel: e.financeStatusLabel,
      sinceLabel: e.since ? formatDateUz(e.since, { utc: true }) : null,
      untilLabel: e.until ? formatDateUz(e.until, { utc: true }) : null,
      currentMonth: {
        monthLabel: e.currentMonth.monthLabel,
        enrolled: e.currentMonth.enrolled,
        isProrated: e.currentMonth.isProrated,
        billableDays: e.currentMonth.billableDays,
        monthDays: e.currentMonth.monthDays,
      },
      periods: e.items.slice(-5).map((p) => ({
        startLabel: formatDateUz(p.startDate, { utc: true }),
        endLabel: p.endDate ? formatDateUz(p.endDate, { utc: true }) : null,
        endReasonLabel: p.endReasonLabel,
        isOpen: p.isOpen,
      })),
      periodCount: e.items.length,
    })),
    tariff: settledValue(tariff, (t) =>
      t.reason
        ? {
            monthLabel: t.monthLabel,
            missing: true,
            reasonLabel:
              t.reason === "no_assignment"
                ? "Tarif biriktirilmagan — hisob-faktura yozilmaydi"
                : "Tarifning bu oy uchun narxi yo'q — hisob-faktura yozilmaydi",
          }
        : {
            monthLabel: t.monthLabel,
            name: t.items[0]?.tariff?.name ?? null,
            directionName: t.items[0]?.tariff?.direction?.name ?? null,
            priceAmount: t.total,
            priceLabel: formatMoneyUz(t.total),
            isCustomPrice: t.isCustom,
          },
    ),
    currentInvoice: settledValue(invoices, (res) => {
      const invoice = res.data.find((row) => row.status !== "cancelled") ?? res.data[0];
      if (!invoice) return { exists: false, monthLabel: formatMonthKey(monthKey) };
      return {
        exists: true,
        monthLabel: invoice.monthLabel,
        statusLabel: invoice.statusLabel,
        amountLabel: formatMoneyUz(invoice.amount),
        discountLabel: invoice.hasDiscount ? formatMoneyUz(invoice.discountAmount) : null,
        prorationLabel: invoice.prorationLabel,
        paidLabel: formatMoneyUz(invoice.paidAmount),
        debtLabel: formatMoneyUz(invoice.debt),
      };
    }),
    discounts: settledValue(discounts, (d) => ({
      activeCount: d.current.length,
      active: d.current.map((a) => ({
        name: a.discount?.name ?? "—",
        valueLabel: a.discount?.valueLabel ?? null,
        periodLabel: a.periodLabel,
        isExclusive: Boolean(a.discount?.isExclusive),
      })),
      historyCount: d.items.length,
    })),
    account: settledValue(account, (a) => ({
      depositAmount: a.balance,
      depositLabel: formatMoneyUz(a.balance),
      openDebtAmount: a.debt,
      openDebtLabel: formatMoneyUz(a.debt),
    })),
  };
}

async function buildStaffDetails(user) {
  const [salary, placement, branches] = await Promise.allSettled([
    staffSalaryService.getStaffHistory(user.id),
    loadStaffPlacement([user]),
    userService.getUserBranches(user.id),
  ]);

  return {
    position: settledValue(placement, (p) => ({
      positionName: user.positionId ? p.positions.get(user.positionId) ?? "—" : null,
      salaryCategoryName: user.salaryCategoryId ? p.categories.get(user.salaryCategoryId) ?? "—" : null,
    })),
    salaryRule: settledValue(salary, (s) =>
      s.current
        ? {
            monthLabel: s.currentMonthLabel,
            typeLabel: s.current.typeLabel,
            fixedAmountLabel: formatMoneyUz(s.current.fixedAmount),
            effectiveRateLabel: Number(s.current.effectiveRate) > 0 ? formatMoneyUz(s.current.effectiveRate) : null,
            allowanceTotalLabel: Number(s.current.allowanceTotal) > 0 ? formatMoneyUz(s.current.allowanceTotal) : null,
            categoryName: s.current.categoryName,
            periodLabel: s.current.periodLabel,
            note: s.current.note || null,
            ruleCount: s.items.length,
            formulaNote:
              "Oylik qoidasi — yakuniy oylikning bir qismi: lavozim bazasi, dars soati (KPI) va ustamalar qo'shiladi. Aniq summa oylik bo'limida.",
          }
        : { monthLabel: s.currentMonthLabel, missing: true, ruleCount: s.items.length },
    ),
    branches: settledValue(branches, (rows) =>
      rows.map((row) => ({
        branchId: row.branch.id,
        branchName: row.branch.name,
        isHome: row.isHome,
        role: row.role,
        permissionCount: row.permissions.length,
        isActive: row.isActive,
        profileMissing: row.profileMissing,
      })),
    ),
    penaltyPoints: user.penaltyPoints ?? 0,
    permissionCount: expandLegacyKeys(user.permissions || []).filter((k) => PERMISSION_KEYS.includes(k)).length,
    subjects: (user.subjects || []).map((s) => pick(s, ["id", "name"])),
    workSchedule: user.effectiveSchedule
      ? pick(user.effectiveSchedule, ["workStartTime", "workEndTime", "workDays", "source"])
      : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Vositalar
// ─────────────────────────────────────────────────────────────────────────

const searchPeople = defineTool({
  name: "search_people",
  toolset: "core",
  label: "Odam qidirilmoqda",
  description:
    "Find students or staff in the CURRENT branch by name. Use this FIRST whenever the owner names a person (e.g. 'Aliyev Vali', 'Vali Aliyev', 'Aliyev V', typo 'Aliev') before any other person tool or proposal. Word order does not matter; initials, prefixes, apostrophe variants and small typos are handled; login (username) also matches. Returns up to 15 ranked candidates {id, fullName, role, roleLabel, statusLabel, classes, positionOrCategory, match} plus matchQuality: exact_unique means one certain match; any *_multiple, similar_only or partial_only means you MUST ask the owner which person they mean. Archived people are excluded unless includeArchived is true. Phone numbers are never returned here.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 100,
        description: "Name as the owner said it: first name, last name, both in any order, initials, or login.",
      },
      role: {
        type: "string",
        enum: ["any", "student", "staff", "teacher"],
        default: "any",
        description: "Narrow by role: student, staff (every non-student), teacher (primary or extra role), or any.",
      },
      includeArchived: {
        type: "boolean",
        default: false,
        description: "Also search archived people (needed e.g. to restore someone).",
      },
    },
  },
  async handler(args) {
    const words = normalizeKey(args.query).split(" ").filter(Boolean);
    if (words.length === 0) {
      throw new AiToolError("Qidiruv so'rovida harf yoki raqam yo'q");
    }
    // Taqsimot qidiruvi so'zlar soniga eksponent bog'liq; ism-sharif 4 so'zdan oshmaydi
    if (words.length > MAX_QUERY_WORDS) {
      throw new AiToolError(`Ismni ko'pi bilan ${MAX_QUERY_WORDS} so'z bilan yozing`);
    }

    const roster = await loadRoster({ role: args.role, includeArchived: args.includeArchived });
    const ranked = rankPeople(args.query, roster);

    const { items, total, truncated } = sliceList(ranked, SEARCH_MAX_CANDIDATES);
    const [roleLabel, placement] = await Promise.all([
      loadRoleLabeler(),
      loadStaffPlacement(items.map((r) => r.person)),
    ]);
    const matchQuality = summarizeMatch(ranked);

    return {
      query: args.query,
      scope: {
        role: args.role,
        includeArchived: args.includeArchived,
        searchedPeople: roster.length,
      },
      matchQuality,
      hint: MATCH_HINTS[matchQuality],
      total,
      truncated,
      candidates: items.map(({ person, match }) => ({
        id: person.id,
        fullName: personName(person),
        role: person.role,
        roleLabel: roleLabel(person.role),
        extraRoleLabels: (person.extraRoles || []).map(roleLabel),
        statusLabel: statusLabel(person),
        isActive: person.isActive,
        isArchived: person.isArchived,
        classes: person.classes.map((c) => c.class.name),
        positionOrCategory:
          (person.positionId && placement.positions.get(person.positionId)) ||
          (person.salaryCategoryId && placement.categories.get(person.salaryCategoryId)) ||
          null,
        match,
        matchLabel: MATCH_LABELS[match],
      })),
    };
  },
});

const getPerson = defineTool({
  name: "get_person",
  toolset: "core",
  label: "Profil o'qilmoqda",
  description:
    "Full compact profile of ONE person by id (resolve the id with search_people first). Returns identity, roles, status flags (active login, archived), gender, classes/subjects, home branch and branch access, createdAtLabel, and the person's phone and parentPhone (the only tool that returns phones — mention them only if the owner asks). For students also: enrollment state and periods, current-month tariff price, current invoice, active discounts, deposit balance and total open debt. For staff also: position or salary category, current salary rule summary, penalty points, permission count, work schedule. Sections that fail to load are marked unavailable instead of guessed.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Person id (24 hex) from search_people or another people tool."),
    },
  },
  async handler(args, ctx) {
    const userId = requireId(args.userId, "userId");
    const user = await userService.getUserById(userId);

    if (!user) {
      const entry = await userDirectory.findByUserId(userId);
      if (!entry) throw new AiToolError("Foydalanuvchi topilmadi");
      const home = await branchService.findById(entry.branchId);
      throw new AiToolError(
        `Bu foydalanuvchi joriy filialda yo'q. Uning asosiy filiali — "${home?.name ?? "noma'lum"}". Profilni ko'rish uchun o'sha filialga o'ting.`,
      );
    }

    const [roleLabel, directory] = await Promise.all([
      loadRoleLabeler(),
      userDirectory.findByUserId(userId),
    ]);
    const homeBranch = directory ? await branchService.findById(directory.branchId) : null;

    const profile = {
      id: user.id,
      fullName: personName(user),
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      role: user.role,
      roleLabel: roleLabel(user.role),
      extraRoles: (user.extraRoles || []).map((value) => ({ value, label: roleLabel(value) })),
      genderLabel: GENDER_LABELS[user.gender] ?? "Belgilanmagan",
      statusLabel: statusLabel(user),
      isActive: user.isActive,
      isArchived: user.isArchived,
      archivedAtLabel: user.archivedAt ? formatDateTimeUz(user.archivedAt) : null,
      createdAtLabel: formatDateUz(user.createdAt),
      phone: formatPhoneUz(user.phone),
      parentPhone: formatPhoneUz(user.parentPhone),
      classes: (user.classes || []).map((c) => pick(c, ["id", "name"])),
      homeBranch: homeBranch
        ? { id: homeBranch.id, name: homeBranch.name, isCurrent: homeBranch.id === ctx.branch.id }
        : { missing: true, note: "Platforma ro'yxatida yozuv yo'q (eski foydalanuvchi)" },
      currentBranch: { id: ctx.branch.id, name: ctx.branch.name },
    };

    if (user.role === ROLES.OWNER) {
      return { ...profile, note: "Tizim egasi — barcha ruxsatlarga ega, amallar bilan o'zgartirilmaydi." };
    }

    if (user.role === ROLES.STUDENT) {
      return {
        ...profile,
        penaltyPoints: user.penaltyPoints ?? 0,
        coinBalance: user.coinBalance ?? 0,
        finance: await buildStudentFinance(user.id, ctx.monthKey),
      };
    }

    return { ...profile, staff: await buildStaffDetails(user) };
  },
});

const peopleStats = defineTool({
  name: "people_stats",
  toolset: "people",
  label: "Foydalanuvchilar statistikasi",
  description:
    "Headcount snapshot of the CURRENT branch: staff by role (active / login disabled / archived), students (non-archived, archived), students actually studying (open enrollment period), non-archived students with no enrollment period at all (data gap: they are never invoiced), Telegram-linked users and active premium count. Use for 'how many students/teachers do we have'. Note: 'studying' (open enrollment) is the authoritative student count; it can differ from the non-archived count.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const [base, grouped, openPeriods, enrolledEver, nonArchivedStudents, roleLabel] = await Promise.all([
      userService.getStats(),
      prisma.user.groupBy({
        by: ["role", "isArchived", "isActive"],
        where: { role: { not: ROLES.OWNER } },
        _count: { _all: true },
      }),
      prisma.studentEnrollment.findMany({
        where: { endDate: null },
        distinct: ["studentId"],
        select: { studentId: true },
      }),
      // `StudentEnrollment.studentId` — soft ref (FK yo'q), shuning uchun
      // "davri yo'q o'quvchi" relation filtri bilan emas, to'plam farqi bilan.
      prisma.studentEnrollment.findMany({ distinct: ["studentId"], select: { studentId: true } }),
      prisma.user.findMany({ where: { role: ROLES.STUDENT, isArchived: false }, select: { id: true } }),
      loadRoleLabeler(),
    ]);

    const byRole = new Map();
    for (const row of grouped) {
      const entry = byRole.get(row.role) ?? { active: 0, loginDisabled: 0, archived: 0 };
      if (row.isArchived) entry.archived += row._count._all;
      else if (row.isActive === false) entry.loginDisabled += row._count._all;
      else entry.active += row._count._all;
      byRole.set(row.role, entry);
    }

    const studentRow = byRole.get(ROLES.STUDENT) ?? { active: 0, loginDisabled: 0, archived: 0 };
    const enrolledSet = new Set(enrolledEver.map((row) => row.studentId));
    const withoutPeriods = nonArchivedStudents.filter((row) => !enrolledSet.has(row.id)).length;

    const staffRoles = [...byRole.entries()]
      .filter(([role]) => role !== ROLES.STUDENT)
      .map(([role, counts]) => ({ role, roleLabel: roleLabel(role), ...counts }))
      .sort((a, b) => b.active - a.active);

    return {
      students: {
        nonArchived: studentRow.active + studentRow.loginDisabled,
        loginDisabled: studentRow.loginDisabled,
        archived: studentRow.archived,
        studying: openPeriods.length,
        withoutEnrollmentPeriod: withoutPeriods,
      },
      staff: {
        active: staffRoles.reduce((sum, r) => sum + r.active, 0),
        loginDisabled: staffRoles.reduce((sum, r) => sum + r.loginDisabled, 0),
        archived: staffRoles.reduce((sum, r) => sum + r.archived, 0),
        byRole: staffRoles,
      },
      telegramUsers: base.telegramUsers,
      activePremium: base.premiumUsers,
      notes: [
        "'studying' — bugun ochiq o'qish davri bor o'quvchilar. Dashboarddagi oylik son shu oyni qamragan davrlar bo'yicha sanaladi va undan farq qilishi mumkin.",
        "Xodimlar sonida tizim egasi hisobga olinmagan.",
      ],
    };
  },
});

const peopleList = defineTool({
  name: "people_list",
  toolset: "people",
  label: "Foydalanuvchilar ro'yxati",
  description:
    "List people of the CURRENT branch with filters, newest first: role ('staff' = every non-student incl. owner, 'student', 'teacher', 'reception' or any role value from people_roles), classId (members of a class), archived (true = only archived, false = only non-archived), search (substring of first name, last name or login; for full names prefer search_people). Returns {total, truncated, items:[{id, fullName, role, roleLabel, statusLabel, classes, subjects, penaltyPoints, coinBalance, createdAtLabel}]}. No phone numbers.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      role: {
        type: "string",
        maxLength: 40,
        description: "Role filter: 'staff', 'student', 'teacher', 'reception' or another role value. Omit for everyone.",
      },
      classId: idSchema("Only members of this class (id from people_classes)."),
      archived: { type: "boolean", default: false, description: "true = only archived people; false (default) = only non-archived." },
      search: { type: "string", maxLength: 60, description: "Substring of first name, last name or login." },
      limit: limitSchema(60, "Maximum rows."),
    },
  },
  async handler(args, ctx) {
    const limit = args.limit ?? 20;
    const roleLabel = await loadRoleLabeler();

    if (args.role && args.role !== "staff") {
      const known = await roleService.getRoleOptions();
      if (!known.some((r) => r.value === args.role)) {
        throw new AiToolError(
          `Noma'lum rol: "${args.role}". Mavjud rollar: staff, ${known.map((r) => r.value).join(", ")}`,
        );
      }
    }

    // Servis qidiruvi bitta so'zni oladi: bir necha so'z bo'lsa eng uzuni
    // serverga beriladi, qolganlari shu sahifa ichida qo'shimcha filtr.
    const words = (args.search || "").split(/\s+/).filter(Boolean);
    const serverWord = words.reduce((longest, w) => (w.length > longest.length ? w : longest), "");
    const extraKeys = words.filter((w) => w !== serverWord).map((w) => normalizeKey(w)).filter(Boolean);

    const { users, pagination } = await userService.getAllUsers(
      {
        role: args.role,
        class: args.classId,
        archived: args.archived ? "true" : "false",
        search: serverWord || undefined,
        page: "1",
        limit: String(extraKeys.length ? 100 : limit),
      },
      ctx.user,
    );

    const filtered = extraKeys.length
      ? users.filter((u) => {
          const hay = normalizeKey(`${u.firstName} ${u.lastName ?? ""} ${u.username}`);
          return extraKeys.every((k) => hay.includes(k));
        })
      : users;

    const { items } = sliceList(filtered, limit);
    // Ko'p so'zli qidiruvda filtr faqat birinchi 100 qatorga qo'llanadi —
    // server ko'proq topgan bo'lsa, natija to'liq emasligi ochiq aytiladi.
    const scanIncomplete = extraKeys.length > 0 && pagination.total > users.length;
    const total = extraKeys.length ? filtered.length : pagination.total;

    return {
      filters: {
        role: args.role ?? null,
        classId: args.classId ?? null,
        archived: args.archived,
        search: args.search ?? null,
      },
      total,
      truncated: total > items.length || scanIncomplete,
      ...(scanIncomplete
        ? { note: `Qidiruv "${serverWord}" bo'yicha ${pagination.total} ta natijaning faqat birinchi ${users.length} tasi ichida aniqlashtirildi — search_people dan foydalaning.` }
        : {}),
      items: items.map((u) => ({
        id: u.id,
        fullName: personName(u),
        role: u.role,
        roleLabel: roleLabel(u.role),
        statusLabel: statusLabel(u),
        ...(u.role === ROLES.STUDENT
          ? { classes: (u.classes || []).map((c) => c.name), coinBalance: u.coinBalance ?? 0 }
          : { subjects: (u.subjects || []).map((s) => s.name) }),
        penaltyPoints: u.penaltyPoints ?? 0,
        createdAtLabel: formatDateUz(u.createdAt),
      })),
    };
  },
});

const peopleClasses = defineTool({
  name: "people_classes",
  toolset: "people",
  label: "Sinflar ro'yxati",
  description:
    "All classes of the CURRENT branch with non-archived student counts, active flag and creation date. Use to resolve a class name (e.g. '5-A') to its id, or to compare class sizes. Returns {total, totalStudents, items:[{id, name, isActive, studentCount, createdAtLabel}]}.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const classes = await classService.getAllClasses();
    const { items, total, truncated } = sliceList(classes, 100);
    return {
      total,
      truncated,
      totalStudents: classes.reduce((sum, c) => sum + c.studentCount, 0),
      emptyClasses: classes.filter((c) => c.studentCount === 0).map((c) => c.name),
      items: items.map((c) => ({
        id: c.id,
        name: c.name,
        isActive: c.isActive,
        studentCount: c.studentCount,
        createdAtLabel: formatDateUz(c.createdAt),
      })),
    };
  },
});

const peopleClassDetail = defineTool({
  name: "people_class_detail",
  toolset: "people",
  label: "Sinf tafsiloti",
  description:
    "One class by id with its student members (ordered by last name): id, fullName, statusLabel, genderLabel, penaltyPoints, coinBalance. Use before moving students between classes or to answer 'who is in 5-A'. Returns {id, name, isActive, createdBy, studentCount, students[]}. No phones, no credentials.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["classId"],
    properties: {
      classId: idSchema("Class id from people_classes."),
    },
  },
  async handler(args) {
    const classId = requireId(args.classId, "classId");
    // ⚠️ `getClassById` o'quvchilarni `plainPassword` bilan qaytaradi —
    // quyida faqat oq ro'yxatdagi maydonlar olinadi.
    const data = await classService.getClassById(classId);
    const { items, total, truncated } = sliceList(data.students, 100);
    return {
      id: data.id,
      name: data.name,
      isActive: data.isActive,
      createdBy: data.createdBy ? personName(data.createdBy) : null,
      createdAtLabel: formatDateUz(data.createdAt),
      studentCount: total,
      truncated,
      students: items.map((s) => ({
        id: s.id,
        fullName: personName(s),
        statusLabel: statusLabel(s),
        genderLabel: GENDER_LABELS[s.gender] ?? "Belgilanmagan",
        penaltyPoints: s.penaltyPoints ?? 0,
        coinBalance: s.coinBalance ?? 0,
      })),
    };
  },
});

const peopleSubjects = defineTool({
  name: "people_subjects",
  toolset: "people",
  label: "Fanlar ro'yxati",
  description:
    "All subjects of the CURRENT branch with active flag, description and the non-archived staff linked to each subject (teacher competence used by the lesson planner; not the timetable). Use to resolve a subject name to its id and to find subjects nobody teaches. Returns {total, uncovered[], items:[{id, name, isActive, description, teacherCount, teachers[{id, fullName}]}]}.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const [subjects, links] = await Promise.all([
      subjectService.getAllSubjects(),
      prisma.userSubject.findMany({
        where: { user: { role: { not: ROLES.STUDENT }, isArchived: false } },
        select: {
          subjectId: true,
          user: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);

    const bySubject = new Map();
    for (const link of links) {
      if (!bySubject.has(link.subjectId)) bySubject.set(link.subjectId, []);
      bySubject.get(link.subjectId).push({ id: link.user.id, fullName: personName(link.user) });
    }

    const { items, total, truncated } = sliceList(subjects, 100);
    return {
      total,
      truncated,
      uncovered: subjects.filter((s) => !bySubject.has(s.id)).map((s) => s.name),
      items: items.map((s) => {
        const teachers = bySubject.get(s.id) ?? [];
        return {
          id: s.id,
          name: s.name,
          isActive: s.isActive,
          description: s.description || null,
          teacherCount: teachers.length,
          teachers: teachers.slice(0, 20),
        };
      }),
    };
  },
});

const peopleRoles = defineTool({
  name: "people_roles",
  toolset: "people",
  label: "Rollar",
  description:
    "Platform role catalog shared by ALL branches: name, value, system flag, number of default permissions, users holding it (primary or extra role, across all branches, archived included) and default work time. Use to understand what a role grants by default or to map a role name to its value for people_list.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler() {
    const roles = await roleService.getAllRoles();
    return {
      total: roles.length,
      items: roles.map((r) => ({
        id: r.id,
        name: r.name,
        value: r.value,
        isSystem: r.isSystem,
        defaultPermissionCount: expandLegacyKeys(r.permissions || []).filter((k) => PERMISSION_KEYS.includes(k)).length,
        usersCount: r.usersCount,
        workStartTime: r.workStartTime || null,
        workEndTime: r.workEndTime || null,
        workDays: r.workDays || [],
      })),
    };
  },
});

const peoplePermissions = defineTool({
  name: "people_permissions",
  toolset: "people",
  label: "Ruxsatlar",
  description:
    "Permissions in the CURRENT branch (they are per-branch). Three modes: (1) userId → that staff member's permissions grouped by section with Uzbek labels, difference from their role defaults, extra roles, and permission counts in their other branches; (2) permissionKey without userId → which non-archived staff hold that key (e.g. 'finance.pay', or a section like 'finance' for any of its actions); (3) neither → every non-archived staff member with their permission count. Keys have the form 'section.action' (see the catalog in results). The owner always has everything; students have none.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      userId: idSchema("Staff member id. Omit to use permissionKey or the overview."),
      permissionKey: {
        type: "string",
        pattern: "^[a-zA-Z]+(\\.[a-zA-Z]+)?$",
        description: "Permission key 'section.action' (e.g. 'finance.pay') or bare section ('finance').",
      },
    },
  },
  async handler(args) {
    const roleLabel = await loadRoleLabeler();

    if (args.userId) {
      const userId = requireId(args.userId, "userId");
      const user = await userService.getUserById(userId);
      if (!user) throw new AiToolError("Foydalanuvchi joriy filialda topilmadi");

      const base = { id: user.id, fullName: personName(user), role: user.role, roleLabel: roleLabel(user.role) };
      if (user.role === ROLES.OWNER) {
        return { ...base, note: "Tizim egasi barcha ruxsatlarga ega; ruxsatlar ro'yxati unga qo'llanmaydi." };
      }
      const ownerByExtraRole = (user.extraRoles || []).includes(ROLES.OWNER);
      if (user.role === ROLES.STUDENT) {
        return { ...base, note: "O'quvchilarga ruxsat berilmaydi." };
      }

      const expanded = expandLegacyKeys(user.permissions || []);
      const keys = expanded.filter((k) => PERMISSION_KEYS.includes(k));
      const unknownKeys = expanded.filter((k) => !PERMISSION_KEYS.includes(k));

      const [roleDefaults, branches] = await Promise.all([
        roleService.getAllRoles().then((roles) => {
          const values = new Set([user.role, ...(user.extraRoles || [])]);
          return new Set(
            roles
              .filter((r) => values.has(r.value))
              .flatMap((r) => expandLegacyKeys(r.permissions || []))
              .filter((k) => PERMISSION_KEYS.includes(k)),
          );
        }),
        userService.getUserBranches(user.id),
      ]);

      const keySet = new Set(keys);
      return {
        ...base,
        extraRoles: (user.extraRoles || []).map((value) => ({ value, label: roleLabel(value) })),
        statusLabel: statusLabel(user),
        ...(ownerByExtraRole
          ? { note: "Qo'shimcha roli \"Ega\" — bu hisob barcha ruxsat darvozalaridan o'tadi; quyidagi ro'yxat amalda cheklov emas." }
          : {}),
        permissionCount: keys.length,
        sections: groupPermissions(keys),
        beyondRoleDefaults: keys.filter((k) => !roleDefaults.has(k)).map((key) => ({ key, label: permissionLabel(key) })),
        missingRoleDefaults: [...roleDefaults].filter((k) => !keySet.has(k)).map((key) => ({ key, label: permissionLabel(key) })),
        unknownKeys,
        otherBranches: branches
          .filter((row) => !row.profileMissing)
          .map((row) => ({
            branchName: row.branch.name,
            isHome: row.isHome,
            roleLabel: roleLabel(row.role),
            permissionCount: expandLegacyKeys(row.permissions).filter((k) => PERMISSION_KEYS.includes(k)).length,
            isActive: row.isActive,
          })),
      };
    }

    const staff = await permissionService.getStaff();

    if (args.permissionKey) {
      const key = args.permissionKey;
      const isSection = Boolean(KEYS_BY_SECTION[key]);
      if (!isSection && !PERMISSION_KEYS.includes(key)) {
        throw new AiToolError(`Noma'lum ruxsat kaliti: "${key}"`);
      }
      const holders = staff.filter((u) =>
        isSection
          ? KEYS_BY_SECTION[key].some((k) => hasPermission(u.permissions || [], k))
          : hasPermission(u.permissions || [], key),
      );
      const { items, total, truncated } = sliceList(holders, 100);
      return {
        permissionKey: key,
        permissionLabel: isSection
          ? `${PERMISSION_SECTIONS.find((s) => s.key === key).label} (bo'limning istalgan amali)`
          : permissionLabel(key),
        note: "Tizim egasi bu ro'yxatda yo'q — u barcha ruxsatlarga ega.",
        total,
        truncated,
        holders: items.map((u) => ({
          id: u.id,
          fullName: personName(u),
          roleLabel: roleLabel(u.role),
          statusLabel: statusLabel(u),
          ...(isSection
            ? { actions: KEYS_BY_SECTION[key].filter((k) => hasPermission(u.permissions || [], k)).map(permissionLabel) }
            : {}),
        })),
      };
    }

    const rows = staff
      .map((u) => ({
        id: u.id,
        fullName: personName(u),
        roleLabel: roleLabel(u.role),
        statusLabel: statusLabel(u),
        permissionCount: expandLegacyKeys(u.permissions || []).filter((k) => PERMISSION_KEYS.includes(k)).length,
      }))
      .sort((a, b) => b.permissionCount - a.permissionCount);
    const { items, total, truncated } = sliceList(rows, 100);
    return {
      catalogSize: PERMISSION_KEYS.length,
      total,
      truncated,
      withoutPermissions: rows.filter((r) => r.permissionCount === 0).length,
      items,
    };
  },
});

const peoplePermissionCatalog = defineTool({
  name: "people_permission_catalog",
  toolset: "people",
  label: "Ruxsatlar katalogi",
  description:
    "The grantable permission catalog: sections (with Uzbek label and group) and their action keys 'section.action' with Uzbek labels. Use it to translate the owner's words ('let her accept payments', 'allow editing grades') into exact keys before propose_change_permissions, or to explain what a key means. Optional section filter (e.g. 'finance') returns only that section.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      section: {
        type: "string",
        pattern: "^[a-zA-Z]+$",
        description: "Section key such as 'finance', 'users', 'payroll'. Omit for the whole catalog.",
      },
    },
  },
  async handler(args) {
    const sections = args.section
      ? PERMISSION_SECTIONS.filter((s) => s.key === args.section)
      : PERMISSION_SECTIONS;
    if (args.section && sections.length === 0) {
      throw new AiToolError(`Noma'lum ruxsat bo'limi: "${args.section}"`);
    }
    return {
      keyFormat: "section.action",
      note: "Bo'limning biror amali berilganda uning 'view' (Ko'rish) kaliti avtomatik qo'shiladi.",
      sectionCount: sections.length,
      sections: sections.map((s) => ({
        key: s.key,
        label: s.label,
        group: s.group,
        actions: s.actions.map((a) => `${s.key}.${a.key} — ${a.label}`),
      })),
    };
  },
});

const peopleStaffReport = defineTool({
  name: "people_staff_report",
  toolset: "people",
  label: "Xodimlar hisoboti",
  description:
    "HR report of the CURRENT branch for one month (the same report as the admin 'Xodimlar → Hisobotlar' tab): composition by role and gender, joiners/leavers and 6-month headcount trend, penalties (count, points, top offenders), tasks (assigned, completed, overdue, completion rate), staff attendance (percent, punctuality, lowest), indicators vs previous month, subject coverage (subjects without teachers, teachers without subjects) and tenure. Staff here includes the owner. Pass month as YYYYMM; omit for the current month.",
  timeoutMs: 45000,
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      month: monthSchema(),
    },
  },
  async handler(args) {
    const monthKey = monthArg(args.month);
    const report = await staffReportService.getStaffReport(monthKey % 100, Math.floor(monthKey / 100), {
      withAttendance: true,
    });
    const people = (list, keys, max = 5) => (list || []).slice(0, max).map((row) => pick(row, keys));

    return {
      monthLabel: formatMonthKey(monthKey),
      isCurrentMonth: report.isCurrentMonth,
      composition: report.composition,
      previous: report.previous,
      byRole: report.byRole.map((r) => pick(r, ["label", "total", "active", "archived", "percent"])),
      flow: {
        joined: report.flow.joined,
        left: report.flow.left,
        net: report.flow.net,
        trend: report.flow.trend.map((t) => pick(t, ["label", "joined", "left", "headcount"])),
      },
      penalties: {
        ...pick(report.penalties, ["count", "points", "fine", "reductionCount", "reductionPoints", "staffWithPenalty"]),
        top: people(report.penalties.top, ["userId", "name", "roleLabel", "count", "points"]),
      },
      tasks: {
        ...pick(report.tasks, ["assigned", "completed", "overdue", "active", "stopped", "staffWithTasks", "completionRate"]),
        top: people(report.tasks.top, ["userId", "name", "assigned", "completed", "overdue", "rate"]),
      },
      attendance: report.attendance
        ? {
            ...pick(report.attendance, ["present", "late", "absent", "excused", "marked", "percent", "punctuality"]),
            lowest: people(report.attendance.lowest, ["userId", "name", "roleLabel", "percent", "absent", "late"]),
          }
        : null,
      indicators: report.indicators.map((i) => pick(i, ["label", "current", "previous"])),
      quickStats: report.quickStats.map((q) => pick(q, ["label", "value", "percent"])),
      subjects: {
        ...pick(report.subjects, [
          "totalSubjects",
          "coveredSubjects",
          "uncoveredSubjects",
          "teacherTotal",
          "teachersWithSubject",
          "teachersWithoutSubject",
          "coveragePercent",
          "avgTeachersPerSubject",
          "avgSubjectsPerTeacher",
          "multiSubjectTotal",
        ]),
        uncovered: (report.subjects.uncovered || []).map((s) => s.name),
        unassignedTeachers: (report.subjects.unassignedTeachers || []).filter(Boolean).map((t) => t.name),
      },
      tenure: people(report.tenure, ["userId", "name", "roleLabel", "months", "attendancePercent"], 10),
    };
  },
});

const peopleBranches = defineTool({
  name: "people_branches",
  toolset: "people",
  label: "Filiallar",
  description:
    "All branches of the platform (archived included) with status, active flag, default flag, which one is the current branch, and non-archived student and staff counts from the platform directory (staff counts include the owner in their home branch). Use for cross-branch headcount comparisons or to tell the owner which branch a person belongs to.",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async handler(args, ctx) {
    const branches = await branchService.list({ includeArchived: "true" });
    return {
      currentBranchId: ctx.branch.id,
      total: branches.length,
      items: branches.map((b) => ({
        id: b.id,
        code: b.code,
        name: b.name,
        shortName: b.shortName || null,
        address: b.address || null,
        statusLabel: BRANCH_STATUS_LABELS[b.status] ?? b.status,
        isActive: b.isActive,
        isArchived: b.isArchived,
        isDefault: b.isDefault,
        isCurrent: b.id === ctx.branch.id,
        students: b.counts.students,
        staff: b.counts.staff,
        createdAtLabel: formatDateUz(b.createdAt),
      })),
    };
  },
});

module.exports = [
  searchPeople,
  getPerson,
  peopleStats,
  peopleList,
  peopleClasses,
  peopleClassDetail,
  peopleSubjects,
  peopleRoles,
  peoplePermissions,
  peoplePermissionCatalog,
  peopleStaffReport,
  peopleBranches,
];
