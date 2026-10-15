const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * LOGIN — FILIALNI TANLASH (ikki yoki undan ortiq filialli xodim).
 *
 * Qabul mezonlari:
 *   - bitta filialli xodimda hech narsa o'zgarmaydi (bitta qadam, token darhol)
 *   - `branchSelect` yubormagan mijoz (MOBIL ILOVA) ham avvalgidek ishlaydi
 *   - ko'p filialli xodimga token BERILMAYDI va SEANS OCHILMAYDI, u filialni
 *     tanlaydi; jurnalga "muvaffaqiyatli kirish" ham yozilmaydi
 *   - tanlovdan keyin seans AYNAN tanlangan filialda ochiladi
 *   - biriktirilmagan filial, muddati o'tgan / boshqa turdagi token, qoldiq
 *     profil va nofaol profil — rad etiladi
 */

process.env.JWT_SECRET = "test-secret-for-branch-select";
process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db?schema=public";

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const HOME = "b".repeat(24);
const OTHER = "c".repeat(24);
const FOREIGN = "d".repeat(24);
const USER_ID = "u".repeat(24);

const branches = {
  [HOME]: { id: HOME, code: "home", name: "Bosh filial", isActive: true, isArchived: false, status: "ready" },
  [OTHER]: { id: OTHER, code: "yun", name: "Yunusobod", isActive: true, isArchived: false, status: "ready" },
  [FOREIGN]: { id: FOREIGN, code: "chl", name: "Chilonzor", isActive: true, isArchived: false, status: "ready" },
};

/** Har filialdagi `User` qatori — kalit `${branchId}:${userId}`. */
const profiles = new Map();
/** `platform.user_branch_access` — qaysi filiallarga biriktirilgan. */
let access = [];
/** Xavfsizlik jurnali va ochilgan seanslar. */
let attempts = [];
let admitted = [];

let currentBranch = null;

fakeModule("../src/config/branchContext", {
  runWithBranch: async (branch, fn) => {
    const before = currentBranch;
    currentBranch = branch;
    try {
      return await fn();
    } finally {
      currentBranch = before;
    }
  },
});

fakeModule("../src/config/prisma", {
  user: {
    findUnique: async ({ where }) =>
      profiles.get(`${currentBranch?.id}:${where.id}`) ?? null,
  },
});

fakeModule("../src/services/branch.service", {
  getUsableById: async (id) => {
    const branch = branches[id];
    if (!branch) throw new Error("Filial topilmadi");
    return branch;
  },
  findById: async (id) => branches[id] ?? null,
  listUsable: async () => Object.values(branches),
});

fakeModule("../src/services/userDirectory.service", {
  findByUsername: async (username) =>
    username === "teacher" ? { id: USER_ID, branchId: HOME } : null,
  findByUserId: async () => ({ id: USER_ID, branchId: HOME }),
  listAccess: async (userId) => access.filter((a) => a.userId === userId),
  findAccess: async (userId, branchId) =>
    access.find((a) => a.userId === userId && a.branchId === branchId) ?? null,
});

class SessionLimitError extends Error {
  constructor(limit) {
    super("limit");
    this.limit = limit;
  }
}

fakeModule("../src/services/security.service", {
  SessionLimitError,
  recordAttempt: (row) => attempts.push(row),
  checkFailedStreak: async () => {},
  admitSession: async (input) => {
    admitted.push(input);
    return { session: { id: "s1" }, previous: [] };
  },
  runSessionRules: async () => {},
  openSession: async () => {},
  closeSession: async () => 0,
});

fakeModule("../src/services/push.service", {
  moveSession: () => {},
  forgetSession: async () => {},
});

fakeModule("../src/services/tutorGroup.service", {
  loadTutorRoleValues: async () => [],
  isTutorUser: () => false,
});

fakeModule("../src/services/settings.service", {
  getOfficeGeofenceSettings: async () => null,
});

fakeModule("../src/utils/password", {
  matchPassword: async (plain, hash) => hash === `hashed:${plain}`,
});

const authService = require("../src/services/auth.service");
const { generateToken, generateBranchSelectToken } = require("../src/utils/jwt");

