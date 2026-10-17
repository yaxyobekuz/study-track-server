/**
 * UMUMIY KO'RINISH — SO'ROVNI FILIALLAR BO'YLAB YUBORUVCHI (dispatcher).
 *
 * Tizim egasi "Umumiy" ni tanlaganda tokenga `scope: "all"` yoziladi
 * (`utils/jwt.js`). Shundan keyin HAR SO'ROV shu middleware'dan o'tadi va
 * uchta yo'ldan birini oladi:
 *
 *   GET  →  AYNI so'rov HAR FILIALDA alohida bajariladi, javoblar
 *           birlashtiriladi (`helpers/aggregateMerge.helpers.js`)
 *   yozuv → AYNAN BITTA filialda bajariladi (qator qaysi filialda bo'lsa)
 *   `anchor` yo'llar → uy filialida, javob O'ZGARTIRILMASDAN qaytadi
 *
 * ⚠️ NIMA UCHUN SO'ROV QAYTA YUBORILADI, SQL EMAS: har filial o'z
 * schema'sida, o'z sozlamalari va o'z katalogi bilan yashaydi. Agar
 * birlashtirish SQL darajasida (`UNION ALL`) qilinsa, servislardagi butun
 * biznes mantiq — sozlama singletonlari, xom SQL hisobotlar, ruxsat
 * tekshiruvlari — bitta filialning qiymatlari bilan ishlab ketardi.
 * So'rovni qayta yuborish esa HAR FILIALDA mantiqni O'ZGARTIRMASDAN
 * bajaradi: natija "owner har filialga kirib, bir xil ekranni ochib,
 * natijalarni qo'lda yozib chiqqani" bilan AYNAN bir xil bo'ladi.
 *
 * ⚠️ FILIAL KONTEKSTI HAR DOIM HAQIQIY. Umumiy rejimda ham har bir ichki
 * so'rov `runWithBranch(<haqiqiy filial>)` ichida bajariladi, ya'ni
 * "qaysi filialga yozildi" degan noaniqlik TUG'ILMAYDI — `config/prisma.js`
 * doktrinasi buzilmaydi. O'qish paytida yozadigan yo'llar (masalan dars
 * mavzusi ankori) ham o'z filialiga to'g'ri yozadi.
 *
 * ⚠️ FAN-OUT FAQAT GET/HEAD uchun. Yozuvni "hamma filialga" yuborish yo'li
 * YO'Q: u bir amalni N marta bajarardi va yarmi yiqilsa holat
 * tiklanmaydigan bo'lardi.
 */

const { verifyToken, isAggregateToken } = require("../utils/jwt");
const { mapBranches } = require("../helpers/branchIterator");
const { runWithBranch } = require("../config/branchContext");
const aggregateScope = require("../services/aggregateScope.service");
const registry = require("../services/aggregateRoute.registry");
const merge = require("../helpers/aggregateMerge.helpers");
const { ConflictError } = require("../utils/errors");
const { PAGINATION_DEFAULTS } = require("../utils/constants");
const logger = require("../utils/logger");

/**
 * Bitta filialdan olinadigan eng ko'p qator soni.
 *
 * Birlashtirilgan sahifa aniq bo'lishi uchun har filialdan `page × limit`
 * tagacha BIRINCHI qatorlar olinadi. Bu son cheklanmasa 100-sahifaga o'tish
 * har filialdan minglab qator tortib, xotirani filial soniga ko'paytirardi.
 * Chegaradan oshsa — toza xato: odam filtrdan foydalanadi (va aslida
 * 40-sahifani varaqlash emas, qidirish kerak).
 */
const ROW_CAP = 1000;

/** Bitta filialning javobini kutish muhlati. */
const BRANCH_TIMEOUT_MS = 25_000;

/* ────────────────────────── ICHKI SO'ROV / JAVOB ────────────────────────── */

