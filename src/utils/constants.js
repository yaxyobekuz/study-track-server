// Roles
const ROLES = {
  OWNER: "owner",
  TEACHER: "teacher",
  STUDENT: "student",
};

// Days of the week
const DAYS = {
  MONDAY: "dushanba",
  TUESDAY: "seshanba",
  WEDNESDAY: "chorshanba",
  THURSDAY: "payshanba",
  FRIDAY: "juma",
  SATURDAY: "shanba",
};

// Hafta kunlari massivi (o'zbek tilida)
const DAYS_UZ = [
  "yakshanba", // 0 - Sunday
  "dushanba", // 1 - Monday
  "seshanba", // 2 - Tuesday
  "chorshanba", // 3 - Wednesday
  "payshanba", // 4 - Thursday
  "juma", // 5 - Friday
  "shanba", // 6 - Saturday
];

// Baho chegaralari
const GRADE_MIN = 2;
const GRADE_MAX = 5;

// Pagination default qiymatlari
const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 24,
};

module.exports = {
  ROLES,
  DAYS,
  DAYS_UZ,
  GRADE_MIN,
  GRADE_MAX,
  PAGINATION_DEFAULTS
};
