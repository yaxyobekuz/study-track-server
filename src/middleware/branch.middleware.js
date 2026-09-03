const { runWithBranch } = require("../config/branchContext");

/**
 * Filial kontekstini QAYTA tiklaydi (multipart yuklovchidan keyin).
 *
 * `auth.middleware.protect` filial kontekstini `AsyncLocalStorage` orqali
 * o'rnatadi va `next()` ni o'sha scope ICHIDA chaqiradi. Lekin `multer` kabi
 * multipart body parserlari so'rov stream'ini ASINXRON o'qiydi va o'z
 * callback'ini stream 'close' hodisasidan — ya'ni ALS scope'idan TASHQARIDA —
 * chaqiradi. Natijada multer'dan keyingi controller `config/prisma` ga
 * murojaat qilsa "Filial konteksti yo'q" xatosi chiqadi.
 *
 * Shu middleware'ni `protect` + multipart yuklovchidan KEYIN qo'ying: u
 * `protect` saqlab qo'ygan `req.branch` yordamida kontekstni tiklaydi, shunda
 * keyingi controller yana joriy filial client'ini ko'radi.
 *
 * Faqat multipart (fayl yuklovchi) route'larda kerak — oddiy JSON so'rovlarda
 * kontekst uzilmaydi.
 */
const rebindBranchContext = (req, res, next) => {
  if (!req.branch) return next();
  return runWithBranch(req.branch, () => next());
};

module.exports = { rebindBranchContext };