/**
 * Ichki so'rov — asl `req` ning PROTOTIP NUSXASI.
 *
 * ⚠️ Nusxa ATAYLAB `Object.create` bilan: Express router yo'nalishni
 * aniqlaganda `req.url`, `req.params`, `req.baseUrl` ni O'ZGARTIRADI. Asl
 * `req` ga yozilsa, keyingi filialning so'rovi allaqachon "ishlatilgan"
 * yo'l bilan ketardi. Nusxada esa bu yozuvlar o'z (own) maydon bo'lib
 * qoladi, asl so'rov esa tegilmaydi.
 *
 * @param {object} req
 * @param {object} branch - haqiqiy filial qatori
 * @param {object} scope - `{branches, anchor}`
 * @param {object|null} query - qayta yozilgan query (sahifalash uchun)
 * @returns {object}
 */
const createSubRequest = (req, branch, scope, query = null) => {
  const sub = Object.create(req);
  // `auth.middleware.protect` AYNAN shu maydonga qarab filialni oladi.
  sub.aggregateBranch = branch;
  sub.aggregateScope = scope;
  if (query) sub.query = query;
  return sub;
};

/**
 * Javobni USHLAB OLADIGAN soxta `res`.
 *
 * Controllerlarning 95% i `res.json()` / `res.status().json()` ishlatadi
 * (loyihada 800 dan ortiq joy), shuning uchun shu ikkisi to'liq
 * qo'llab-quvvatlanadi. Qolgan HAMMA narsa (`res.write`, `res.download`,
 * `res.sendFile`, `res.on`...) ATAYLAB qo'llab-quvvatlanmaydi va aniq xato
 * beradi: ikkilik faylni yoki SSE oqimini "birlashtirish" degan narsa yo'q,
 * jim ravishda bitta filialning javobini berish esa yolg'on bo'lardi.
 *
 * @returns {{res: object, state: object}}
 */
const createCapture = (onFinish) => {
  const state = {
    status: 200,
    body: undefined,
    finished: false,
    unsupported: null,
  };

  // ⚠️ Javob tugagani CALLBACK bilan bildiriladi, "tugadimi?" deb aylanib
  // tekshirish bilan EMAS: `setImmediate` aylanishi so'rov davomida minglab
  // bo'sh tik yasab, event loop'ni bekorga band qilardi.
  const finish = () => {
    if (state.finished) return;
    state.finished = true;
    onFinish(state);
  };

  const target = {
    locals: {},
    headersSent: false,
    statusCode: 200,
    status(code) {
      state.status = code;
      target.statusCode = code;
      return proxy;
    },
    sendStatus(code) {
      state.status = code;
      finish();
      return proxy;
    },
    json(body) {
      state.body = body;
      finish();
      return proxy;
    },
    send(body) {
      // Matn / Buffer javob birlashtirilmaydi — faqat JSON.
      if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
        return target.json(body);
      }
      state.unsupported = "send";
      finish();
      return proxy;
    },
    set() {
      return proxy;
    },
    header() {
      return proxy;
    },
    setHeader() {
      return proxy;
    },
    getHeader() {
      return undefined;
    },
    type() {
      return proxy;
    },
    vary() {
      return proxy;
    },
    end() {
      finish();
      return proxy;
    },
  };

  const proxy = new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      // Qo'llab-quvvatlanmaydigan usul — chaqirilsa aniq xato beradi.
      return (...args) => {
        state.unsupported = String(prop);
        logger.warn(
          `[Aggregate] res.${String(prop)}() umumiy ko'rinishda qo'llanmaydi (${args.length} arg)`,
        );
        finish();
        return proxy;
      };
    },
  });

  return { res: proxy, state };
};

/**
 * Bitta filialda so'rovni bajarib, javobni ushlab oladi.
 *
 * @returns {Promise<{status: number, body: any, unsupported: string|null, noRoute?: boolean}>}
 */
const dispatchCaptured = (router, req, branch, scope, query) =>
  new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new Error(
          `"${branch.name}" filiali ${BRANCH_TIMEOUT_MS} ms ichida javob bermadi`,
        ),
      );
    }, BRANCH_TIMEOUT_MS);

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const { res } = createCapture((finalState) =>
      settle({
        status: finalState.status,
        body: finalState.body,
        unsupported: finalState.unsupported,
      }),
    );

    // Router hech qanday yo'nalish topmasa — yoki `next(err)` chaqirilsa —
    // shu callback ishlaydi: javob YOZILMAGAN holat.
    const done = (error) => {
      if (error) return fail(error);
      settle({ status: 404, body: null, unsupported: null, noRoute: true });
    };

    try {
      router(createSubRequest(req, branch, scope, query), res, done);
    } catch (error) {
      fail(error);
    }
  });


