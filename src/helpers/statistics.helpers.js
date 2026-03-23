const { getNowInUzbekistan } = require("./date.helpers");

/**
 * Yil ichidagi hafta raqamini qaytaradi (1-52)
 * @param {Date} date - Sana
 * @returns {number} Hafta raqami (1-52)
 */
const getWeekNumber = (date) => {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return weekNo;
};

/**
 * Joriy haftaning chegaralarini qaytaradi (dushanba - bugun)
 * @returns {{weekStart: Date, weekEnd: Date, weekNumber: number, year: number}}
 */
const getCurrentWeekRange = () => {
  const today = getNowInUzbekistan();
  const dayOfWeek = today.getDay(); // 0=yakshanba, 1=dushanba, ..., 6=shanba

  // Dushanba = hafta boshi
  // Agar bugun yakshanba (0) bo'lsa, 6 kun orqaga
  // Aks holda dayOfWeek - 1 kun orqaga
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  const monday = new Date(today);
  monday.setDate(today.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);

  // Bugun = hafta oxiri (faqat o'tgan kunlar)
  const todayEnd = new Date(today);
  todayEnd.setHours(23, 59, 59, 999);

  return {
    weekStart: monday,
    weekEnd: todayEnd,
    weekNumber: getWeekNumber(monday),
    year: monday.getFullYear(),
  };
};

/**
 * Baholar yig'indisini hisoblaydi
 * @param {Array} grades - Baholar array (har bir grade da .grade field bor)
 * @returns {number} Barcha baholar yig'indisi
 */
const calculateTotalSum = (grades) => {
  if (!grades || grades.length === 0) return 0;
  return grades.reduce((acc, g) => acc + g.grade, 0);
};

module.exports = {
  getWeekNumber,
  getCurrentWeekRange,
  calculateTotalSum,
};