/** Har testdan oldin tozalanadigan holat. */
const reset = ({ branchIds = [HOME], inactiveIn = [], missingIn = [] } = {}) => {
  profiles.clear();
  attempts = [];
  admitted = [];
  access = branchIds.map((branchId) => ({
    userId: USER_ID,
    branchId,
    role: "teacher",
    isHome: branchId === HOME,
  }));

  for (const branchId of branchIds) {
    if (missingIn.includes(branchId)) continue;
    profiles.set(`${branchId}:${USER_ID}`, {
      id: USER_ID,
      username: "teacher",
      firstName: "Ali",
      lastName: "Valiyev",
      fullName: "Ali Valiyev",
      role: "teacher",
      extraRoles: [],
      permissions: [],
      password: "hashed:secret",
      isActive: !inactiveIn.includes(branchId),
      isArchived: false,
      classes: [],
    });
  }
};

const login = (options) =>
  authService.login("teacher", "secret", { channel: "teacher" }, options);

/* ═══════════════ BITTA FILIAL — HECH NARSA O'ZGARMAYDI ═══════════════ */

test("bitta filialli xodim: branchSelect so'ralsa ham token DARHOL beriladi", async () => {
  reset({ branchIds: [HOME] });

  const res = await login({ branchSelect: true });

  assert.ok(res.token, "token berilishi kerak");
  assert.equal(res.branchSelectionRequired, undefined);
  assert.equal(res.branch.id, HOME);
  assert.equal(admitted.length, 1, "seans ochilishi kerak");
  assert.equal(attempts.filter((a) => a.success).length, 1);
});

/* ═════════ KO'P FILIAL, ESKI MIJOZ (MOBIL) — BUZILMAYDI ═════════ */

test("ko'p filialli xodim: branchSelect YUBORILMASA avvalgidek uy filialiga token", async () => {
  reset({ branchIds: [HOME, OTHER] });

  const res = await login(undefined);

  assert.ok(res.token, "eski mijoz token olishi kerak");
  assert.equal(res.branch.id, HOME, "uy filialiga tushadi");
  assert.equal(res.availableBranches.length, 2);
  assert.equal(admitted.length, 1);
});

/* ═════════════ KO'P FILIAL + BRANCHSELECT — TANLOV ═════════════ */

test("ko'p filialli xodim: token YO'Q, seans OCHILMAYDI, filial so'raladi", async () => {
  reset({ branchIds: [HOME, OTHER] });

  const res = await login({ branchSelect: true });

  assert.equal(res.branchSelectionRequired, true);
  assert.ok(res.selectionToken, "tanlov tokeni berilishi kerak");
  assert.equal(res.token, undefined, "access token BERILMASLIGI kerak");
  assert.equal(res.branches.length, 2);
  assert.deepEqual(
    res.branches.map((b) => b.id).sort(),
    [HOME, OTHER].sort(),
  );
  assert.equal(res.homeBranchId, HOME);
  assert.equal(admitted.length, 0, "SEANS OCHILMASLIGI kerak");
  assert.equal(attempts.length, 0, "yarim qadam jurnalga yozilmaydi");
  // Ruxsat va rol tanlangan filialga bog'liq — bu javobda berilmaydi
  assert.equal(res.user.permissions, undefined);
  assert.equal(res.user.role, undefined);
});

test("noto'g'ri parol: tanlov oynasi ochilmaydi, urinish jurnalga tushadi", async () => {
  reset({ branchIds: [HOME, OTHER] });

  await assert.rejects(
    () => authService.login("teacher", "wrong", {}, { branchSelect: true }),
    /noto'g'ri/i,
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].success, false);
  assert.equal(attempts[0].reason, "bad_password");
});

/* ═══════════════════ IKKINCHI QADAM — TANLOV ═══════════════════ */

const selectWith = (branchId, token) =>
  authService.selectLoginBranch({
    selectionToken: token,
    branchId,
    client: { channel: "teacher" },
  });