/* ──────────────────────────── YORDAMCHILAR ──────────────────────────── */

const branchLabel = (branch) => aggregateScope.publicBranch(branch);

const headerValue = (value) => encodeURIComponent(String(value ?? ""));

/** Javobga umumiy rejim belgisini qo'yadi (tanani o'zgartirmasdan). */
const markResponse = (res, mode, branch) => {
  res.setHeader("X-Aggregate-Mode", mode);
  if (branch) res.setHeader("X-Aggregate-Branch", headerValue(branch.name));
};

/**
 * Sahifalashni qayta yozadi: har filialdan `page × limit` tagacha birinchi
 * qatorlar olinadi (tushuntirish — `ROW_CAP` izohida).
 *
 * @returns {{query: object|null, page: number|null, limit: number|null}}
 */
const rewritePagination = (query) => {
  const rawPage = Number.parseInt(query.page, 10);
  const rawLimit = Number.parseInt(query.limit, 10);

  // Mijoz sahifani ko'rsatmagan bo'lsa tegilmaydi: endpoint o'z sukutini
  // ishlatadi va birlashtirish o'sha sukutga qarab qirqadi.
  if (!Number.isFinite(rawPage) && !Number.isFinite(rawLimit)) {
    return { query: null, page: null, limit: null };
  }

  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : PAGINATION_DEFAULTS.PAGE;
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : PAGINATION_DEFAULTS.LIMIT;

  const need = page * limit;
  if (need > ROW_CAP) {
    throw aggregateScope.withReason(
      new ConflictError(
        "Umumiy ko'rinishda bunchalik chuqur sahifaga o'tib bo'lmaydi — qidiruv yoki filtrdan foydalaning",
      ),
      { reason: "aggregate_page_too_deep", maxRows: ROW_CAP },
    );
  }

  if (page === 1) return { query: null, page, limit };

  return {
    query: { ...query, page: "1", limit: String(need) },
    page,
    limit,
  };
};

/* ───────────────────────────── FAN-OUT ───────────────────────────── */

/**
 * GET so'rovini filiallar bo'ylab bajaradi va javoblarni birlashtiradi.
 */
