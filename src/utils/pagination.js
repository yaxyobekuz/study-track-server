const { PAGINATION_DEFAULTS } = require("./constants");

/**
 * Query parametrlardan sahifalash ma'lumotlarini oladi
 * @param {Object} req - Express request object
 * @param {number} defaultLimit - Default limit qiymati (ixtiyoriy)
 * @returns {{page: number, limit: number, skip: number}}
 */
const getPaginationParams = (req, defaultLimit = PAGINATION_DEFAULTS.LIMIT) => {
  const page = parseInt(req.query.page, 10) || PAGINATION_DEFAULTS.PAGE;
  const limit = parseInt(req.query.limit, 10) || defaultLimit;
  const skip = (page - 1) * limit;

  return {
    page,
    limit,
    skip,
  };
};

/**
 * Javobni pagination ma'lumotlari bilan formatlaydi
 * @param {Array} data - Ma'lumotlar array'i
 * @param {number} total - Umumiy ma'lumotlar soni
 * @param {number} page - Joriy sahifa raqami
 * @param {number} limit - Har bir sahifadagi ma'lumotlar soni
 * @returns {Object} Formatlanganjavob
 */
const formatPaginationResponse = (data, total, page, limit) => {
  const totalPages = Math.ceil(total / limit);

  return {
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    },
  };
};

module.exports = {
  getPaginationParams,
  formatPaginationResponse,
};
