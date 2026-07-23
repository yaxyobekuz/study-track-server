/**
 * Data migration yordamchi funksiyalari.
 */

const { ObjectId } = require("mongodb");
const crypto = require("crypto");

/**
 * BSON ObjectId (yoki string) → 24-belgili hex string. null-safe.
 */
function oid(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (v instanceof ObjectId) return v.toHexString();
  if (v.toHexString) return v.toHexString();
  if (v._bsontype === "ObjectId" || v._bsontype === "ObjectID") return String(v);
  return String(v);
}

/**
 * Obyekt/massiv ichidagi barcha BSON ObjectId'larni rekursiv string'ga aylantiradi
 * (JSONB ustunlarga yozishdan oldin — Prisma BSON ObjectId'ni qabul qilmaydi).
 */
function deepObjectIdToString(value) {
  if (value == null) return value;
  if (value instanceof ObjectId) return value.toHexString();
  if (value._bsontype === "ObjectId" || value._bsontype === "ObjectID") {
    return String(value);
  }
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(deepObjectIdToString);
  if (typeof value === "object") {
    // Mongoose Map BSON'da oddiy obyekt sifatida keladi
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepObjectIdToString(v);
    }
    return out;
  }
  return value;
}

/**
 * Child jadval yozuvlari uchun DETERMINISTIK va NOYOB 24-hex id hosil qiladi.
 * (parentId, slot, index) → md5 hash ning birinchi 24 hex belgisi.
 * Xuddi shu uchlik har doim bir xil id beradi → to'liq idempotent; kolliziyasiz.
 * @param {string} parentId - parent 24 hex
 * @param {number} index - massiv indeksi (0-based)
 * @param {number} slot - bir parent'da bir nechta child jadval bo'lsa ajratish uchun
 */
function childId(parentId, index, slot = 0) {
  return crypto
    .createHash("md5")
    .update(`${parentId}:${slot}:${index}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Massivni bo'laklarga bo'ladi (batch createMany uchun).
 */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Sana → Date yoki null.
 */
function toDate(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * timestamps'ni saqlash: mavjud createdAt/updatedAt yoki hozir (fallback).
 * NOTE: Fallback uchun _id'dan timestamp olamiz (ObjectId ichida timestamp bor).
 */
function timestamps(doc) {
  const createdAt =
    toDate(doc.createdAt) ||
    (doc._id instanceof ObjectId ? doc._id.getTimestamp() : new Date(0));
  const updatedAt = toDate(doc.updatedAt) || createdAt;
  return { createdAt, updatedAt };
}

module.exports = {
  oid,
  deepObjectIdToString,
  childId,
  chunk,
  toDate,
  timestamps,
};