const fanOut = async ({ router, req, res, next, scope, rule }) => {
  const { query, page, limit } = rewritePagination(req.query ?? {});

  const results = await mapBranches(
    (branch) => dispatchCaptured(router, req, branch, scope, query),
    { branches: scope.branches, label: "[Aggregate]" },
  );

  const failed = [];
  const ok = [];
  const notFound = [];

  for (const row of results) {
    if (row.error) {
      failed.push({ branch: row.branch, error: row.error });
      continue;
    }

    const { status, body, unsupported, noRoute } = row.value;

    if (noRoute) {
      notFound.push({ branch: row.branch, routeMissing: true });
      continue;
    }

    if (unsupported) {
      return next(
        aggregateScope.withReason(
          new ConflictError(
            "Bu ma'lumot umumiy ko'rinishda birlashtirilmaydi — filialni tanlang",
          ),
          { reason: "aggregate_unsupported", detail: `res.${unsupported}` },
        ),
      );
    }

    if (status >= 200 && status < 300) ok.push({ branch: row.branch, body });
    else if (status === 404) notFound.push({ branch: row.branch, body, status });
    else failed.push({ branch: row.branch, body, status });
  }

  // Birorta filialda yo'nalish topilmadi va boshqa natija ham yo'q —
  // asl `notFound` ishlovchisiga beramiz (yo'l umuman mavjud emas).
  if (!ok.length && !failed.length && notFound.every((r) => r.routeMissing)) {
    return next();
  }

  if (!ok.length) {
    // Hammasi yiqilgan yoki hammasi 404 — asl javobni O'ZGARTIRMASDAN
    // qaytaramiz: "topilmadi" ham, "ruxsat yo'q" ham mazmunli javob.
    if (failed.length) {
      const first = failed[0];
      if (first.error) return next(first.error);
      markResponse(res, "merge");
      return res.status(first.status).json(first.body);
    }

    const first = notFound.find((r) => r.body) ?? notFound[0];
    markResponse(res, "merge");
    return res.status(404).json(
      first?.body ?? { success: false, message: "Ma'lumot topilmadi" },
    );
  }

  // ── BIR XIL JAVOB: platforma ma'lumoti (katalog, sozlama) ──────────
  // Registrda belgilanmagan platforma yo'llari uchun zaxira qavat: javoblar
  // aynan teng bo'lsa birlashtirishga narsa yo'q, o'zi qaytadi.
  if (
    ok.length > 1 &&
    ok.every(({ body }) => merge.deepEqual(body, ok[0].body))
  ) {
    markResponse(res, "identical");
    return res.status(200).json(ok[0].body);
  }

  const meta = {
    branches: ok.map(({ branch }) => branchLabel(branch)),
  };
  if (failed.length) {
    meta.failed = failed.map(({ branch, status, error }) => ({
      branch: branchLabel(branch),
      status: status ?? 500,
      message: error?.message ?? "Ma'lumot olinmadi",
    }));
  }

  // ── BITTA FILIALDAN TOPILGAN YOZUV (detal sahifasi) ────────────────
  if (ok.length === 1 && !Array.isArray(ok[0].body?.data)) {
    const { branch, body } = ok[0];
    const data = merge.isPlainObject(body.data)
      ? merge.tagRow(body.data, branchLabel(branch))
      : body.data;

    markResponse(res, "single", branch);
    return res.status(200).json({ ...body, data, meta: { aggregate: { ...meta, mode: "single" } } });
  }

  const labelled = ok.map(({ branch, body }) => ({
    branch: branchLabel(branch),
    body,
  }));

  // Registrda "tegilmasin" deb belgilangan maydonlar (sozlama qiymatlari).
  const keep = rule.keep ? new Set(rule.keep) : undefined;

  // ── RO'YXAT ────────────────────────────────────────────────────────
  if (rule.mode === "list" || labelled.every(({ body }) => Array.isArray(body?.data))) {
    const merged = merge.mergeList(labelled, { page, limit, sort: rule.sort, keep });

    markResponse(res, "merge");
    return res.status(200).json({
      success: true,
      data: merged.data,
      ...(merged.pagination ? { pagination: merged.pagination } : {}),
      ...merged.extras,
      meta: {
        aggregate: {
          ...meta,
          mode: "list",
          ...merge.notesToMeta(merged.notes),
        },
      },
    });
  }

  // ── OBYEKT (sanoqchilar, kartalar, hisobot bloklari) ───────────────
  //
  // ⚠️ SUKUT BO'YICHA BIRLASHTIRILADI (2026-10-17): ilgari obyekt javob
  // registrda e'lon qilinmagan bo'lsa 409 qaytardi va ekrandagi sanoq
  // kartalari "—" bo'lib turardi. Bu "ehtiyotkorlik" amalda zarar qilardi:
  // odam umumiy ko'rinishni aynan shu raqamlar uchun ochadi.
  //
  // Birlashtirish QOIDALARI bilan xavfsiz (`aggregateMerge.helpers.js`):
  // sanoqchi qo'shiladi, foiz o'rtachalanadi, sozlama va davr qiymati
  // (`dueSoonHours`, `month`) QO'SHILMAYDI, bir xil kalitli qatorlar esa
  // guruhlanadi. Nima qilinganini `meta.aggregate` ochiq aytadi.
  if (labelled.every(({ body }) => merge.isPlainObject(body))) {
    const merged = merge.mergeObject(labelled, { keep });

    markResponse(res, "merge");
    return res.status(200).json({
      success: true,
      data: merged.data,
      ...merged.extras,
      meta: {
        aggregate: {
          ...meta,
          mode: "object",
          ...merge.notesToMeta(merged.notes),
        },
      },
    });
  }

  // ── BIRLASHTIRILMAYDI ──────────────────────────────────────────────
  // Bu yerga faqat JSON bo'lmagan (matn/ikkilik) javob tushadi.
  return next(
    aggregateScope.withReason(
      new ConflictError(
        "Bu ma'lumot umumiy ko'rinishda birlashtirilmaydi — filialni tanlang",
      ),
      {
        reason: "aggregate_unsupported",
        branches: meta.branches,
      },
    ),
  );
};