test("tanlangan filialda seans ochiladi va token o'sha filialga beriladi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  const res = await selectWith(OTHER, selectionToken);

  assert.ok(res.token);
  assert.equal(res.branch.id, OTHER);
  assert.equal(res.user.branch.id, OTHER);
  assert.equal(admitted.length, 1);
  assert.equal(admitted[0].branchId, OTHER, "seans TANLANGAN filialda");
  assert.equal(admitted[0].enforceLimit, true, "qurilma limiti tekshiriladi");
  assert.equal(attempts.filter((a) => a.success).length, 1);
});

test("uy filialini tanlash ham ishlaydi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  const res = await selectWith(HOME, selectionToken);

  assert.equal(res.branch.id, HOME);
  assert.equal(admitted[0].branchId, HOME);
});

test("biriktirilmagan filial RAD ETILADI va jurnalga yoziladi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  await assert.rejects(() => selectWith(FOREIGN, selectionToken), {
    name: "ForbiddenError",
  });
  assert.equal(admitted.length, 0, "seans ochilmasligi kerak");
  const denied = attempts.find((a) => a.reason === "branch_denied");
  assert.ok(denied, "branch_denied jurnalga tushishi kerak");
  assert.equal(denied.username, "teacher");
  assert.equal(denied.success, false);
});

test("oraliqda biriktirish olib tashlansa tanlov o'tmaydi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  // Token berilgandan keyin admin biriktirishni oldi
  access = access.filter((a) => a.branchId !== OTHER);

  await assert.rejects(() => selectWith(OTHER, selectionToken), {
    name: "ForbiddenError",
  });
  assert.equal(admitted.length, 0);
});

test("filial tanlanmasa aniq xato", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  await assert.rejects(() => selectWith(undefined, selectionToken), {
    name: "BadRequestError",
  });
});

/* ═══════════════════ TOKEN TURLARI VA MUDDAT ═══════════════════ */

test("buzuq yoki yo'q tanlov tokeni: selection_expired", async () => {
  reset({ branchIds: [HOME, OTHER] });

  for (const bad of ["", "abc", undefined, null]) {
    await assert.rejects(
      () => selectWith(OTHER, bad),
      (err) => {
        assert.equal(err.name, "BadRequestError");
        assert.equal(err.details?.reason, "selection_expired");
        return true;
      },
    );
  }
});

test("oddiy ACCESS token tanlov tokeni o'rnida ISHLAMAYDI", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const accessToken = generateToken(USER_ID, HOME, "a".repeat(32));

  await assert.rejects(
    () => selectWith(OTHER, accessToken),
    (err) => {
      assert.equal(err.details?.reason, "selection_expired");
      return true;
    },
  );
  assert.equal(admitted.length, 0);
});

test("muddati o'tgan tanlov tokeni ishlamaydi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const jwt = require("jsonwebtoken");
  const crypto = require("crypto");
  const secret = crypto
    .createHmac("sha256", String(process.env.JWT_SECRET))
    .update("branch-select-token:v1")
    .digest("hex");
  const stale = jwt.sign(
    { purpose: "branch-select", sub: USER_ID, hb: HOME },
    secret,
    { algorithm: "HS256", expiresIn: -10 },
  );

  await assert.rejects(
    () => selectWith(OTHER, stale),
    (err) => {
      assert.equal(err.details?.reason, "selection_expired");
      return true;
    },
  );
});

/* ═════════════════ TANLANGAN FILIALDAGI PROFIL ═════════════════ */

