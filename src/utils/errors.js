/**
 * Validation xatolari uchun custom error sinfi
 * HTTP status code: 400
 */
class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.statusCode = 400;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Resurs topilmadi xatosi uchun
 * HTTP status code: 404
 */
class NotFoundError extends Error {
  constructor(message = "Resurs topilmadi") {
    super(message);
    this.name = "NotFoundError";
    this.statusCode = 404;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Autentifikatsiya xatosi uchun
 * HTTP status code: 401
 */
class UnauthorizedError extends Error {
  constructor(message = "Autentifikatsiya xatosi") {
    super(message);
    this.name = "UnauthorizedError";
    this.statusCode = 401;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Ruxsat yo'q xatosi uchun
 * HTTP status code: 403
 */
class ForbiddenError extends Error {
  constructor(message = "Ruxsat yo'q") {
    super(message);
    this.name = "ForbiddenError";
    this.statusCode = 403;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Noto'g'ri so'rov xatosi uchun
 * HTTP status code: 400
 */
class BadRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequestError";
    this.statusCode = 400;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Raqobat xatosi — yozuv o'qilgandan keyin boshqa tranzaksiya tomonidan
 * o'zgartirilgan. Moliya modulidagi compare-and-swap yozuvlari shuni
 * qaytaradi: mijoz uchun bu "qayta urinib ko'ring", 400 (kiritishda xato)
 * ham, 500 (server buzildi) ham emas.
 *
 * HTTP status code: 409
 */
class ConflictError extends Error {
  constructor(message = "Ma'lumot o'zgardi, qayta urinib ko'ring") {
    super(message);
    this.name = "ConflictError";
    this.statusCode = 409;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Juda tez-tez so'rov — chastota chegarasi.
 *
 * Qimmat va HAFTALIK amallar uchun (masalan AI tahlilini qo'lda
 * yangilash): tugmani bosaverib tashqi API ni sarflab bo'lmasin.
 * Bu 400 emas — so'rovda xato yo'q, faqat VAQTI kelmagan.
 *
 * HTTP status code: 429
 */
class TooManyRequestsError extends Error {
  constructor(message = "Juda ko'p so'rov yuborildi, keyinroq urinib ko'ring") {
    super(message);
    this.name = "TooManyRequestsError";
    this.statusCode = 429;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Server ichki xatosi uchun
 * HTTP status code: 500
 */
class InternalServerError extends Error {
  constructor(message = "Server ichki xatosi") {
    super(message);
    this.name = "InternalServerError";
    this.statusCode = 500;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
  TooManyRequestsError,
  InternalServerError,
};
