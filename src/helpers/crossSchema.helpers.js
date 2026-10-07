/**
 * FILIALLARARO SQL — bir schema'dan boshqasiga qator ko'chirish.
 *
 * Barcha filial schema'lari va platforma BITTA PostgreSQL bazasida
 * (`DATABASE_URL` dan `?schema=` bilan ajratiladi). Shuning uchun bitta
 * ulanishdagi tranzaksiya bir vaqtda ikki filialga ham, platformaga ham
 * yoza oladi — schema shunchaki nomlar maydoni. Filiallararo ko'chirish shu
 * xususiyatga tayanadi: yo hammasi o'tadi, yo hech narsa.
 *
 * Prisma model API'si bitta schema'ga bog'langan, shuning uchun bu yerda
 * xom SQL va TO'LIQ nomlar ("schema"."jadval") ishlatiladi. Identifikator
 * parametrlanmaydi — har biri `quoteIdent` dan o'tadi (qat'iy naqsh), qiymat
 * esa doim `$n` parametri.
 *
 * ⚠️ ENUM HAR SCHEMA'DA O'ZINIKI: `public."Gender"` va `br_x."Gender"` —
 * PostgreSQL uchun ikki BOSHQA tur va ular orasida avtomatik o'girish yo'q.
 * Shuning uchun nusxalashda enum ustuni matn orqali MAQSAD turiga aniq
 * o'giriladi (`castExpr`). Busiz `INSERT … SELECT` birinchi enum ustunida
 * yiqilardi.
 *
 * ⚠️ USTUNLAR RO'YXATI BAZADAN O'QILADI va manba bilan maqsadda BIR XIL
 * bo'lishi SHART (`copyRows`). `INSERT … SELECT *` ustun TARTIBIGA tayanardi:
 * migratsiya ikki schema'da boshqa tartibda qo'llangan bo'lsa, qiymat jimgina
 * qo'shni ustunga tushardi.
 */

const { assertSafeSchemaName } = require("./schemaUrl.helpers");
const { ConflictError } = require("../utils/errors");

const IDENT_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
// Enum tur nomlari Prisma'da PascalCase ("StudentEnrollmentEndReason")
const TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Identifikatorni tekshirib, qo'shtirnoqqa oladi.
 * @param {string} name
 * @returns {string}
 */
const quoteIdent = (name) => {
  if (typeof name !== "string" || !IDENT_PATTERN.test(name)) {
    throw new Error(`Noto'g'ri SQL identifikatori: ${name}`);
  }
  return `"${name}"`;
};

/** "schema"."jadval" */
const qualified = (schema, table) =>
  `${quoteIdent(assertSafeSchemaName(schema))}.${quoteIdent(table)}`;

/**
 * Schema'ning o'z turi (enum) — `::"schema"."Tur"`.
 * @param {string} schema
 * @param {string} typeName
 * @returns {string}
 */
const schemaType = (schema, typeName) => {
  if (typeof typeName !== "string" || !TYPE_PATTERN.test(typeName)) {
    throw new Error(`Noto'g'ri SQL tur nomi: ${typeName}`);
  }
  return `${quoteIdent(assertSafeSchemaName(schema))}."${typeName}"`;
};

/**
 * Jadval ustunlari keshi — BITTA amal (ko'chirish) davomida. Global kesh
 * emas: migratsiya ishlayotgan server ostida qo'llansa, eski ro'yxat bilan
 * yozib qolmaslik uchun.
 */
const createShapeCache = () => new Map();

/**
 * Jadval ustunlari (tartib bilan), turi bilan.
 *
 * `local` — tur shu schema'ning o'zida yaratilgan (enum yoki enum massivi):
 * nusxalashda u maqsad schema'ning turiga o'giriladi.
 *
 * @param {object} db - `$queryRawUnsafe` bor client yoki tranzaksiya
 * @param {Map} cache
 * @param {string} schema
 * @param {string} table
 * @returns {Promise<Array<{name: string, udtName: string, isArray: boolean, local: boolean}>>}
 */
