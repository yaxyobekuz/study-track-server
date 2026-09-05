/**
 * FOYDALANUVCHI USTIDAGI AMALLARNING EGALIK DARVOZASI.
 *
 * `authorizePermission` "shu amalga huquqing bormi?" degan savolga javob
 * beradi, bu middleware esa "AYNAN SHU odamga tegishing mumkinmi?" degan
 * savolga. Ikkalasi alohida bo'lishi shart: o'qituvchiga `users.update`
 * berilganda u butun ro'yxatni emas, faqat o'zi qo'shgan o'quvchini
 * tahrirlay olishi kerak.
 *
 * ⚠️ Qoida SERVICE'da yashaydi (`assertCanManageUser`) — bu yerda faqat
 * route'ga ulanadi. Ikki nusxa bo'lsa, biri o'zgarib ikkinchisi eskirardi.
 */

const asyncHandler = require("./async.middleware");
const { assertCanManageUser } = require("../services/user.service");

/**
 * `:id` dagi foydalanuvchiga tegish huquqini tekshiradi.
 * Owner va o'qituvchidan boshqa xodimlar uchun shaffof o'tadi.
 */
const restrictUserScope = asyncHandler(async (req, res, next) => {
  await assertCanManageUser(req.params.id, req.user);
  next();
});

module.exports = { restrictUserScope };
