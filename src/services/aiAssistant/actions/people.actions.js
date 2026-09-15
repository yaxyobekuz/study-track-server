/**
 * AI YORDAMCHI — "Foydalanuvchilar" bo'limi amallari.
 *
 * Har bir amal HTTP yo'lining aynan nusxasi: `execute` controller chaqirgan
 * servisni controller bergan argumentlar bilan chaqiradi (izohda qaysi
 * route/controller ekani yozilgan). `prepare` esa servis rad etadigan har
 * bir holatni OLDINDAN tekshiradi — ega "Tasdiqlash" ni bosgandan keyin
 * kutilmagan 400/500 ko'rmasligi uchun.
 *
 * ⚠️ UY FILIALI (`design.md` §3.2 qoida 7, `people.md` H2). `updateUser`,
 * `archiveUser`, `restoreUser` oxirida `syncDirectory` chaqiriladi va u
 * odamning asosiy filialini JORIY filialga ko'chirib qo'yadi. Ko'p filialli
 * xodimni ikkinchi filialdan tahrirlash uning loginini boshqa filialga
 * yo'naltirib, ikkita "asosiy" biriktirish yozuvini qoldirardi. Shu sababli
 * bu amallar faqat odamning UY filialida bajariladi (`assertHomeBranch`).
 *
 * ⚠️ NIMA YO'Q (ataylab): foydalanuvchi yaratish/o'chirish, parol, qo'shimcha
 * rollar, filialga biriktirish, sinf/fan o'chirish — `design.md` §3.2 qoida 6.
 */

const userService = require("../../user.service");
const classService = require("../../class.service");
const subjectService = require("../../subject.service");
const permissionService = require("../../permission.service");
const branchService = require("../../branch.service");
const userDirectory = require("../../userDirectory.service");
const studentEnrollmentService = require("../../studentEnrollment.service");
const studentAccountService = require("../../studentAccount.service");
const invoiceService = require("../../invoice.service");
const { getFinanceSettings } = require("../../settings.service");
const prisma = require("../../../config/prisma");
const { ROLES } = require("../../../utils/constants");
const {
  PERMISSION_SECTIONS,
  PERMISSION_KEYS,
  KEYS_BY_SECTION,
  expandLegacyKeys,
  normalizePermissions,
  hasRole,
} = require("../../../utils/permissions");
const { normalizePhone, formatPhoneUz } = require("../../../helpers/phone.helpers");
const { findCandidates } = require("../../../helpers/scheduleSheet.helpers");
const { formatDateUz } = require("../../../helpers/date.helpers");
const { parseDayDate } = require("../../../helpers/month.helpers");
const { resolveEnrollmentForMonth } = require("../../../helpers/enrollment.helpers");
const {
  AiToolError,
  defineAction,
  idSchema,
  requireId,
  formatMoneyUz,
  monthLabel,
  personName,
} = require("../assistant.toolkit");

// ─────────────────────────────────────────────────────────────────────────
// Umumiy yordamchilar
// ─────────────────────────────────────────────────────────────────────────

const GENDER_LABELS = { male: "Erkak", female: "Ayol" };
const genderLabel = (value) => GENDER_LABELS[value] ?? "Belgilanmagan";

/** `archiveUser` yopgan davr sababi (`user.service.js` ARCHIVE_END_REASON) yorlig'i. */
const ARCHIVE_END_REASON_LABEL = "O'z ixtiyori bilan ketdi";

/** Ko'rinishda nomlar ro'yxati shu chegaradan uzun bo'lsa qisqartiriladi. */
const PREVIEW_LIST_LIMIT = 25;

/** "A, B, C va yana 4 ta" — ko'rinish kartasi cho'zilib ketmasligi uchun. */
function joinNames(names, limit = PREVIEW_LIST_LIMIT) {
  if (names.length === 0) return "—";
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} va yana ${names.length - limit} ta`;
}

/**
 * Ism, sinf va fan nomlarida `<` / `>` taqiqlanadi.
 *
 * HTTP yo'lida `xss-clean` ularni `&lt;` ga aylantiradi; bu yerda servis
 * to'g'ridan-to'g'ri chaqiriladi va xom `<` bazaga tushardi. Nomlar esa
 * Telegram xabarlariga (`parse_mode: "HTML"`) qochirilmasdan qo'yiladi —
 * xom teg ota-onaga ketadigan xabarni yiqitardi.
 */
const SAFE_TEXT_PATTERN = "^[^<>]+$";

/**
 * Iz = holat + ko'rinishning o'zi. Ko'rinishdagi har bir fakt (sana, qarz,
 * hisob-faktura bor-yo'qligi, filiallar soni) o'zgarsa, ega eskirgan
 * kartani tasdiqlab yubormasligi uchun. Ko'rinish matni o'zgarmagan holat
 * uchun deterministik (ro'yxatlar tartiblangan).
 */
const withPreview = (state, preview) => ({ ...state, preview });

const sortedIds = (ids) => [...new Set(ids)].sort();

const sameIdSet = (a, b) => {
  const left = sortedIds(a);
  const right = sortedIds(b);
  return left.length === right.length && left.every((id, i) => id === right[i]);
};

/**
 * Nishon odamni JORIY filialdan yuklaydi.
 *
 * Odam bu filialda yo'q bo'lsa, uning uy filiali nomi bilan tushuntiriladi —
 * model "topilmadi" deb noto'g'ri xulosa qilmasligi uchun.
 *
 * @param {string} userId
 * @param {{ allowOwner?: boolean }} [options]
 */
async function loadTarget(userId, { allowOwner = false } = {}) {
  const id = requireId(userId, "userId");
  const user = await userService.getUserById(id);
  if (!user) {
    const entry = await userDirectory.findByUserId(id);
    if (!entry) throw new AiToolError("Foydalanuvchi topilmadi");
    const home = await branchService.findById(entry.branchId);
    throw new AiToolError(
      `Bu foydalanuvchi joriy filialda yo'q — uning asosiy filiali "${home?.name ?? "noma'lum"}". Amalni o'sha filialga o'tib bajaring.`,
    );
  }
  // ⚠️ `hasRole`, `role ===` EMAS: `setExtraRoles` `owner` ni qo'shimcha rol
  // sifatida qo'sha oladi va bunday hisob amalda ega darajasida ishlaydi
  // (`authorizePermission` uni har joyda o'tkazadi).
  if (!allowOwner && hasRole(user, ROLES.OWNER)) {
    throw new AiToolError("Tizim egasining (yoki ega rolidagi hisobning) profili bu amal bilan o'zgartirilmaydi");
  }
  return user;
}

/**
 * Identifikatsiyaga yozadigan amal faqat odamning UY filialida bajariladi.
 *
 * Platformada yozuvi yo'q (tizimga o'tishdan oldingi) foydalanuvchi uchun
 * to'siq yo'q: `syncDirectory` uni joriy filialga — uning yagona filialiga —
 * bog'laydi. Bu holat ogohlantirish sifatida qaytariladi.
 *
 * @returns {Promise<string|null>} ogohlantirish matni yoki null
 */
async function assertHomeBranch(userId, ctx) {
  const entry = await userDirectory.findByUserId(userId);
  if (!entry) {
    return "Foydalanuvchi platforma ro'yxatida yo'q (eski yozuv) — amal uni joriy filialga asosiy filial sifatida bog'laydi.";
  }
  if (entry.branchId === ctx.branch.id) return null;
  const home = await branchService.findById(entry.branchId);
  throw new AiToolError(
    `Bu amal faqat foydalanuvchining asosiy filialida bajariladi ("${home?.name ?? "noma'lum"}"). Aks holda uning logini joriy filialga ko'chib qolardi. O'sha filialga o'tib qayta so'rang.`,
  );
}

/** Odam nechta filialda profilga ega (identifikatsiya shu barchasiga yoziladi). */
async function branchCountOf(userId) {
  const access = await userDirectory.listAccess(userId);
  return Math.max(access.length, 1);
}