const loadColumns = async (db, cache, schema, table) => {
  const key = `${schema}.${table}`;
  if (cache.has(key)) return cache.get(key);

  const rows = await db.$queryRawUnsafe(
    `SELECT column_name AS name, data_type AS "dataType", udt_schema AS "udtSchema",
            udt_name AS "udtName"
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    schema,
    table,
  );
  if (rows.length === 0) {
    throw new Error(`Jadval topilmadi: ${key}`);
  }

  const columns = rows.map((row) => {
    const isArray = row.dataType === "ARRAY";
    return {
      name: row.name,
      // Massiv turi "_Tur" ko'rinishida keladi
      udtName: isArray ? String(row.udtName).replace(/^_/, "") : row.udtName,
      isArray,
      local: row.udtSchema === schema,
    };
  });
  cache.set(key, columns);
  return columns;
};

/**
 * Manba ustunini maqsad turiga keltiradigan SQL ifoda.
 * @param {string} expr - masalan `s."gender"`
 * @param {{udtName: string, isArray: boolean, local: boolean}} column - MAQSAD ustuni
 * @param {string} targetSchema
 */
const castExpr = (expr, column, targetSchema) => {
  if (!column.local) return expr;
  const type = schemaType(targetSchema, column.udtName);
  return column.isArray ? `${expr}::text[]::${type}[]` : `${expr}::text::${type}`;
};

/**
 * Ikki schema'da jadval shakli bir xilmi? Bir xil bo'lmasa — xato.
 * @returns {Promise<Array>} maqsad ustunlari (tartibi bilan)
 */
const assertSameShape = async (db, cache, sourceSchema, targetSchema, table) => {
  const [source, target] = await Promise.all([
    loadColumns(db, cache, sourceSchema, table),
    loadColumns(db, cache, targetSchema, table),
  ]);
  const sourceByName = new Map(source.map((c) => [c.name, c]));
  const same =
    source.length === target.length &&
    target.every((c) => {
      const s = sourceByName.get(c.name);
      return s && s.udtName === c.udtName && s.isArray === c.isArray;
    });
  if (!same) {
    throw new ConflictError(
      `"${table}" jadvali filiallarda bir xil emas — avval barcha filiallarga ` +
        "migratsiyani qo'llang (npm run branch:migrate)",
      { reason: "schema_drift", table },
    );
  }
  return target;
};

/**
 * Ikki schema'ga AYNI migratsiyalar qo'llanganmi?
 *
 * Jadval shakli tekshiruvidan kuchliroq qavat: enum qiymati yoki indeks
 * farqi ustunlar ro'yxatida ko'rinmaydi, lekin yozuvni yiqitadi yoki
 * (yanada yomoni) boshqacha talqin qilinadi.
 *
 * @param {object} db
 * @param {string[]} schemas
 */
const assertMigrationParity = async (db, schemas) => {
  const lists = await Promise.all(
    schemas.map(async (schema) => {
      const rows = await db.$queryRawUnsafe(
        `SELECT migration_name AS name FROM ${qualified(schema, "_prisma_migrations")}
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
      );
      return new Set(rows.map((row) => row.name));
    }),
  );

  const [first, ...rest] = lists;
  const differs = rest.some(
    (set) => set.size !== first.size || [...set].some((name) => !first.has(name)),
  );
  if (differs) {
    throw new ConflictError(
      "Filiallar bazasi bir xil versiyada emas — avval barcha filiallarga " +
        "migratsiyani qo'llang (npm run branch:migrate)",
      { reason: "schema_drift" },
    );
  }
};

/**
 * Qatorlarni bir schema'dan boshqasiga NUSXALAYDI (`INSERT … SELECT`).
 *
 * @param {object} db
 * @param {Map} cache
 * @param {object} spec
 * @param {string} spec.from - manba schema
 * @param {string} spec.to - maqsad schema
 * @param {string} spec.table
 * @param {string} spec.where - manba sharti, alias `s` (masalan `s."student_id" = ANY($1)`)
 * @param {any[]} [spec.params]
 * @param {Object<string, string>} [spec.override] - ustun → SQL ifoda (maqsad
 *   turida; alias `s` va `$n` parametrlari ishlatilishi mumkin)
 * @param {"error"|"nothing"|"update"} [spec.onConflict] - "update" → `id`
 *   bo'yicha mavjud qatorni yangilaydi (`keepOnUpdate` dagi ustunlardan tashqari)
 * @param {string[]} [spec.keepOnUpdate] - "update" da tegilmaydigan ustunlar
 * @returns {Promise<number>} yozilgan qatorlar soni
 */
const copyRows = async (db, cache, spec) => {
  const {
    from,
    to,
    table,
    where,
    params = [],
    override = {},
    onConflict = "error",
    keepOnUpdate = [],
  } = spec;
  const columns = await assertSameShape(db, cache, from, to, table);
  const names = columns.map((c) => c.name);

  for (const key of [...Object.keys(override), ...keepOnUpdate]) {
    if (!names.includes(key)) throw new Error(`"${table}" da "${key}" ustuni yo'q`);
  }

  const list = names.map(quoteIdent).join(", ");
  const select = columns
    .map((c) =>
      override[c.name] !== undefined
        ? `${override[c.name]} AS ${quoteIdent(c.name)}`
        : `${castExpr(`s.${quoteIdent(c.name)}`, c, to)} AS ${quoteIdent(c.name)}`,
    )
    .join(", ");

  let conflict = "";
  if (onConflict === "nothing") conflict = " ON CONFLICT DO NOTHING";
  if (onConflict === "update") {
    const updatable = names.filter((n) => n !== "id" && !keepOnUpdate.includes(n));
    conflict =
      ` ON CONFLICT ("id") DO UPDATE SET ` +
      updatable.map((n) => `${quoteIdent(n)} = EXCLUDED.${quoteIdent(n)}`).join(", ");
  }

  const sql =
    `INSERT INTO ${qualified(to, table)} (${list}) ` +
    `SELECT ${select} FROM ${qualified(from, table)} s WHERE ${where}${conflict}`;

  return db.$executeRawUnsafe(sql, ...params);
};

