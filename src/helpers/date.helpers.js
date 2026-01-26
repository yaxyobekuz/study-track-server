const { DAYS_UZ } = require("../utils/constants");

/**
 * Bugungi kun nomini qaytaradi (o'zbek tilida)
 * @returns {string} Kun nomi (masalan: "dushanba")
 */
const getCurrentDayUz = () => {
  const today = new Date();
  return DAYS_UZ[today.getDay()];
};

/**
 * Berilgan sananing kun nomini qaytaradi (o'zbek tilida)
 * @param {Date|string} date - Sana
 * @returns {string} Kun nomi (masalan: "seshanba")
 */
const getDayNameUz = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  return DAYS_UZ[dateObj.getDay()];
};

/**
 * Kunning boshlanish va tugash vaqtini qaytaradi
 * @param {Date|string} date - Sana
 * @returns {{startDate: Date, endDate: Date}} Kun boshlanish va tugash vaqti
 */
const getDateRangeForDay = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);

  const startDate = new Date(dateObj);
  startDate.setHours(0, 0, 0, 0);

  const endDate = new Date(dateObj);
  endDate.setHours(23, 59, 59, 999);

  return { startDate, endDate };
};

/**
 * Yakshanba ekanligini tekshiradi
 * @param {Date|string} date - Sana (optional, default: bugun)
 * @returns {boolean} Yakshanba bo'lsa true
 */
const isSunday = (date = new Date()) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  return dateObj.getDay() === 0;
};

/**
 * Bugun ekanligini tekshiradi
 * @param {Date|string} date - Sana
 * @returns {boolean} Bugun bo'lsa true
 */
const isToday = (date) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  const today = new Date();

  return (
    dateObj.getDate() === today.getDate() &&
    dateObj.getMonth() === today.getMonth() &&
    dateObj.getFullYear() === today.getFullYear()
  );
};

/**
 * Ikki sanani taqqoslaydi (faqat kun, soat hisobga olinmaydi)
 * @param {Date|string} date1 - Birinchi sana
 * @param {Date|string} date2 - Ikkinchi sana
 * @returns {boolean} Bir xil kun bo'lsa true
 */
const isSameDay = (date1, date2) => {
  const d1 = date1 instanceof Date ? date1 : new Date(date1);
  const d2 = date2 instanceof Date ? date2 : new Date(date2);

  return (
    d1.getDate() === d2.getDate() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getFullYear() === d2.getFullYear()
  );
};

/**
 * Sana uchun ertangi kunning boshlanish vaqtini qaytaradi
 * @param {Date|string} date - Sana (optional, default: bugun)
 * @returns {Date} Ertangi kun boshlanish vaqti
 */
const getTomorrowStart = (date = new Date()) => {
  const dateObj = date instanceof Date ? date : new Date(date);
  const tomorrow = new Date(dateObj);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
};

module.exports = {
  getCurrentDayUz,
  getDayNameUz,
  getDateRangeForDay,
  isSunday,
  isToday,
  isSameDay,
  getTomorrowStart,
};