/* ──────────────────────────── DISPATCHER ──────────────────────────── */

/**
 * Umumiy ko'rinish dispatcher'i.
 *
 * ⚠️ ODDIY SO'ROV UCHUN HECH NARSA O'ZGARMAYDI: token `scope` siz bo'lsa
 * router to'g'ridan-to'g'ri chaqiriladi (bitta `if`). Filiallashtirishning
 * mavjud yo'li butunlay tegilmagan qoladi.
 *
 * @param {Function} router - `src/routes/index.js`
 * @returns {Function} Express middleware
 */
const aggregateDispatch = (router) => (req, res, next) => {
  const header = req.headers.authorization;
  const token =
    header && header.startsWith("Bearer") ? header.split(" ")[1] : null;

  const decoded = token ? verifyToken(token) : null;

  // ⚠️ ODDIY YO'L SINXRON QOLADI va bu ataylab: `async` middleware'da
  // router SINXRON xato otsa, u Express'ning xato ishlovchisiga emas,
  // "unhandled rejection" ga aylanardi. Ya'ni umumiy ko'rinish qo'shilgani
  // uchun MAVJUD so'rovlarning xato yo'li o'zgarib ketmasligi kerak.
  if (!decoded || !isAggregateToken(decoded)) {
    return router(req, res, next);
  }

  // Umumiy ko'rinish yo'li asinxron — rad etilgan va'da `next` ga boradi.
  return handleAggregate({ router, req, res, next, decoded }).catch(next);
};

/**
 * Umumiy ko'rinish uchun so'rovni yo'naltiradi.
 *
 * @param {{router: Function, req: object, res: object, next: Function, decoded: object}} params
 */
const handleAggregate = async ({ router, req, res, next, decoded }) => {
  const method = String(req.method).toUpperCase();
  const rule = registry.resolveRule(method, req.path);

  if (rule.mode === "unsupported") {
    return next(
      aggregateScope.withReason(
        new ConflictError(
          rule.reason ??
            "Bu amal umumiy ko'rinishda mavjud emas — filialni tanlang",
        ),
        { reason: "aggregate_unsupported" },
      ),
    );
  }

  let scope;
  try {
    // ⚠️ Rol va filiallar ro'yxati HAR SO'ROVDA qayta o'qiladi
    // (`aggregateScope.service.js` qoida 1 va 2).
    scope = await aggregateScope.resolveScope(decoded);
  } catch (error) {
    return next(error);
  }

  // ── Uy filialida bajariladigan yo'llar ───────────────────────────
  if (rule.mode === "anchor") {
    markResponse(res, "anchor", scope.anchor);
    const sub = createSubRequest(req, scope.anchor, scope);
    return runWithBranch(scope.anchor, () => router(sub, res, next));
  }

  // ── YOZUV: aynan bitta filialda ──────────────────────────────────
  if (method !== "GET" && method !== "HEAD") {
    let target;
    try {
      target = await aggregateScope.resolveWriteBranch({
        branches: scope.branches,
        headerBranchId: req.headers["x-branch-id"],
        locate: rule.locate ? { model: rule.locate.model, param: "id" } : null,
        params: rule.locate ? { id: rule.locate.id } : {},
      });
    } catch (error) {
      return next(error);
    }

    logger.info(
      `[Aggregate] yozuv "${target.name}" filialiga: ${method} ${req.path}`,
    );
    markResponse(res, "write", target);
    const sub = createSubRequest(req, target, scope);
    return runWithBranch(target, () => router(sub, res, next));
  }

  // ── O'QISH: filiallar bo'ylab ────────────────────────────────────
  try {
    return await fanOut({ router, req, res, next, scope, rule });
  } catch (error) {
    return next(error);
  }
};

module.exports = { aggregateDispatch, ROW_CAP, BRANCH_TIMEOUT_MS };