/** Owner uchun no-op, lekin HTTP yo'lidagi `restrictUserScope` bilan bir xil darvoza. */
async function mirrorUserScope(userId, ctx) {
  await userService.assertCanManageUser(userId, ctx.user);
}

const roleWord = (user) => (user.role === ROLES.STUDENT ? "o'quvchi" : "xodim");
const targetLabel = (user) => `${personName(user)} — ${roleWord(user)}`;

/** Prisma unique (P2002) xatosini egaga tushunarli xabarga aylantiradi. */
function rethrowUnique(error, message) {
  if (error?.code === "P2002") throw new AiToolError(message);
  throw error;
}

// ─────────────────────────────────────────────────────────────────────────
// Ruxsatlar: xavfli kalitlar
// ─────────────────────────────────────────────────────────────────────────

/**
 * Egaga ALOHIDA ko'rsatiladigan ruxsatlar. `finance.md` §11: bular pulni
 * ota-onasiz harakatlantiradi yoki tizim darajasidagi huquq beradi —
 * "ko'rish" bilan bir qatorda yashirinib ketmasligi kerak.
 */
const SENSITIVE_PERMISSIONS = Object.freeze({
  "finance.pay": "to'lov qabul qiladi (kassa)",
  "finance.void": "to'lovni bekor qiladi — pul qaytadi",
  "finance.refund": "o'quvchi depozitini qaytaradi — pul chiqadi",
  "finance.transfer": "to'lov turlari orasida pul o'tkazadi",
  "finance.accounts": "to'lov turlari va qoldiqlarini boshqaradi",
  "finance.adjust": "o'tgan oylar yozuvlarini to'g'rilaydi",
  "finance.cancel": "hisob-fakturani bekor qiladi",
  "finance.settings": "hisob-faktura sozlamalarini o'zgartiradi",
  "income.void": "tashqi kirimni bekor qiladi",
  "expenses.create": "kassadan xarajat chiqaradi",
  "expenses.void": "xarajatni bekor qiladi",
  "payroll.pay": "oylik to'laydi",
  "payroll.void": "oylik to'lovini bekor qiladi",
  "payroll.assign": "oylik qoidalarini belgilaydi",
  "damages.pay": "zarar to'lovini qabul qiladi",
  "damages.void": "zarar to'lovini bekor qiladi",
  "damages.waive": "zarar qarzini kechiradi",
  "users.password": "parollarni ko'radi va tiklaydi",
  "users.delete": "xodimlarni o'chiradi",
  "branches.create": "yangi filial (baza sxemasi) yaratadi",
  "branches.assign": "odamni boshqa filialga biriktiradi",
  "branches.archive": "filialni yopadi",
  "scheduleSync.source": "dars jadvali manbaini almashtiradi",
  "security.revoke": "seanslarni tugatadi",
});

/**
 * AI orqali BERILMAYDIGAN ruxsatlar — ular amalda EGA darajasidagi huquqqa
 * yo'l ochadi. Olib tashlash (revoke) ruxsat etiladi; berish esa faqat ega
 * o'zi "Ruxsatlar" sahifasida qiladigan qaror bo'lib qoladi.
 */
const OWNER_EQUIVALENT_PERMISSIONS = Object.freeze({
  // `attachToBranch` rolni platforma katalogidan tekshiradi va u yerda `owner`
  // bor — ya'ni bu kalit egasi istalgan odamni (o'zini ham) boshqa filialga
  // EGA roli bilan biriktira oladi.
  "branches.assign": "odamni boshqa filialga istalgan rol (shu jumladan ega roli) bilan biriktira oladi",
  // PostgreSQL schema yaratadi va migratsiya yugurtiradi (katalog izohi: "amalda owner darajasidagi huquq").
  "branches.create": "yangi filial bazasini yaratadi — ega darajasidagi amal",
  // `getUserPassword` ega hisobini ham ochib beradi — ega sifatida kirish yo'li.
  "users.password": "istalgan hisob parolini, shu jumladan ega parolini ko'ra oladi",
});

const PERMISSION_LABELS = new Map(
  PERMISSION_SECTIONS.flatMap((section) =>
    section.actions.map((action) => [`${section.key}.${action.key}`, `${section.label}: ${action.label}`]),
  ),
);
const permissionLabel = (key) => PERMISSION_LABELS.get(key) ?? key;

/**
 * Kiruvchi kalitlarni tekshiradi va yoyadi: aniq kalit ("finance.pay") yoki
 * bo'lim kaliti ("finance" — bo'limning barcha amallari).
 */
