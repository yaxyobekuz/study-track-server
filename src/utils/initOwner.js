const prisma = require("../config/prisma");
const { runWithBranch } = require("../config/branchContext");
const { config } = require("../config/env.config");
const { hashPassword } = require("./password");
const logger = require("./logger");
const userDirectory = require("../services/userDirectory.service");

/**
 * Owner — YAGONA foydalanuvchi turi bo'lib, HAR BIR filial schema'sida
 * mavjud bo'ladi va AYNAN BIR XIL `id` bilan.
 *
 * NIMA UCHUN: qolgan hamma "bitta foydalanuvchi = bitta filial" qoidasiga
 * bo'ysunadi, owner esa istalgan filialda ishlashi kerak. Uning qatorini
 * har filialga ko'chirish ikki muammoni bir yo'la yechadi:
 *
 *   1) `req.user` boshqa filialga o'tganda ham topiladi (auth.middleware
 *      foydalanuvchini AKTIV filialdan o'qiydi),
 *   2) `createdBy` ishoralari o'sha filial ichida hal bo'ladi — aks holda
 *      "kim yaratdi" ustuni boshqa schema'dagi ID'ga ishora qilardi.
 *
 * `UserDirectory` da esa owner FAQAT BIR MARTA turadi (uy filiali) — login
 * yo'naltirgichi yagona bo'lishi kerak.
 */

/** Owner qatorining nusxa olinadigan maydonlari. */
const OWNER_SELECT = {
  id: true,
  username: true,
  password: true,
  plainPassword: true,
  firstName: true,
  lastName: true,
  gender: true,
};

/**
 * Default (uy) filialida owner'ni yaratadi — agar hali bo'lmasa.
 *
 * @param {object} branch - default filial
 * @returns {Promise<object|null>} owner qatori
 */
const initOwner = async (branch) => {
  if (!branch) {
    logger.error("Owner yaratilmadi: default filial aniqlanmadi");
    return null;
  }

  try {
    return await runWithBranch(branch, async () => {
      const existing = await prisma.user.findFirst({
        where: { role: "owner" },
        select: OWNER_SELECT,
      });

      if (existing) {
        // Yo'naltirgichda yo'q bo'lishi mumkin (filiallashtirishdan oldin
        // yaratilgan tizim) — lazy ravishda qo'shib qo'yamiz.
        await userDirectory.sync({
          id: existing.id,
          username: existing.username,
          branchId: branch.id,
          role: "owner",
          firstName: existing.firstName,
          lastName: existing.lastName ?? "",
        });
        return existing;
      }

      logger.info("Owner topilmadi. Yangi owner yaratilmoqda...");
      const password = await hashPassword(config.defaultOwnerPassword);

      const created = await prisma.user.create({
        data: {
          username: config.defaultOwnerUsername.toLowerCase().trim(),
          password,
          plainPassword: config.defaultOwnerPassword,
          firstName: config.defaultOwnerFirstname,
          lastName: config.defaultOwnerLastname,
          role: "owner",
          isActive: true,
        },
        select: OWNER_SELECT,
      });

      await userDirectory.sync({
        id: created.id,
        username: created.username,
        branchId: branch.id,
        role: "owner",
        firstName: created.firstName,
        lastName: created.lastName ?? "",
      });

      logger.info("Default owner muvaffaqiyatli yaratildi");
      return created;
    });
  } catch (error) {
    logger.error("Owner yaratishda xato:", error.message);
    return null;
  }
};

/**
 * Owner qatorini YANGI filial schema'siga ko'chiradi (aynan o'sha `id` bilan).
 *
 * `UserDirectory` ga YOZILMAYDI: yo'naltirgichda owner faqat uy filialida
 * turadi, aks holda username ikki marta band bo'lardi.
 *
 * @param {object} branch - yangi filial
 * @param {object} owner - default filialdagi owner qatori (OWNER_SELECT)
 */
const mirrorOwnerIntoBranch = async (branch, owner) => {
  if (!owner) return null;

  return runWithBranch(branch, () =>
    prisma.user.upsert({
      where: { id: owner.id },
      create: {
        id: owner.id,
        username: owner.username,
        password: owner.password,
        plainPassword: owner.plainPassword,
        firstName: owner.firstName,
        lastName: owner.lastName,
        gender: owner.gender,
        role: "owner",
        isActive: true,
      },
      // Parol/ism uy filialida o'zgargan bo'lsa — nusxani yangilaymiz.
      update: {
        username: owner.username,
        password: owner.password,
        plainPassword: owner.plainPassword,
        firstName: owner.firstName,
        lastName: owner.lastName,
      },
      select: { id: true },
    }),
  );
};

/**
 * Default filialdagi owner qatorini o'qiydi (ko'chirish uchun manba).
 * @param {object} branch
 */
const readOwner = async (branch) =>
  runWithBranch(branch, () =>
    prisma.user.findFirst({ where: { role: "owner" }, select: OWNER_SELECT }),
  );

module.exports = initOwner;
module.exports.mirrorOwnerIntoBranch = mirrorOwnerIntoBranch;
module.exports.readOwner = readOwner;
module.exports.OWNER_SELECT = OWNER_SELECT;