/**
 * Tanlangan manba qatorlarini YANGI `id` bilan nusxalaydi.
 *
 * Kelajak qoidalari (tarif, chegirma, muzlatish...) uchun: manbadagi qator
 * O'CHIRILMAYDI (u yopiladi va o'tgan oylar tarixi bo'lib qoladi), maqsadda
 * esa yangi davr ochiladi. Bir xil `id` ishlatilsa, odam qaytib kelganda
 * (A → B → A) yopilgan eski qator bilan to'qnashardi.
 *
 * @param {object} db
 * @param {Map} cache
 * @param {object} spec
 * @param {string} spec.from
 * @param {string} spec.to
 * @param {string} spec.table
 * @param {Array<[string, string]>} spec.pairs - [yangiId, manbaId]
 * @param {Object<string, string>} [spec.override] - ustun → SQL ifoda (alias
 *   `s`; parametrlar `$3` dan boshlanadi, `$1`/`$2` — juftliklar)
 * @param {any[]} [spec.params] - `$3`, `$4`, ... qiymatlari
 * @returns {Promise<number>}
 */
const copyRowsWithNewIds = async (db, cache, spec) => {
  const { from, to, table, pairs, override = {}, params = [] } = spec;
  if (!pairs?.length) return 0;
  const columns = await assertSameShape(db, cache, from, to, table);

  const list = columns.map((c) => quoteIdent(c.name)).join(", ");
  const select = columns
    .map((c) => {
      if (c.name === "id") return `m.new_id AS "id"`;
      if (override[c.name] !== undefined) return `${override[c.name]} AS ${quoteIdent(c.name)}`;
      return `${castExpr(`s.${quoteIdent(c.name)}`, c, to)} AS ${quoteIdent(c.name)}`;
    })
    .join(", ");

  const sql =
    `INSERT INTO ${qualified(to, table)} (${list}) SELECT ${select} ` +
    `FROM ${qualified(from, table)} s ` +
    `JOIN unnest($1::text[], $2::text[]) AS m(new_id, src_id) ON s."id" = m.src_id`;

  return db.$executeRawUnsafe(
    sql,
    pairs.map(([newId]) => newId),
    pairs.map(([, srcId]) => srcId),
    ...params,
  );
};

/**
 * Qatorlarni o'chiradi.
 * @param {object} db
 * @param {{schema: string, table: string, where: string, params?: any[]}} spec - alias `s`
 * @returns {Promise<number>}
 */
const deleteRows = (db, { schema, table, where, params = [] }) =>
  db.$executeRawUnsafe(`DELETE FROM ${qualified(schema, table)} s WHERE ${where}`, ...params);

/**
 * Qatorlarni KO'CHIRADI: maqsaddagi eskirgan nusxa o'chiriladi, manbadan
 * nusxalanadi, manbadagisi o'chiriladi. Hammasi chaqiruvchining
 * tranzaksiyasida.
 *
 * "Maqsaddagi eskirgan nusxa" — odam oldin shu filialda bo'lgan va qaytib
 * kelgan holat (A → B → A). Haqiqat — MANBA (odam hozir o'sha yerda yashaydi),
 * shuning uchun maqsaddagisi almashtiriladi, birlashtirilmaydi.
 *
 * @param {object} db
 * @param {Map} cache
 * @param {object} spec - `copyRows` bilan bir xil (alias `s` ikkala schema uchun)
 * @returns {Promise<number>} ko'chgan qatorlar soni
 */
const moveRows = async (db, cache, spec) => {
  const { from, to, table, where, params = [] } = spec;
  await deleteRows(db, { schema: to, table, where, params });
  const copied = await copyRows(db, cache, spec);
  await deleteRows(db, { schema: from, table, where, params });
  return copied;
};

/**
 * Tranzaksiya ichida advisory lock (kalitlar saralangan — ikki parallel
 * amal bir-birini kutib qolmasin). `studentClassChange.lockStudentClasses`
 * naqshi va AYNI kalit maydoni: hammasi bitta bazada.
 *
 * @param {object} db
 * @param {string[]} keys
 */
const advisoryLock = async (db, keys) => {
  const sorted = [...new Set(keys)].sort();
  if (sorted.length === 0) return;
  await db.$executeRawUnsafe(
    `SELECT pg_advisory_xact_lock(hashtext(k))
     FROM (SELECT unnest($1::text[]) AS k ORDER BY 1) AS ordered`,
    sorted,
  );
};

module.exports = {
  quoteIdent,
  qualified,
  schemaType,
  createShapeCache,
  loadColumns,
  assertSameShape,
  assertMigrationParity,
  copyRows,
  copyRowsWithNewIds,
  deleteRows,
  moveRows,
  advisoryLock,
};