function expandRequestedKeys(keys, label) {
  const unknown = keys.filter((k) => !PERMISSION_KEYS.includes(k) && !KEYS_BY_SECTION[k]);
  if (unknown.length > 0) {
    throw new AiToolError(
      `${label}: noma'lum ruxsat kalit(lar)i — ${unknown.join(", ")}. To'g'ri kalitlarni people_permission_catalog dan oling.`,
    );
  }
  return expandLegacyKeys(keys);
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Ism, familiya, jins
// ─────────────────────────────────────────────────────────────────────────

const updateProfile = defineAction({
  type: "people.update_profile",
  toolName: "propose_update_person_profile",
  toolset: "people",
  title: "Foydalanuvchi ma'lumotlarini tahrirlash",
  risk: "medium",
  permission: "users.update",
  description:
    "Propose correcting a person's first name, last name and/or gender (student or staff, not the owner). Pass only the fields that change. Names are written to the person's profile in every branch they belong to; the login is not changed. A name cannot be cleared, only replaced. Must be run in the person's home branch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Person id from search_people."),
      firstName: { type: "string", minLength: 1, maxLength: 60, pattern: SAFE_TEXT_PATTERN, description: "New first name (no < or > characters)." },
      lastName: { type: "string", minLength: 1, maxLength: 60, pattern: SAFE_TEXT_PATTERN, description: "New last name (no < or > characters)." },
      gender: {
        type: "string",
        enum: ["male", "female", "unset"],
        description: "New gender: male, female, or unset to clear it.",
      },
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    const homeWarning = await assertHomeBranch(user.id, ctx);

    const patch = {};
    const fields = [];
    if (args.firstName !== undefined && args.firstName !== user.firstName) {
      patch.firstName = args.firstName;
      fields.push({ label: "Ism", before: user.firstName, after: args.firstName });
    }
    if (args.lastName !== undefined && args.lastName !== (user.lastName ?? "")) {
      patch.lastName = args.lastName;
      fields.push({ label: "Familiya", before: user.lastName || "—", after: args.lastName });
    }
    if (args.gender !== undefined) {
      const nextGender = args.gender === "unset" ? null : args.gender;
      if (nextGender !== (user.gender ?? null)) {
        patch.gender = nextGender;
        fields.push({ label: "Jins", before: genderLabel(user.gender), after: genderLabel(nextGender) });
      }
    }
    if (fields.length === 0) {
      throw new AiToolError("O'zgarish yo'q: ko'rsatilgan qiymatlar hozirgisi bilan bir xil yoki berilmagan");
    }

    const branches = await branchCountOf(user.id);
    const nextName = personName({ ...user, ...patch, fullName: undefined });

    return {
      params: { userId: user.id, patch },
      preview: {
        summary: `${personName(user)} ma'lumotlari yangilanadi${patch.firstName || patch.lastName ? `: ${nextName}` : ""}`,
        target: targetLabel(user),
        fields,
        effects: [
          branches > 1
            ? `O'zgarish odamning ${branches} ta filialdagi profiliga yoziladi`
            : "O'zgarish odamning profiliga yoziladi",
          `Login (${user.username}) va parol o'zgarmaydi`,
        ],
        warnings: homeWarning ? [homeWarning] : [],
      },
      fingerprint: {
        userId: user.id,
        firstName: user.firstName,
        lastName: user.lastName ?? null,
        gender: user.gender ?? null,
        patch,
      },
    };
  },
  // Mirrors PUT /api/users/:id — user.routes.js:95 (validateObjectId → users.update →
  // restrictUserScope) → user.controller.updateUser:125-133 `updateUser(req.params.id, req.body)`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.updateUser(params.userId, params.patch);
    return {
      summary: `${personName(user)} ma'lumotlari yangilandi`,
      details: [
        { label: "F.I.O", value: personName(user) },
        { label: "Jins", value: genderLabel(user.gender) },
      ],
      data: { userId: user.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Telefon raqamlari
// ─────────────────────────────────────────────────────────────────────────

const updatePhone = defineAction({
  type: "people.update_phone",
  toolName: "propose_update_person_phone",
  toolset: "people",
  title: "Telefon raqamini o'zgartirish",
  risk: "medium",
  permission: "users.phone",
  description:
    "Propose setting or clearing a person's own phone and/or parent phone. Phone accepts Uzbek numbers like '+998 90 123 45 67', '998901234567' or '901234567'. To remove a number use clearPhone / clearParentPhone instead of an empty value. The number is written to the person's profile in all their branches.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Person id from search_people."),
      phone: { type: "string", maxLength: 30, description: "New own phone number." },
      parentPhone: { type: "string", maxLength: 30, description: "New parent phone number (students)." },
      clearPhone: { type: "boolean", default: false, description: "true = remove the own phone number." },
      clearParentPhone: { type: "boolean", default: false, description: "true = remove the parent phone number." },
    },
  },
  async prepare(args) {
    const user = await loadTarget(args.userId, { allowOwner: true });

    if (args.phone !== undefined && args.clearPhone) {
      throw new AiToolError("Telefon raqamini bir vaqtda ham yangilash, ham o'chirish mumkin emas");
    }
    if (args.parentPhone !== undefined && args.clearParentPhone) {
      throw new AiToolError("Ota-ona raqamini bir vaqtda ham yangilash, ham o'chirish mumkin emas");
    }

    const normalize = (value) => {
      try {
        return normalizePhone(value);
      } catch (error) {
        throw new AiToolError(error.message);
      }
    };

    const patch = {};
    const fields = [];
    const consider = (key, label, requested, clear) => {
      if (requested === undefined && !clear) return;
      const next = clear ? null : normalize(requested);
      if (next === (user[key] ?? null)) return;
      patch[key] = next;
      fields.push({ label, before: formatPhoneUz(user[key]), after: formatPhoneUz(next) });
    };
    consider("phone", "Telefon", args.phone, args.clearPhone);
    consider("parentPhone", "Ota-ona telefoni", args.parentPhone, args.clearParentPhone);

    if (fields.length === 0) {
      throw new AiToolError("O'zgarish yo'q: raqam berilmagan yoki hozirgisi bilan bir xil");
    }

    const warnings = [];
    if (patch.parentPhone && user.role !== ROLES.STUDENT) {
      warnings.push("Ota-ona telefoni odatda faqat o'quvchi uchun ishlatiladi");
    }
    const branches = await branchCountOf(user.id);

    return {
      params: { userId: user.id, patch },
      preview: {
        summary: `${personName(user)} telefon raqami yangilanadi`,
        target: targetLabel(user),
        fields,
        effects: [
          branches > 1 ? `Raqam odamning ${branches} ta filialdagi profiliga yoziladi` : "Raqam profilga yoziladi",
          "Davomatdagi \"Qo'ng'iroq\" tugmasi yangi raqamga boradi",
        ],
        warnings,
      },
      fingerprint: {
        userId: user.id,
        phone: user.phone ?? null,
        parentPhone: user.parentPhone ?? null,
        patch,
      },
    };
  },
  // Mirrors PUT /api/users/:id/phone — user.routes.js:107 (users.phone → restrictUserScope) →
  // user.controller.updateUserPhone:137-150 `updateUserPhone(req.params.id, { phone, parentPhone })`.
  async execute(params, ctx) {
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.updateUserPhone(params.userId, params.patch);
    return {
      summary: `${personName(user)} telefon raqami yangilandi`,
      details: [
        { label: "Telefon", value: formatPhoneUz(user.phone) },
        { label: "Ota-ona telefoni", value: formatPhoneUz(user.parentPhone) },
      ],
      data: { userId: user.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Loginni yoqish / o'chirish
// ─────────────────────────────────────────────────────────────────────────

const setLoginActive = defineAction({
  type: "people.set_login_active",
  toolName: "propose_set_login_active",
  toolset: "people",
  title: "Loginni yoqish yoki o'chirish",
  risk: "high",
  permission: "users.update",
  description:
    "Propose enabling (isActive=true) or disabling (isActive=false) a person's login. Disabling blocks the person in every branch on their next request but does NOT archive them: debts, invoices, enrollment, payroll and class membership stay unchanged. Use propose_archive_person when the person has left. Must be run in the person's home branch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "isActive"],
    properties: {
      userId: idSchema("Person id from search_people."),
      isActive: { type: "boolean", description: "true = allow login, false = block login." },
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    if (user.isActive === args.isActive) {
      throw new AiToolError(
        args.isActive ? "Bu foydalanuvchining logini allaqachon yoqilgan" : "Bu foydalanuvchining logini allaqachon o'chirilgan",
      );
    }
    const homeWarning = await assertHomeBranch(user.id, ctx);
    const branches = await branchCountOf(user.id);

    const effects = args.isActive
      ? [
          branches > 1 ? `Odam ${branches} ta filialning barchasida qayta kira oladi` : "Odam tizimga qayta kira oladi",
        ]
      : [
          branches > 1
            ? `Login ${branches} ta filialning barchasida darhol yopiladi`
            : "Login darhol yopiladi — keyingi so'rovda tizimdan chiqariladi",
          user.role === ROLES.STUDENT
            ? "Qarz, hisob-fakturalar va o'qish davri o'zgarmaydi — hisob-faktura yozilishda davom etadi"
            : "Oylik majburiyati hisoblanishda davom etadi (uni faqat arxivlash to'xtatadi)",
        ];

    const warnings = [];
    if (homeWarning) warnings.push(homeWarning);
    if (args.isActive && user.isArchived) {
      warnings.push("Foydalanuvchi arxivlangan — login yoqilsa ham kira olmaydi, avval arxivdan qaytarish kerak");
    }

    return {
      params: { userId: user.id, isActive: args.isActive },
      preview: {
        summary: `${personName(user)} logini ${args.isActive ? "yoqiladi" : "o'chiriladi"}`,
        target: targetLabel(user),
        fields: [
          { label: "Login", before: user.isActive ? "Yoqilgan" : "O'chirilgan", after: args.isActive ? "Yoqilgan" : "O'chirilgan" },
        ],
        effects,
        warnings,
      },
      fingerprint: { userId: user.id, isActive: user.isActive, isArchived: user.isArchived, next: args.isActive },
    };
  },
  // Mirrors PUT /api/users/:id — user.routes.js:95 → user.controller.updateUser:125-133
  // `updateUser(req.params.id, { isActive })`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.updateUser(params.userId, { isActive: params.isActive });
    return {
      summary: `${personName(user)} logini ${user.isActive ? "yoqildi" : "o'chirildi"}`,
      data: { userId: user.id, isActive: user.isActive },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Arxivlash
// ─────────────────────────────────────────────────────────────────────────

const archivePerson = defineAction({
  type: "people.archive",
  toolName: "propose_archive_person",
  toolset: "people",
  title: "Foydalanuvchini arxivlash",
  risk: "high",
  permission: "users.archive",
  description:
    "Propose archiving a student or staff member who has left. Consequences shown in the preview: login blocked in all branches; removed from all classes (not restored later); for students every open enrollment period is closed today with reason 'left' (no exit proration: an existing current-month invoice stays as is, but if the current month has not been invoiced yet it will never be, because generation skips archived students; existing debt remains); for staff no further payroll obligations, including the current month if it is not generated yet. Optional resetCoins / resetPenalties zero the balances (the old values are kept in an archive snapshot). If the student left for another reason (expelled, graduated, transferred), close the enrollment period with that reason in the finance section first. Must be run in the person's home branch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Person id from search_people."),
      resetCoins: { type: "boolean", default: false, description: "Set coin balance to 0." },
      resetPenalties: { type: "boolean", default: false, description: "Set penalty points to 0." },
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    if (user.isArchived) throw new AiToolError("Foydalanuvchi allaqachon arxivlangan");
    const homeWarning = await assertHomeBranch(user.id, ctx);
    const isStudent = user.role === ROLES.STUDENT;

    const fields = [
      { label: "Holat", before: user.isActive === false ? "Login o'chirilgan" : "Faol", after: "Arxivlangan" },
    ];
    if (args.resetCoins && user.coinBalance) {
      fields.push({ label: "Tangalar", before: String(user.coinBalance), after: "0" });
    }
    if (args.resetPenalties && user.penaltyPoints) {
      fields.push({ label: "Jarima ballari", before: String(user.penaltyPoints), after: "0" });
    }

    const branches = await branchCountOf(user.id);
    const effects = [
      branches > 1 ? `Login ${branches} ta filialning barchasida yopiladi` : "Login yopiladi",
    ];
    const warnings = homeWarning ? [homeWarning] : [];
    let openPeriodIds = [];
    let accountSnapshot = null;

    const classNames = (user.classes || []).map((c) => c.name).sort((a, b) => a.localeCompare(b));
    if (classNames.length > 0) {
      effects.push(`Barcha sinflardan chiqariladi: ${joinNames(classNames)} (arxivdan qaytarilganda tiklanmaydi)`);
    }

    if (isStudent) {
      const [enrollment, account, invoices] = await Promise.all([
        studentEnrollmentService.getStudentEnrollments(user.id),
        studentAccountService.getStudentAccount(user.id),
        invoiceService.getInvoices({
          query: { studentId: user.id, month: String(ctx.monthKey), limit: "1" },
        }),
      ]);
      const open = enrollment.items.filter((p) => p.isOpen);
      openPeriodIds = open.map((p) => p.id).sort();
      accountSnapshot = { debt: String(account.debt), balance: String(account.balance) };

      for (const period of open) {
        // `archiveUser`: endDate = max(startDate, bugun)
        const endDay = period.startDate > ctx.today ? period.startDate : ctx.today;
        effects.push(
          `${formatDateUz(period.startDate, { utc: true })} dan boshlangan o'qish davri ${formatDateUz(endDay, { utc: true })} sanasida "${ARCHIVE_END_REASON_LABEL}" sababi bilan yopiladi`,
        );
      }
      if (open.length === 0) {
        effects.push("Ochiq o'qish davri yo'q — davrlarga tegilmaydi");
      }
      // ⚠️ Generator arxivlanganlarni o'tkazib yuboradi (`invoiceGeneration.service`
      // `isArchived: false`): joriy oyning hisob-fakturasi hali yozilmagan bo'lsa,
      // u arxivlangandan keyin HECH QACHON yozilmaydi.
      const currentInvoice = invoices.data.find((row) => row.status !== "cancelled") ?? null;
      effects.push(
        currentInvoice
          ? `${monthLabel(ctx.monthKey)} hisob-fakturasi (${formatMoneyUz(currentInvoice.amount)}) o'zgarmaydi — chiqishda proratsiya yo'q; keyingi oylar uchun hisob-faktura yozilmaydi`
          : `${monthLabel(ctx.monthKey)} uchun hisob-faktura hali yozilmagan — arxivlangan o'quvchiga u endi yozilmaydi; keyingi oylar ham yozilmaydi`,
      );
      effects.push(
        Number(account.debt) > 0
          ? `Mavjud qarz (${formatMoneyUz(account.debt)}) bekor qilinmaydi`
          : "Ochiq qarz yo'q",
      );
      if (Number(account.balance) > 0) {
        warnings.push(`O'quvchi depozitida ${formatMoneyUz(account.balance)} qoladi — qaytarish moliya bo'limida alohida amal`);
      }
      warnings.push(
        "Ketish sababi \"chetlatildi\", \"bitirdi\" yoki \"boshqa filialga o'tdi\" bo'lsa, avval o'qish davrini shu sabab bilan yoping",
      );
    } else {
      // Oylik generatori ham arxivlanganlarni o'tkazib yuboradi (`payroll.service`
      // `isArchived: false`) — joriy oy majburiyati hali yo'q bo'lsa, u ham yozilmaydi.
      const currentEntry = await prisma.payrollEntry.findFirst({
        where: { staffId: user.id, month: ctx.monthKey, status: { not: "cancelled" } },
        select: { amount: true },
      });
      effects.push(
        currentEntry
          ? `${monthLabel(ctx.monthKey)} oylik majburiyati (${formatMoneyUz(currentEntry.amount)}) o'zgarmaydi; keyingi oylar uchun yozilmaydi`
          : `${monthLabel(ctx.monthKey)} uchun oylik majburiyati hali shakllanmagan — arxivlangan xodimga u endi yozilmaydi; keyingi oylar ham yozilmaydi`,
      );
      effects.push("Shakllangan majburiyatlar va oylik qarzi o'zgarmaydi; ruxsatlar, lavozim va fanlar saqlanib qoladi");
    }

    const preview = {
      summary: `${personName(user)} arxivlanadi`,
      target: targetLabel(user),
      fields,
      effects,
      warnings,
    };

    return {
      params: { userId: user.id, resetCoins: Boolean(args.resetCoins), resetPenalties: Boolean(args.resetPenalties) },
      preview,
      fingerprint: withPreview(
        {
          userId: user.id,
          today: ctx.today,
          isArchived: user.isArchived,
          isActive: user.isActive,
          coinBalance: user.coinBalance ?? 0,
          penaltyPoints: user.penaltyPoints ?? 0,
          classIds: sortedIds((user.classes || []).map((c) => c.id)),
          openPeriodIds,
          account: accountSnapshot,
          resetCoins: Boolean(args.resetCoins),
          resetPenalties: Boolean(args.resetPenalties),
        },
        preview,
      ),
    };
  },
  // Mirrors PUT /api/users/:id/archive — user.routes.js:110 (users.archive → restrictUserScope) →
  // user.controller.archiveUser:208-221 `archiveUser(id, { resetCoins: Boolean(..), resetPenalties: Boolean(..) })`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.archiveUser(params.userId, {
      resetCoins: Boolean(params.resetCoins),
      resetPenalties: Boolean(params.resetPenalties),
    });
    return {
      summary: `${personName(user)} arxivlandi`,
      details: [
        { label: "Tangalar", value: String(user.coinBalance ?? 0) },
        { label: "Jarima ballari", value: String(user.penaltyPoints ?? 0) },
      ],
      data: { userId: user.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Arxivdan qaytarish
// ─────────────────────────────────────────────────────────────────────────

const restorePerson = defineAction({
  type: "people.restore",
  toolName: "propose_restore_person",
  toolset: "people",
  title: "Arxivdan qaytarish",
  risk: "high",
  permission: "users.restore",
  description:
    "Propose restoring an archived student or staff member (find them with search_people includeArchived=true). Login is unblocked in all branches. For students an enrollment period is reopened (if it was closed today or later) or a new one starts today, which means entry proration for the current month; the invoice is created by the next automatic pass, not immediately. Classes, coins and penalty points from before archiving are NOT restored. For staff, payroll obligations resume from the next generation. Must be run in the person's home branch.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Archived person id from search_people (includeArchived=true)."),
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    if (!user.isArchived) throw new AiToolError("Foydalanuvchi arxivlanmagan");
    const homeWarning = await assertHomeBranch(user.id, ctx);

    const isStudent = user.role === ROLES.STUDENT;
    const branches = await branchCountOf(user.id);
    const effects = [branches > 1 ? `Login ${branches} ta filialning barchasida ochiladi` : "Login ochiladi"];
    const warnings = homeWarning ? [homeWarning] : [];
    let enrollmentPlan = null;

    // `archiveSnapshot` — arxivlashdagi asl qiymatlar; `restoreUser` ularni qaytarmaydi
    const snapshot = user.archiveSnapshot || {};
    const lost = [];
    if (isStudent && (snapshot.coinBalance ?? 0) !== (user.coinBalance ?? 0)) {
      lost.push(`tangalar ${snapshot.coinBalance ?? 0} (hozir ${user.coinBalance ?? 0})`);
    }
    if ((snapshot.penaltyPoints ?? 0) !== (user.penaltyPoints ?? 0)) {
      lost.push(`jarima ballari ${snapshot.penaltyPoints ?? 0} (hozir ${user.penaltyPoints ?? 0})`);
    }
    if (lost.length > 0) effects.push(`Arxivlashdagi qiymatlar qaytarilmaydi: ${lost.join(", ")}`);
    if (user.isActive === false) {
      warnings.push("Login bayrog'i o'chirilgan — arxivdan qaytgach ham kira olmaydi, uni alohida yoqish kerak");
    }

    if (isStudent) {
      effects.push("Sinflar qaytarilmaydi — ularni alohida belgilash kerak");
      const [enrollment, settings, invoices] = await Promise.all([
        studentEnrollmentService.getStudentEnrollments(user.id),
        getFinanceSettings(),
        invoiceService.getInvoices({
          query: { studentId: user.id, month: String(ctx.monthKey), limit: "1" },
        }),
      ]);
      const open = enrollment.items.filter((p) => p.isOpen);
      const last = [...enrollment.items].sort((a, b) => (a.startDate < b.startDate ? 1 : -1))[0];
      // `restoreUser` hisob-faktura YOZMAYDI — uni avtomatik o'tish (yoqilgan
      // bo'lsa va `invoiceDayOfMonth` kelgan bo'lsa) yoki qo'lda shakllantirish yozadi.
      const pendingInvoiceNote = settings.autoGenerateEnabled
        ? Number(ctx.today.slice(8, 10)) >= settings.invoiceDayOfMonth
          ? "Hisob-faktura darhol yaratilmaydi — uni navbatdagi avtomatik o'tish shakllantiradi"
          : `Hisob-faktura darhol yaratilmaydi — avtomatik shakllantirish oyning ${settings.invoiceDayOfMonth}-kunidan boshlanadi`
        : "Hisob-faktura darhol yaratilmaydi va avtomatik shakllantirish o'chirilgan — oyni moliya bo'limida qo'lda shakllantirish kerak";
      const hasCurrentInvoice = invoices.data.some((row) => row.status !== "cancelled");

      if (open.length > 0) {
        enrollmentPlan = { kind: "keep", periodId: open[0].id };
        effects.push("Ochiq o'qish davri bor — davrlarga tegilmaydi");
      } else if (last?.endDate && last.endDate >= ctx.today) {
        // `restoreUser`: bugun yoki keyinroq yopilgan davr qayta ochiladi (yangisi u bilan kesishardi)
        enrollmentPlan = { kind: "reopen", periodId: last.id };
        effects.push(
          `${formatDateUz(last.startDate, { utc: true })} dan boshlangan o'qish davri qayta ochiladi (yopilish sanasi olib tashlanadi)`,
        );
        effects.push(pendingInvoiceNote);
      } else {
        enrollmentPlan = { kind: "new", startDay: ctx.today };
        effects.push(`Yangi o'qish davri bugundan (${formatDateUz(ctx.today, { utc: true })}) ochiladi`);

        if (hasCurrentInvoice) {
          effects.push(`${monthLabel(ctx.monthKey)} hisob-fakturasi allaqachon bor — u avvalgidek qoladi`);
        } else {
          // Proratsiya qoidasi generator bilan AYNI: mavjud davrlar + yangi davr
          // (`resolveEnrollmentForMonth`) — oyning 1-kunini qamragan davr bo'lsa to'liq oy.
          const periods = [
            ...enrollment.items.map((p) => ({
              startDate: parseDayDate(p.startDate),
              endDate: p.endDate ? parseDayDate(p.endDate) : null,
            })),
            { startDate: parseDayDate(ctx.today), endDate: null },
          ];
          const resolved = resolveEnrollmentForMonth(periods, ctx.monthKey);
          effects.push(
            resolved.isProrated && settings.prorationEnabled
              ? `${monthLabel(ctx.monthKey)} uchun kirish proratsiyasi: ${resolved.billableDays}/${resolved.monthDays} kun hisoblanadi`
              : `${monthLabel(ctx.monthKey)} to'liq hisoblanadi`,
          );
          effects.push(pendingInvoiceNote);
        }
      }
    } else {
      effects.push("Oylik majburiyati keyingi shakllantirishdan boshlab yana hisoblanadi");
    }

    const preview = {
      summary: `${personName(user)} arxivdan qaytariladi`,
      target: targetLabel(user),
      fields: [{ label: "Holat", before: "Arxivlangan", after: user.isActive === false ? "Login o'chirilgan" : "Faol" }],
      effects,
      warnings,
    };

    return {
      params: { userId: user.id },
      preview,
      fingerprint: withPreview(
        { userId: user.id, today: ctx.today, isArchived: user.isArchived, isActive: user.isActive, enrollmentPlan },
        preview,
      ),
    };
  },
  // Mirrors PUT /api/users/:id/restore — user.routes.js:111 (users.restore → restrictUserScope) →
  // user.controller.restoreUser:224-232 `restoreUser(req.params.id)`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.restoreUser(params.userId);
    return {
      summary: `${personName(user)} arxivdan qaytarildi`,
      data: { userId: user.id },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Ruxsatlar
// ─────────────────────────────────────────────────────────────────────────

const changePermissions = defineAction({
  type: "people.set_permissions",
  toolName: "propose_change_permissions",
  toolset: "people",
  title: "Ruxsatlarni o'zgartirish",
  risk: "critical",
  description:
    "Propose granting and/or revoking permissions of ONE staff member in the CURRENT branch (permissions are per branch). grant and revoke take exact catalog keys 'section.action' (see people_permission_catalog) or a bare section key meaning all its actions. The result is merged with the current permissions; granting any action also grants that section's 'view'. Revoking a section's 'view' requires revoking its other actions too. Not allowed for the owner, accounts holding the owner role as an extra role, or students. Owner-equivalent keys (branches.assign, branches.create, users.password) cannot be granted through the assistant, only revoked. Money-moving and system-level keys are flagged in the preview.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: idSchema("Staff member id from search_people."),
      grant: {
        type: "array",
        maxItems: 60,
        items: { type: "string", pattern: "^[a-zA-Z]+(\\.[a-zA-Z]+)?$" },
        description: "Permission keys to add, e.g. ['finance.pay'] or ['attendance'].",
      },
      revoke: {
        type: "array",
        maxItems: 60,
        items: { type: "string", pattern: "^[a-zA-Z]+(\\.[a-zA-Z]+)?$" },
        description: "Permission keys to remove.",
      },
    },
  },
  async prepare(args, ctx) {
    const grantRaw = args.grant ?? [];
    const revokeRaw = args.revoke ?? [];
    if (grantRaw.length === 0 && revokeRaw.length === 0) {
      throw new AiToolError("Qo'shiladigan yoki olib tashlanadigan ruxsat ko'rsatilmagan");
    }

    const user = await loadTarget(args.userId, { allowOwner: true });
    if (user.role === ROLES.OWNER) throw new AiToolError("Tizim egasi allaqachon barcha ruxsatlarga ega");
    // Qo'shimcha roli `owner` bo'lgan hisob darvozalardan ruxsatsiz o'tadi — uning
    // ro'yxatini o'zgartirish hech narsani o'zgartirmaydi va ko'rinish yolg'on bo'lardi.
    if (hasRole(user, ROLES.OWNER)) {
      throw new AiToolError("Bu hisobning qo'shimcha roli \"Ega\" — u barcha ruxsatlarga ega, ro'yxatini o'zgartirish ta'sir qilmaydi");
    }
    if (user.role === ROLES.STUDENT) throw new AiToolError("O'quvchilarga ruxsat berib bo'lmaydi");

    const grants = expandRequestedKeys(grantRaw, "grant");
    const revokes = expandRequestedKeys(revokeRaw, "revoke");
    const ownerEquivalent = grants.filter((k) => OWNER_EQUIVALENT_PERMISSIONS[k]);
    if (ownerEquivalent.length > 0) {
      throw new AiToolError(
        `Bu ruxsatlar AI yordamchi orqali berilmaydi, chunki ular ega darajasidagi huquq beradi: ${ownerEquivalent
          .map((k) => `"${permissionLabel(k)}" (${OWNER_EQUIVALENT_PERMISSIONS[k]})`)
          .join("; ")}. Kerak bo'lsa, ularni "Ruxsatlar" sahifasida o'zingiz belgilang.`,
      );
    }
    const conflict = grants.filter((k) => revokes.includes(k));
    if (conflict.length > 0) {
      throw new AiToolError(`Bir kalit bir vaqtda ham qo'shilib, ham olib tashlanmoqda: ${conflict.join(", ")}`);
    }

    const storedExpanded = expandLegacyKeys(user.permissions || []);
    const staleKeys = storedExpanded.filter((k) => !PERMISSION_KEYS.includes(k));
    // ⚠️ "Hozir" — xodimda AMALDA bor kalitlar (`hasPermission` shu ro'yxatga
    // qaraydi), `normalizePermissions` natijasi EMAS: eski qatorda `.view` yo'q
    // bo'lsa, saqlashda u jimgina qo'shiladi va farq jadvalida ko'rinishi kerak.
    const current = PERMISSION_KEYS.filter((k) => storedExpanded.includes(k));

    const revokeSet = new Set(revokes);
    const next = normalizePermissions([...current, ...grants].filter((k) => !revokeSet.has(k)));

    // `normalizePermissions` bo'limda biror amal qolsa `.view` ni qaytaradi —
    // "ko'rishni olib tashla" so'rovi jimgina bajarilmay qolmasligi uchun rad etamiz.
    const stuck = revokes.filter((k) => next.includes(k));
    if (stuck.length > 0) {
      throw new AiToolError(
        `"${stuck.map(permissionLabel).join("\", \"")}" olib tashlanmaydi: bo'limning boshqa amallari qolmoqda. Ularni ham olib tashlang yoki butun bo'limni revoke qiling.`,
      );
    }

    const currentSet = new Set(current);
    const nextSet = new Set(next);
    const added = next.filter((k) => !currentSet.has(k));
    const removed = current.filter((k) => !nextSet.has(k));
    if (added.length === 0 && removed.length === 0) {
      throw new AiToolError("O'zgarish yo'q: so'ralgan ruxsatlar holati hozirgisi bilan bir xil");
    }

    const requestedGrants = new Set(grants);
    const autoViews = added.filter((k) => !requestedGrants.has(k));
    const changed = [...added, ...removed];
    const fields = [
      { label: "Ruxsatlar soni", before: String(current.length), after: String(next.length) },
      ...changed.slice(0, PREVIEW_LIST_LIMIT).map((key) => ({
        label: permissionLabel(key),
        before: currentSet.has(key) ? "Bor" : "Yo'q",
        after: nextSet.has(key) ? "Bor" : "Yo'q",
      })),
    ];

    const effects = [
      `Faqat "${ctx.branch.name}" filialida amal qiladi — boshqa filiallardagi ruxsatlarga tegilmaydi`,
      "Xodimning keyingi so'rovidan boshlab kuchga kiradi",
    ];
    if (changed.length > PREVIEW_LIST_LIMIT) {
      effects.push(`Jadvalda ${PREVIEW_LIST_LIMIT} ta o'zgarish ko'rsatildi, jami ${changed.length} ta`);
    }
    if (autoViews.length > 0) {
      effects.push(`Avtomatik qo'shiladi: ${autoViews.map(permissionLabel).join(", ")}`);
    }

    const warnings = added
      .filter((k) => SENSITIVE_PERMISSIONS[k])
      .map((k) => `Xavfli ruxsat beriladi: "${permissionLabel(k)}" — ${SENSITIVE_PERMISSIONS[k]}`);
    if (user.isArchived) warnings.push("Xodim arxivlangan — ruxsatlar u qaytarilgandagina ishlaydi");
    if (staleKeys.length > 0) {
      warnings.push(`Katalogda yo'q eski kalitlar olib tashlanadi: ${staleKeys.join(", ")}`);
    }

    return {
      params: { userId: user.id, permissions: next },
      preview: {
        summary: `${personName(user)}: ${added.length} ta ruxsat qo'shiladi, ${removed.length} ta olib tashlanadi`,
        target: `${targetLabel(user)} (${ctx.branch.name})`,
        fields,
        effects,
        warnings,
      },
      fingerprint: {
        userId: user.id,
        branchId: ctx.branch.id,
        role: user.role,
        current: [...(user.permissions || [])].sort(),
        next,
      },
    };
  },
  // Mirrors PUT /api/permissions/users/:id — permission.routes.js:18 (owner-only router) →
  // permission.controller.updateUserPermissions:37-52 `setUserPermissions(id, body.permissions, body.branchId)`
  // with no branchId (current branch). The full list is the merge computed in prepare; prepare is re-run
  // before execute, so a concurrent change surfaces as a changed preview instead of being overwritten.
  async execute(params) {
    const user = await permissionService.setUserPermissions(params.userId, params.permissions);
    return {
      summary: `${personName(user)} ruxsatlari yangilandi (${user.permissions.length} ta)`,
      data: { userId: user.id, permissionCount: user.permissions.length },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 7. O'quvchi sinflari
// ─────────────────────────────────────────────────────────────────────────

const setStudentClasses = defineAction({
  type: "people.set_student_classes",
  toolName: "propose_set_student_classes",
  toolset: "people",
  title: "O'quvchi sinflarini belgilash",
  risk: "medium",
  permission: "users.update",
  description:
    "Propose REPLACING the full class list of one student (classIds is the complete new list; an empty list removes the student from all classes). Class membership does not change price or past reports. Not for archived students (except clearing) and not for staff. To move several students from one class to another use propose_move_students_to_class.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "classIds"],
    properties: {
      userId: idSchema("Student id from search_people."),
      classIds: {
        type: "array",
        maxItems: 20,
        items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
        description: "Complete new list of class ids (from people_classes).",
      },
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    if (user.role !== ROLES.STUDENT) {
      throw new AiToolError("Sinf faqat o'quvchiga biriktiriladi. Xodim fanlari uchun propose_set_teacher_subjects ishlating");
    }
    const classIds = sortedIds(args.classIds);
    if (user.isArchived && classIds.length > 0) {
      throw new AiToolError("Arxivlangan o'quvchiga sinf biriktirish mumkin emas");
    }
    const homeWarning = await assertHomeBranch(user.id, ctx);

    const classes = await classService.getAllClasses();
    const byId = new Map(classes.map((c) => [c.id, c]));
    const missing = classIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new AiToolError(`Sinf topilmadi: ${missing.join(", ")}`);

    const currentIds = sortedIds((user.classes || []).map((c) => c.id));
    if (sameIdSet(currentIds, classIds)) {
      throw new AiToolError("O'zgarish yo'q: o'quvchi aynan shu sinflarda");
    }

    const nameOf = (id) => byId.get(id)?.name ?? (user.classes || []).find((c) => c.id === id)?.name ?? id;
    const warnings = homeWarning ? [homeWarning] : [];
    if (classIds.length === 0) warnings.push("O'quvchi hech bir sinfda qolmaydi");
    if (classIds.length > 1) warnings.push("O'quvchi bir vaqtda bir nechta sinfda bo'ladi");
    const inactive = classIds.filter((id) => byId.get(id)?.isActive === false).map(nameOf);
    if (inactive.length > 0) warnings.push(`Faol bo'lmagan sinf: ${inactive.join(", ")}`);

    return {
      params: { userId: user.id, classIds },
      preview: {
        summary: `${personName(user)} sinflari: ${joinNames(classIds.map(nameOf))}`,
        target: targetLabel(user),
        fields: [
          { label: "Sinflar", before: joinNames(currentIds.map(nameOf)), after: joinNames(classIds.map(nameOf)) },
        ],
        effects: [
          "Tarif va hisob-faktura summasiga ta'sir qilmaydi",
        ],
        warnings,
      },
      fingerprint: { userId: user.id, currentIds, classIds, isArchived: user.isArchived },
    };
  },
  // Mirrors PUT /api/users/:id — user.routes.js:95 → user.controller.updateUser:125-133
  // `updateUser(req.params.id, { classes })`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.updateUser(params.userId, { classes: params.classIds });
    return {
      summary: `${personName(user)} sinflari yangilandi: ${joinNames((user.classes || []).map((c) => c.name))}`,
      data: { userId: user.id, classIds: (user.classes || []).map((c) => c.id) },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 8. O'quvchilarni boshqa sinfga ko'chirish
// ─────────────────────────────────────────────────────────────────────────

const moveStudents = defineAction({
  type: "people.move_students",
  toolName: "propose_move_students_to_class",
  toolset: "people",
  title: "O'quvchilarni boshqa sinfga ko'chirish",
  risk: "medium",
  permission: "classes.transfer",
  description:
    "Propose moving selected students from one class to another (e.g. transfer from 5-A to 5-B). Every student must currently be a member of the source class (check with people_class_detail); their other class memberships stay. Class membership does not change price.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["sourceClassId", "targetClassId", "studentIds"],
    properties: {
      sourceClassId: idSchema("Class the students are in now (people_classes)."),
      targetClassId: idSchema("Class to move them to (people_classes)."),
      studentIds: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
        description: "Student ids to move (members of the source class).",
      },
    },
  },
  async prepare(args) {
    const sourceId = requireId(args.sourceClassId, "sourceClassId");
    const targetId = requireId(args.targetClassId, "targetClassId");
    if (sourceId === targetId) throw new AiToolError("Manba va maqsad sinf bir xil");

    const [source, target] = await Promise.all([
      classService.getClassById(sourceId),
      classService.getClassById(targetId),
    ]);

    const studentIds = sortedIds(args.studentIds);
    const members = new Map(source.students.map((s) => [s.id, s]));
    const notMembers = studentIds.filter((id) => !members.has(id));
    if (notMembers.length > 0) {
      // `moveStudentsToClass` a'zolikni tekshirmaydi va a'zo bo'lmaganni
      // shunchaki maqsad sinfga QO'SHIB yuborardi (people.md H10).
      const known = await prisma.user.findMany({
        where: { id: { in: notMembers } },
        select: { id: true, firstName: true, lastName: true },
      });
      const nameById = new Map(known.map((u) => [u.id, personName(u)]));
      const labels = notMembers.map((id) => nameById.get(id) ?? `noma'lum id ${id}`);
      throw new AiToolError(
        `"${source.name}" sinfida yo'q: ${joinNames(labels)}. A'zolarni people_class_detail bilan tekshiring.`,
      );
    }
    const archived = studentIds.filter((id) => members.get(id).isArchived).map((id) => personName(members.get(id)));
    if (archived.length > 0) {
      throw new AiToolError(`Arxivlangan o'quvchilarni ko'chirib bo'lmaydi: ${archived.join(", ")}`);
    }

    const targetMembers = new Set(target.students.map((s) => s.id));
    const alreadyInTarget = studentIds.filter((id) => targetMembers.has(id));
    const names = studentIds.map((id) => personName(members.get(id)));

    const warnings = [];
    if (alreadyInTarget.length > 0) {
      warnings.push(
        `"${target.name}" sinfida allaqachon bor: ${joinNames(alreadyInTarget.map((id) => personName(members.get(id))))} — ular faqat "${source.name}" dan chiqariladi`,
      );
    }
    if (target.isActive === false) warnings.push(`"${target.name}" sinfi faol emas`);

    const sourceAfter = source.students.length - studentIds.length;
    const targetAfter = target.students.length + studentIds.length - alreadyInTarget.length;

    return {
      params: { sourceClassId: sourceId, targetClassId: targetId, studentIds },
      preview: {
        summary: `${studentIds.length} ta o'quvchi "${source.name}" sinfidan "${target.name}" sinfiga ko'chiriladi`,
        target: `${source.name} → ${target.name}`,
        fields: [
          { label: `"${source.name}" o'quvchilari`, before: String(source.students.length), after: String(sourceAfter) },
          { label: `"${target.name}" o'quvchilari`, before: String(target.students.length), after: String(targetAfter) },
        ],
        effects: [
          `Ko'chiriladi: ${joinNames(names)}`,
          "O'quvchilarning boshqa sinflardagi a'zoligi saqlanadi",
          "Tarif va hisob-faktura summasiga ta'sir qilmaydi",
        ],
        warnings,
      },
      fingerprint: {
        sourceClassId: sourceId,
        targetClassId: targetId,
        studentIds,
        sourceCount: source.students.length,
        targetCount: target.students.length,
        alreadyInTarget,
        targetActive: target.isActive,
      },
    };
  },
  // Mirrors POST /api/classes/:id/students/move — class.routes.js:36 (validateObjectId → classes.transfer) →
  // class.controller.moveStudentsToClass:86-99 `moveStudentsToClass(req.params.id, studentIds, targetClassId)`.
  async execute(params) {
    const result = await classService.moveStudentsToClass(
      params.sourceClassId,
      params.studentIds,
      params.targetClassId,
    );
    return {
      summary: `${params.studentIds.length} ta o'quvchi boshqa sinfga ko'chirildi`,
      details: [{ label: "Maqsad sinfga qo'shildi", value: String(result.modified) }],
      data: result,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 9. O'qituvchi fanlari
// ─────────────────────────────────────────────────────────────────────────

const setTeacherSubjects = defineAction({
  type: "people.set_teacher_subjects",
  toolName: "propose_set_teacher_subjects",
  toolset: "people",
  title: "Xodim fanlarini belgilash",
  risk: "medium",
  permission: "users.update",
  description:
    "Propose REPLACING the full list of subjects a staff member can teach (subjectIds is the complete new list; empty removes all). This is teacher competence used by the lesson planner in the current branch; it does not change the active timetable. Planner loads entered for removed subjects are hidden until the subject is linked again. Not for students.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["userId", "subjectIds"],
    properties: {
      userId: idSchema("Staff member id from search_people."),
      subjectIds: {
        type: "array",
        maxItems: 30,
        items: { type: "string", pattern: "^[a-fA-F0-9]{24}$" },
        description: "Complete new list of subject ids (from people_subjects).",
      },
    },
  },
  async prepare(args, ctx) {
    const user = await loadTarget(args.userId);
    if (user.role === ROLES.STUDENT) {
      throw new AiToolError("Fan faqat xodimga biriktiriladi. O'quvchi sinflari uchun propose_set_student_classes ishlating");
    }
    const homeWarning = await assertHomeBranch(user.id, ctx);

    const subjectIds = sortedIds(args.subjectIds);
    const subjects = await subjectService.getAllSubjects();
    const byId = new Map(subjects.map((s) => [s.id, s]));
    const missing = subjectIds.filter((id) => !byId.has(id));
    if (missing.length > 0) throw new AiToolError(`Fan topilmadi: ${missing.join(", ")}`);

    const currentIds = sortedIds((user.subjects || []).map((s) => s.id));
    if (sameIdSet(currentIds, subjectIds)) {
      throw new AiToolError("O'zgarish yo'q: xodimga aynan shu fanlar biriktirilgan");
    }

    const nameOf = (id) => byId.get(id)?.name ?? id;
    const removed = currentIds.filter((id) => !subjectIds.includes(id));
    const hiddenLoads = removed.length
      ? await prisma.plannerLoad.count({ where: { teacherId: user.id, subjectId: { in: removed } } })
      : 0;

    const warnings = homeWarning ? [homeWarning] : [];
    if (hiddenLoads > 0) {
      warnings.push(
        `Olib tashlanayotgan fanlar bo'yicha rejalashtiruvchida ${hiddenLoads} ta yuklama bor — ular fan qaytarilgunicha hisobga olinmaydi`,
      );
    }
    const inactive = subjectIds.filter((id) => byId.get(id)?.isActive === false).map(nameOf);
    if (inactive.length > 0) warnings.push(`Faol bo'lmagan fan: ${inactive.join(", ")}`);

    return {
      params: { userId: user.id, subjectIds },
      preview: {
        summary: `${personName(user)} fanlari: ${joinNames(subjectIds.map(nameOf))}`,
        target: targetLabel(user),
        fields: [
          { label: "Fanlar", before: joinNames(currentIds.map(nameOf)), after: joinNames(subjectIds.map(nameOf)) },
        ],
        effects: [
          `Faqat "${ctx.branch.name}" filialida — boshqa filiallardagi fanlarga tegilmaydi`,
          "Dars jadvali rejalashtiruvchisi shu ro'yxatdan foydalanadi; amaldagi jadval o'zgarmaydi",
        ],
        warnings,
      },
      fingerprint: { userId: user.id, currentIds, subjectIds, hiddenLoads },
    };
  },
  // Mirrors PUT /api/users/:id — user.routes.js:95 → user.controller.updateUser:125-133
  // `updateUser(req.params.id, { subjects })`.
  async execute(params, ctx) {
    await assertHomeBranch(params.userId, ctx);
    await mirrorUserScope(params.userId, ctx);
    const user = await userService.updateUser(params.userId, { subjects: params.subjectIds });
    return {
      summary: `${personName(user)} fanlari yangilandi: ${joinNames((user.subjects || []).map((s) => s.name))}`,
      data: { userId: user.id, subjectIds: (user.subjects || []).map((s) => s.id) },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────
// 10-11. Sinf va fan yaratish
// ─────────────────────────────────────────────────────────────────────────

/**
 * Nom bandligi. `Class.name` / `Subject.name` — `@unique`, lekin servis
 * P2002 ni ushlamaydi va takror nom 500 bo'lib qaytardi (people.md H7).
 * Aynan teng nom — rad; faqat yozilishi farq qiladigan ("5-A" / "5 a") —
 * ogohlantirish: ular haqiqatan ham boshqa sinf bo'lishi mumkin.
 */
function checkNameAvailability(kind, name, rows, noun) {
  const exact = rows.find((row) => row.name === name);
  if (exact) throw new AiToolError(`"${name}" nomli ${noun} allaqachon mavjud`);
  const { candidates } = findCandidates(kind, name, rows);
  const similar = candidates.map((id) => rows.find((row) => row.id === id)?.name).filter(Boolean);
  return similar.length > 0 ? [`O'xshash nomli ${noun} bor: ${similar.join(", ")} — takror emasligini tekshiring`] : [];
}

const createClass = defineAction({
  type: "people.create_class",
  toolName: "propose_create_class",
  toolset: "people",
  title: "Yangi sinf yaratish",
  risk: "low",
  permission: "classes.create",
  description:
    "Propose creating a new class (e.g. '5-C') in the current branch. The name must be unique; similar existing names are flagged. The class starts empty; add students with propose_set_student_classes or propose_move_students_to_class.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 50, pattern: SAFE_TEXT_PATTERN, description: "Class name exactly as it should appear, e.g. '5-C' (no < or > characters)." },
    },
  },
  async prepare(args, ctx) {
    const name = args.name.replace(/\s+/g, " ");
    const classes = await classService.getAllClasses();
    const warnings = checkNameAvailability("class", name, classes, "sinf");
    return {
      params: { name },
      preview: {
        summary: `"${name}" sinfi yaratiladi`,
        target: `Sinf — ${ctx.branch.name}`,
        fields: [{ label: "Sinf nomi", before: "—", after: name }],
        effects: ["Sinf bo'sh holda yaratiladi", `Hozir filialda ${classes.length} ta sinf bor`],
        warnings,
      },
      fingerprint: { name, existing: classes.map((c) => c.name).sort() },
    };
  },
  // Mirrors POST /api/classes — class.routes.js:29 (classes.create) →
  // class.controller.createClass:26-35 `createClass(req.body.name, req.user.id)`.
  async execute(params, ctx) {
    try {
      const created = await classService.createClass(params.name, ctx.user.id);
      return { summary: `"${created.name}" sinfi yaratildi`, data: { classId: created.id, name: created.name } };
    } catch (error) {
      return rethrowUnique(error, `"${params.name}" nomli sinf allaqachon mavjud`);
    }
  },
});

const createSubject = defineAction({
  type: "people.create_subject",
  toolName: "propose_create_subject",
  toolset: "people",
  title: "Yangi fan yaratish",
  risk: "low",
  permission: "subjects.create",
  description:
    "Propose creating a new subject (e.g. 'Informatika') with an optional description in the current branch. The name must be unique; similar existing names (spelling variants) are flagged. Link teachers afterwards with propose_set_teacher_subjects.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80, pattern: SAFE_TEXT_PATTERN, description: "Subject name exactly as it should appear (no < or > characters)." },
      description: { type: "string", maxLength: 500, pattern: SAFE_TEXT_PATTERN, description: "Optional short description (no < or > characters)." },
    },
  },
  async prepare(args, ctx) {
    const name = args.name.replace(/\s+/g, " ");
    const subjects = await subjectService.getAllSubjects();
    const warnings = checkNameAvailability("subject", name, subjects, "fan");
    const fields = [{ label: "Fan nomi", before: "—", after: name }];
    if (args.description) fields.push({ label: "Tavsif", before: "—", after: args.description });
    return {
      params: { name, description: args.description ?? null },
      preview: {
        summary: `"${name}" fani yaratiladi`,
        target: `Fan — ${ctx.branch.name}`,
        fields,
        effects: ["Fan hech bir xodimga biriktirilmagan holda yaratiladi"],
        warnings,
      },
      fingerprint: { name, description: args.description ?? null, existing: subjects.map((s) => s.name).sort() },
    };
  },
  // Mirrors POST /api/subjects — subject.routes.js:22 (subjects.create) →
  // subject.controller.createSubject:16-24 `createSubject(req.body, req.user.id)`.
  async execute(params, ctx) {
    try {
      const created = await subjectService.createSubject(
        { name: params.name, description: params.description ?? undefined },
        ctx.user.id,
      );
      return { summary: `"${created.name}" fani yaratildi`, data: { subjectId: created.id, name: created.name } };
    } catch (error) {
      return rethrowUnique(error, `"${params.name}" nomli fan allaqachon mavjud`);
    }
  },
});

module.exports = [
  updateProfile,
  updatePhone,
  setLoginActive,
  archivePerson,
  restorePerson,
  changePermissions,
  setStudentClasses,
  moveStudents,
  setTeacherSubjects,
  createClass,
  createSubject,
];
