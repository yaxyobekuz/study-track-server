/**
 * FILIALLARARO KO'CHIRISH — KATALOG MOSLASHTIRGICH.
 *
 * Baho, davomat va dars jadvali `subjectId` / `classId` / `accountId` ga
 * ishora qiladi, bu kataloglar esa HAR FILIALNING O'ZINIKI (`Subject.name`
 * va `Class.name` — filial ichida yagona). Shuning uchun tarix ko'chganda
 * identifikatorlar emas, NOMLAR moslanadi.
 *
 * ⚠️ TAXMIN QILINMAYDI. Moslash faqat AYNAN TENG nom bo'yicha
 * (`scheduleSheet` moslash doktrinasi: "Familiya I" yoki kirill/lotin
 * almashuvi — taklif, avtomatik emas). Nom topilmasa qator JIMGINA
 * tashlanmaydi: yo maqsadda shu nomli katalog qatori OCHILADI, yo reja
 * buni ochiq aytadi.
 *
 * ⚠️ Hammasi CHAQIRUVCHINING tranzaksiyasida va faqat xom SQL bilan:
 * Prisma model API'si bitta schema'ga bog'langan (`crossSchema.helpers.js`).
 */

const { generateId } = require("../utils/idGenerator");
const { qualified } = require("../helpers/crossSchema.helpers");

/** Nomni taqqoslash kaliti — ortiqcha bo'shliq va registr farqi hisob emas. */
const nameKey = (name) => String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * FANLAR: manba `subject_id` → maqsad `subject_id`.
 *
 * Maqsadda shu nomli fan bo'lmasa — OCHILADI. Fan katalogi "ochiq" tushuncha
 * (o'qituvchilar unga biriktiriladi, lekin fanning o'zi narx yoki huquq
 * bermaydi), shuning uchun uni ochish xavfsiz; ochilmasa esa baho umuman
 * ko'chmay, o'quvchining tarixi yo'qolardi.
 *
 * @param {object} db - filiallararo tranzaksiya
 * @param {object} ctx - `branchTransfer.service.js` → `buildContext`
 * @param {string[]} sourceSubjectIds
 * @returns {Promise<{map: Map<string, string>, created: string[]}>} created — yangi ochilgan fan nomlari
 */
const mapSubjects = async (db, ctx, sourceSubjectIds) => {
  const ids = [...new Set(sourceSubjectIds.filter(Boolean))];
  const map = new Map();
  const created = [];
  if (ids.length === 0) return { map, created };

  const src = await db.$queryRawUnsafe(
    `SELECT id, name, description FROM ${qualified(ctx.source.schemaName, "subjects")}
     WHERE id = ANY($1::text[])`,
    ids,
  );
  if (src.length === 0) return { map, created };

  const tgt = await db.$queryRawUnsafe(
    `SELECT id, name FROM ${qualified(ctx.target.schemaName, "subjects")}`,
  );
  const byName = new Map(tgt.map((row) => [nameKey(row.name), row.id]));

  for (const subject of src) {
    const existing = byName.get(nameKey(subject.name));
    if (existing) {
      map.set(subject.id, existing);
      continue;
    }
    const id = generateId();
    await db.$executeRawUnsafe(
      `INSERT INTO ${qualified(ctx.target.schemaName, "subjects")}
         (id, name, description, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, true, $4, NOW(), NOW())`,
      id,
      subject.name,
      subject.description ?? null,
      ctx.actor.id,
    );
    // Keshga ham qo'shiladi: bitta ko'chirishda ikkita manba fani bir xil
    // nomga ega bo'lsa (registr farqi bilan) ikkinchi marta ochilmasin
    byName.set(nameKey(subject.name), id);
    map.set(subject.id, id);
    created.push(subject.name);
  }

  return { map, created };
};

/**
 * SINFLAR: manba `class_id` → maqsad `class_id`.
 *
 * Maqsadda shu nomli sinf bo'lmasa — ochiladi. `active: false` bo'lsa sinf
 * NOFAOL ochiladi: u faqat ko'chgan tarixni (baho, davomat) ushlab turadi,
 * joriy sinflar ro'yxatiga, jurnalga va hisobotlarga kirmaydi. Sinfning
 * O'ZI ko'chirilayotgan bo'lsa (`branchTransfer` → sinf oqimi) chaqiruvchi
 * sinfni o'zi FAOL qilib ochadi va bu yerga tayyor moslama beradi.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} sourceClassIds
 * @param {object} [options]
 * @param {boolean} [options.active=false] - yangi ochiladigan sinf faolmi
 * @param {Map<string, string>} [options.known] - oldindan ma'lum moslama
 * @returns {Promise<{map: Map<string, string>, created: string[]}>}
 */
