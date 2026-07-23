const { isValidId } = require("../utils/objectId");
const { ValidationError } = require("../utils/errors");
const { GRADE_MIN, GRADE_MAX } = require("../utils/constants");

/**
 * 24-belgili hex ID formatini tekshiradi
 * @param {string} paramName - Param nomi (masalan: 'id', 'classId')
 * @returns {Function} Express middleware
 */
const validateObjectId = (paramName) => {
  return (req, res, next) => {
    const id = req.params[paramName];

    if (!isValidId(id)) {
      throw new ValidationError(`Noto'g'ri ${paramName} formati`);
    }

    next();
  };
};

/**
 * Majburiy maydonlarni tekshiradi
 * @param {string[]} fields - Majburiy maydonlar ro'yxati
 * @returns {Function} Express middleware
 */
const validateRequired = (fields) => {
  return (req, res, next) => {
    const missingFields = [];

    fields.forEach((field) => {
      if (!req.body[field]) {
        missingFields.push(field);
      }
    });

    if (missingFields.length > 0) {
      throw new ValidationError(
        `Quyidagi majburiy maydonlar to'ldirilmagan: ${missingFields.join(", ")}`
      );
    }

    next();
  };
};

/**
 * Baho (2-5) tekshiradi
 * @returns {Function} Express middleware
 */
const validateGrade = () => {
  return (req, res, next) => {
    const { grade } = req.body;

    if (!grade) {
      throw new ValidationError("Baho kiritilmagan");
    }

    const gradeNum = Number(grade);

    if (isNaN(gradeNum)) {
      throw new ValidationError("Baho raqam bo'lishi kerak");
    }

    if (gradeNum < GRADE_MIN || gradeNum > GRADE_MAX) {
      throw new ValidationError(`Baho ${GRADE_MIN} dan ${GRADE_MAX} gacha bo'lishi kerak`);
    }

    next();
  };
};

/**
 * Sana formatini tekshiradi
 * @param {string} paramName - Param nomi (masalan: 'date', 'startDate')
 * @param {string} location - 'params', 'query' yoki 'body' (default: 'params')
 * @returns {Function} Express middleware
 */
const validateDate = (paramName, location = "params") => {
  return (req, res, next) => {
    const dateStr = req[location][paramName];

    if (!dateStr) {
      throw new ValidationError(`${paramName} kiritilmagan`);
    }

    const date = new Date(dateStr);

    if (isNaN(date.getTime())) {
      throw new ValidationError(`Noto'g'ri ${paramName} formati`);
    }

    next();
  };
};

/**
 * Sana oralig'ini tekshiradi (startDate endDate'dan kichik bo'lishi kerak)
 * @param {string} location - 'query' yoki 'body' (default: 'query')
 * @returns {Function} Express middleware
 */
const validateDateRange = (location = "query") => {
  return (req, res, next) => {
    const { startDate, endDate } = req[location];

    if (startDate && endDate) {
      const start = new Date(startDate);
      const end = new Date(endDate);

      if (start > end) {
        throw new ValidationError("Boshlanish sanasi tugash sanasidan katta bo'lmasligi kerak");
      }
    }

    next();
  };
};

/**
 * Email formatini tekshiradi
 * @param {string} fieldName - Field nomi (default: 'email')
 * @returns {Function} Express middleware
 */
const validateEmail = (fieldName = "email") => {
  return (req, res, next) => {
    const email = req.body[fieldName];

    if (!email) {
      throw new ValidationError(`${fieldName} kiritilmagan`);
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      throw new ValidationError(`Noto'g'ri ${fieldName} formati`);
    }

    next();
  };
};

module.exports = {
  validateObjectId,
  validateRequired,
  validateGrade,
  validateDate,
  validateDateRange,
  validateEmail,
};
