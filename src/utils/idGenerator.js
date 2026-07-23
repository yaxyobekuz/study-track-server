/**
 * Yangi yozuvlar uchun MongoDB ObjectId-mos 24-belgili hex ID generatsiyasi.
 *
 * Migratsiyadan keyin ham ID format bir xil (24-hex) qoladi — frontendlar,
 * coinTransaction.meta.*Id kabi denormalizatsiya, va boshqa string-ref joylar
 * buzilmaydi. cuid() ISHLATILMAYDI.
 */

const { ObjectId } = require("bson");

/**
 * Yangi 24-belgili hex ID qaytaradi (ObjectId asosida).
 * @returns {string}
 */
function generateId() {
  return new ObjectId().toHexString();
}

module.exports = { generateId };