const mapClasses = async (db, ctx, sourceClassIds, options = {}) => {
  const known = options.known ?? new Map();
  const ids = [...new Set(sourceClassIds.filter(Boolean))];
  const map = new Map(known);
  const created = [];
  const missing = ids.filter((id) => !map.has(id));
  if (missing.length === 0) return { map, created };

  const src = await db.$queryRawUnsafe(
    `SELECT id, name, capacity FROM ${qualified(ctx.source.schemaName, "classes")}
     WHERE id = ANY($1::text[])`,
    missing,
  );
  if (src.length === 0) return { map, created };

  const tgt = await db.$queryRawUnsafe(
    `SELECT id, name FROM ${qualified(ctx.target.schemaName, "classes")}`,
  );
  const byName = new Map(tgt.map((row) => [nameKey(row.name), row.id]));

  for (const klass of src) {
    const existing = byName.get(nameKey(klass.name));
    if (existing) {
      map.set(klass.id, existing);
      continue;
    }
    const id = generateId();
    await db.$executeRawUnsafe(
      `INSERT INTO ${qualified(ctx.target.schemaName, "classes")}
         (id, name, capacity, is_active, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      id,
      klass.name,
      klass.capacity ?? null,
      Boolean(options.active),
      ctx.actor.id,
    );
    byName.set(nameKey(klass.name), id);
    map.set(klass.id, id);
    created.push(klass.name);
  }

  return { map, created };
};

/**
 * XODIMLAR: manba `user_id` → maqsad `user_id`, lekin FAQAT maqsad filialda
 * HAQIQATAN mavjud va arxivlanmagan bo'lsa.
 *
 * ⚠️ Xodim NOMI bo'yicha moslanmaydi va yangi xodim OCHILMAYDI: xodim —
 * login, ruxsat va oylik egasi; uni tarix ko'chirish yo'li bilan ikkinchi
 * filialda "paydo qilish" jim huquq berish bo'lardi. Mos kelmagan xodim
 * uchun chaqiruvchi o'z qarorini qabul qiladi (dars jadvalida katak bo'sh
 * qoladi, bahoda esa `teacher_id` manbadagicha qoladi — baho baribir
 * oylikka ta'sir qilmaydi, `transferred_from_branch_id`).
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} userIds
 * @returns {Promise<Set<string>>} maqsadda mavjud (ishlatsa bo'ladigan) id'lar
 */
const presentStaff = async (db, ctx, userIds) => {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRawUnsafe(
    `SELECT id FROM ${qualified(ctx.target.schemaName, "users")}
     WHERE id = ANY($1::text[]) AND is_archived = false AND role <> 'student'`,
    ids,
  );
  return new Set(rows.map((row) => row.id));
};

/**
 * TO'LOV TURI (kassa): manba hisob → maqsad hisob.
 *
 * Pul manba filialning qaysi kassasidan chiqqan bo'lsa, maqsadda AYNI
 * NOMLI kassaga kiradi ("Naqd" → "Naqd"). Shu nomli kassa bo'lmasa —
 * maqsadning birinchi FAOL kassasi (`sortOrder`, keyin nom). Kassa
 * OCHILMAYDI: u moliyaviy ob'ekt, uni ko'chirish yo'li bilan tug'dirish
 * hisobotda sababsiz yangi qator paydo qilardi.
 *
 * @param {object} db
 * @param {object} ctx
 * @param {string[]} sourceAccountIds
 * @returns {Promise<{map: Map<string, string>, fallback: object|null}>}
 */
const mapPaymentAccounts = async (db, ctx, sourceAccountIds) => {
  const ids = [...new Set(sourceAccountIds.filter(Boolean))];
  const map = new Map();

  const targets = await db.$queryRawUnsafe(
    `SELECT id, name, is_active AS "isActive", is_archived AS "isArchived", sort_order AS "sortOrder"
     FROM ${qualified(ctx.target.schemaName, "payment_accounts")}
     ORDER BY sort_order ASC, name ASC`,
  );
  const usable = targets.filter((row) => row.isActive && !row.isArchived);
  const fallback = usable[0] ?? null;
  if (ids.length === 0) return { map, fallback };

  const sources = await db.$queryRawUnsafe(
    `SELECT id, name FROM ${qualified(ctx.source.schemaName, "payment_accounts")}
     WHERE id = ANY($1::text[])`,
    ids,
  );
  const byName = new Map(usable.map((row) => [nameKey(row.name), row.id]));

  for (const account of sources) {
    const match = byName.get(nameKey(account.name));
    if (match) map.set(account.id, match);
    else if (fallback) map.set(account.id, fallback.id);
  }

  return { map, fallback };
};

module.exports = {
  nameKey,
  mapSubjects,
  mapClasses,
  presentStaff,
  mapPaymentAccounts,
};
