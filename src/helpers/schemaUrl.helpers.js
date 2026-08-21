/**
 * PostgreSQL ulanish satridagi `schema` parametrini almashtirish.
 *
 * Filiallashtirish shu bitta amalga tayanadi: bazaga ulanish satri BITTA
 * (`DATABASE_URL`), filial esa `?schema=` bilan tanlanadi. Yangi filial —
 * yangi schema, yangi ulanish satri emas: parol ham, host ham, zaxira nusxa
 * ham bitta joyda qoladi.
 *
 * `connection_limit` ham shu yerda o'rnatiladi: har filial uchun alohida
 * PrismaClient ochiladi, ya'ni standart pool (CPU × 2 + 1) 10 ta filialda
 * Postgres'ning `max_connections` ini yeb qo'yardi.
 */

const { BadRequestError } = require("../utils/errors");

// Postgres identifikatori: harf/pastki chiziq bilan boshlanadi, 63 belgigacha.
// Schema nomi SQL'ga `$executeRawUnsafe` bilan tushadi (DDL parametrlanmaydi) —
// shuning uchun tekshiruv qat'iy va yagona joyda.
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Schema nomi xavfsizmi? Xavfsiz bo'lmasa xato tashlaydi.
 * @param {string} schemaName
 * @returns {string} o'sha nom (zanjirlab ishlatish uchun)
 */
function assertSafeSchemaName(schemaName) {
  if (typeof schemaName !== "string" || !SCHEMA_NAME_PATTERN.test(schemaName)) {
    throw new BadRequestError(
      "Schema nomi noto'g'ri: faqat kichik lotin harflari, raqam va pastki chiziq",
    );
  }
  return schemaName;
}

/**
 * Ulanish satrining `schema` parametrini almashtiradi.
 *
 * @param {string} baseUrl - `DATABASE_URL` (schema'si bo'lishi ham, bo'lmasligi ham mumkin)
 * @param {string} schemaName - "platform", "public", "br_chilonzor"
 * @param {{connectionLimit?: number}} [options]
 * @returns {string}
 */
function buildSchemaUrl(baseUrl, schemaName, options = {}) {
  assertSafeSchemaName(schemaName);

  const { connectionLimit } = options;
  const url = new URL(baseUrl);

  url.searchParams.set("schema", schemaName);
  if (connectionLimit != null) {
    url.searchParams.set("connection_limit", String(connectionLimit));
  }

  return url.toString();
}

/**
 * Filial kodidan schema nomini hosil qiladi ("chilonzor" → "br_chilonzor").
 *
 * Bosh filial ISTISNO: uning schema'si `public` bo'lib qoladi va bu funksiya
 * orqali hosil qilinmaydi — `Branch.schemaName` ustuni aynan shuning uchun
 * `code` dan hosila EMAS.
 *
 * @param {string} code
 * @param {string} [prefix="br_"]
 * @returns {string}
 */
function schemaNameForCode(code, prefix = "br_") {
  return assertSafeSchemaName(`${prefix}${String(code).toLowerCase().trim()}`);
}

module.exports = {
  SCHEMA_NAME_PATTERN,
  assertSafeSchemaName,
  buildSchemaUrl,
  schemaNameForCode,
};