test("tanlangan filialda profil yo'q bo'lsa — aniq xato, token yo'q", async () => {
  reset({ branchIds: [HOME, OTHER], missingIn: [OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  await assert.rejects(() => selectWith(OTHER, selectionToken), {
    name: "NotFoundError",
  });
  assert.equal(admitted.length, 0);
});

test("tanlangan filialdagi profil nofaol bo'lsa rad etiladi", async () => {
  reset({ branchIds: [HOME, OTHER], inactiveIn: [OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  await assert.rejects(() => selectWith(OTHER, selectionToken), {
    name: "ForbiddenError",
  });
  assert.equal(admitted.length, 0);
});

test("QOLDIQ PROFIL kirish yo'li emas: biriktirish profildan OLDIN tekshiriladi", async () => {
  // Filiallararo ko'chirishdan keyingi holat: `FOREIGN` da qator qolgan,
  // lekin biriktirish yo'q (`finance.md` §12)
  reset({ branchIds: [HOME, OTHER] });
  profiles.set(`${FOREIGN}:${USER_ID}`, {
    id: USER_ID,
    username: "teacher",
    role: "teacher",
    extraRoles: [],
    isActive: true,
    isArchived: false,
    classes: [],
  });
  const { selectionToken } = await login({ branchSelect: true });

  await assert.rejects(() => selectWith(FOREIGN, selectionToken), {
    name: "ForbiddenError",
  });
  assert.equal(admitted.length, 0);
});

/* ═══════════════════════ QURILMA LIMITI ═══════════════════════ */

test("qurilma limiti tanlov qadamida ham 409 bilan qaytadi", async () => {
  reset({ branchIds: [HOME, OTHER] });
  const { selectionToken } = await login({ branchSelect: true });

  const security = require("../src/services/security.service");
  const original = security.admitSession;
  security.admitSession = async () => {
    throw new SessionLimitError(4);
  };

  try {
    await assert.rejects(
      () => selectWith(OTHER, selectionToken),
      (err) => {
        assert.equal(err.statusCode, 409);
        assert.equal(err.details?.reason, "session_limit");
        assert.equal(err.details?.limit, 4);
        return true;
      },
    );
    const denied = attempts.find((a) => a.reason === "session_limit");
    assert.ok(denied, "limit urinishi jurnalga tushadi");
    assert.equal(denied.branchId, OTHER);
  } finally {
    security.admitSession = original;
  }
});

/* ═════════════════════════════ OWNER ═════════════════════════════ */

/**
 * ⚠️ OWNER'da biriktirish yozuvi YO'Q va bo'lishi ham shart emas: u har
 * filial schema'sida avtomatik mavjud. Ro'yxat `listUsable` dan chiqadi,
 * ya'ni owner uchun hakam — filialning holati, biriktirish jadvali emas.
 */
const asOwner = () => {
  profiles.clear();
  attempts = [];
  admitted = [];
  access = []; // biriktirish yozuvi YO'Q

  for (const branchId of Object.keys(branches)) {
    profiles.set(`${branchId}:${USER_ID}`, {
      id: USER_ID,
      username: "teacher",
      firstName: "Owner",
      lastName: "Egasi",
      fullName: "Owner Egasi",
      role: "owner",
      extraRoles: [],
      password: "hashed:secret",
      isActive: true,
      isArchived: false,
      classes: [],
    });
  }
};

test("owner: biriktirish yozuvisiz ham HAMMA filial so'raladi", async () => {
  asOwner();

  const res = await login({ branchSelect: true });

  assert.equal(res.branchSelectionRequired, true);
  assert.equal(res.branches.length, 3);
  assert.equal(admitted.length, 0);
});

test("owner: biriktirilmagan filialni tanlay oladi", async () => {
  asOwner();
  const { selectionToken } = await login({ branchSelect: true });

  const res = await selectWith(FOREIGN, selectionToken);

  assert.ok(res.token);
  assert.equal(res.branch.id, FOREIGN);
  assert.equal(admitted[0].branchId, FOREIGN);
  assert.equal(
    attempts.find((a) => a.reason === "branch_denied"),
    undefined,
    "owner rad etilmasligi kerak",
  );
});

test("owner: qo'shimcha rol sifatida ham hisob (rol kaliti qotirilmagan)", async () => {
  asOwner();
  for (const branchId of Object.keys(branches)) {
    const row = profiles.get(`${branchId}:${USER_ID}`);
    profiles.set(`${branchId}:${USER_ID}`, {
      ...row,
      role: "teacher",
      extraRoles: ["owner"],
    });
  }

  const res = await login({ branchSelect: true });
  assert.equal(res.branches.length, 3, "qo'shimcha rol ham owner huquqini beradi");
});
