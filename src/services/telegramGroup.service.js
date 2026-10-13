/**
 * TELEGRAM GURUHLARI — "bot qaysi guruhlarda bor va qayerda admin".
 *
 * Admin paneldagi "Muammolar → Bot sozlamalari" tabi shu service ustida
 * turadi. Reyestrni BOT to'ldiradi (`bot/src/services/group.service.js`),
 * server esa o'qiydi, Telegram'dan qayta tekshiradi va "rasmiy guruh"
 * belgisini qo'yadi.
 *
 * ── NIMA UCHUN REYESTR, NIMA UCHUN "TEKSHIRISH" TUGMASI ──────────────
 *
 * ⚠️ Telegram Bot API'da "men qaysi guruhlarda adminman" degan savolga
 * javob beradigan metod YO'Q (`getChats` faqat MTProto — bot emas, ODAM
 * nomidan ulanish). Shuning uchun ro'yxat `my_chat_member` hodisasidan
 * to'planadi va u O'TMISHGA QARAMAYDI: bu kod joylashtirilishidan oldin
 * bot a'zo bo'lgan guruh ro'yxatga o'zi tushmaydi.
 *
 * Shu sababli `refreshGroups()` bor: u saqlangan `chatId` bo'yicha
 * Telegram'ga murojaat qilib nom va holatni YANGILAYDI. Yangi guruh
 * TOPMAYDI — topa olmaydi, chunki boshlanish nuqtasi `chatId`, u esa
 * faqat hodisadan keladi.
 *
 * ── PLATFORMA, FILIAL EMAS ───────────────────────────────────────────
 *
 * ⚠️ `platformPrisma` ishlatiladi, `config/prisma.js` EMAS: `my_chat_member`
 * kelganda botda filial konteksti yo'q (guruhga botni ro'yxatdan o'tmagan
 * odam qo'shishi mumkin), ya'ni guruhni filialga bo'lish uchun ishonchli
 * signal mavjud emas. Changelog bilan ayni mulohaza — reyestr umumiy.
 *
 * ⚠️ IKKI PRISMA CLIENT: bu service platformaga yozadi, `officialBy` esa
 * FILIAL schema'sidagi `User.id` — FK YO'Q va bo'lishi ham mumkin emas.
 * Belgilagan odamning ismi ro'yxatga `attachOfficialSetters()` bilan
 * qo'lda biriktiriladi.
 */

const platformPrisma = require("../config/platformPrisma");
const prisma = require("../config/prisma");
const telegramService = require("./telegram.service");
const logger = require("../utils/logger");
const { NotFoundError, ValidationError } = require("../utils/errors");

/**
 * Bot guruhda ADMIN — Telegram `ChatMember.status`.
 *
 * ⚠️ `creator` bot uchun bo'lmaydi (bot guruh yarata olmaydi), lekin
 * ro'yxatda turadi: qiymat Telegram'dan keladi va kutilmaganini jim
 * yo'qotmaslik kerak.
 */
const ADMIN_STATUSES = new Set(["administrator", "creator"]);

/** Bot guruh ICHIDA — xabar yuborish printsipial mumkin. */
const PRESENT_STATUSES = new Set([
  "administrator",
  "creator",
  "member",
  "restricted",
]);

/** @param {string} status */
const isAdmin = (status) => ADMIN_STATUSES.has(status);

/**
 * "Rasmiy" belgisini QO'YGAN odamlarning ismini biriktiradi.
 *
 * `officialBy` — filial schema'sidagi `User.id` (boshqa schema, FK yo'q),
 * shuning uchun qo'lda yuklanadi — `socialNetwork.controller.js` dagi
 * `attachCreators` bilan ayni naqsh.
 *
 * ⚠️ TOPILMASLIGI NORMAL: reyestr platformada, odam esa filialda. Belgini
 * boshqa filial xodimi qo'ygan bo'lsa, joriy filialda u qator yo'q va
 * `null` qaytadi — bu xato emas.
 */
async function attachOfficialSetters(groups) {
  const ids = [...new Set(groups.map((g) => g.officialBy).filter(Boolean))];
  if (!ids.length) return groups.map((g) => ({ ...g, officialBy: null }));

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  return groups.map((g) => ({
    ...g,
    officialBy: g.officialBy ? byId.get(g.officialBy) || null : null,
  }));
}

/**
 * Reyestr — eng avval RASMIY guruhlar, so'ng nomi bo'yicha.
 *
 * ⚠️ CHIQIB KETGAN GURUH HAM QAYTADI (o'chirilmaydi): "bot bu guruhdan
 * chiqarilgan" — admin ko'rishi kerak bo'lgan fakt. Ro'yxatdan yo'qolsa,
 * rasmiy deb belgilangan guruh jimgina g'oyib bo'lardi.
 *
 * `isAdmin` / `isPresent` — SERVERDA hisoblanadi: holat satrini
 * ("administrator", "restricted") panelda qayta talqin qilish ikkita
 * haqiqat manbasini yaratardi.
 */
async function listGroups() {
  const groups = await platformPrisma.telegramGroup.findMany({
    orderBy: [{ isOfficial: "desc" }, { title: "asc" }],
  });

  const withSetters = await attachOfficialSetters(groups);

  return withSetters.map((g) => ({
    ...g,
    isAdmin: isAdmin(g.status),
    isPresent: PRESENT_STATUSES.has(g.status),
  }));
}

/**
 * Saqlangan guruhlarni Telegram'dan QAYTA TEKSHIRADI — nom, tur va
 * botning holati.
 *
 * ⚠️ YANGI GURUH TOPMAYDI va topa olmaydi: boshlanish nuqtasi saqlangan
 * `chatId`, u esa faqat `my_chat_member` hodisasidan yoki guruhdagi
 * xabardan keladi (fayl boshidagi izoh).
 *
 * ⚠️ BITTA GURUHDAGI XATO QOLGANINI TO'XTATMAYDI: guruh o'chirilgan yoki
 * bot chiqarilgan bo'lishi mumkin, qolgan guruhlar esa yangilanishi kerak.
 *
 * @returns {Promise<{ checked: number, updated: number, failed: number }>}
 */
async function refreshGroups() {
  const groups = await platformPrisma.telegramGroup.findMany({
    select: { chatId: true },
  });

  let updated = 0;
  let failed = 0;

  for (const { chatId } of groups) {
    try {
      const info = await telegramService.getChatStatus(chatId);
      if (!info) {
        failed += 1;
        continue;
      }

      await platformPrisma.telegramGroup.update({
        where: { chatId },
        // ⚠️ `isOfficial` va `official*` BERILMAYDI — ular admin
        // panelning qarori, Telegram ularni bilmaydi.
        data: {
          title: info.title,
          username: info.username,
          type: info.type,
          status: info.status,
          canPostMessages: info.canPostMessages,
          canInviteUsers: info.canInviteUsers,
          leftAt: PRESENT_STATUSES.has(info.status) ? null : new Date(),
        },
      });
      updated += 1;
    } catch (error) {
      logger.error(`Guruhni tekshirishda xato (${chatId}): ${error.message}`);
      failed += 1;
    }
  }

  return { checked: groups.length, updated, failed };
}

/**
 * "RASMIY GURUH" belgisini qo'yadi yoki olib tashlaydi.
 *
 * ⚠️ HOZIRCHA FAQAT BELGI: tizim rasmiy guruhga hech narsa YUBORMAYDI.
 * Ma'nosi — "bu maktabning tanilgan guruhi"; keyin xabar yuborish
 * qo'shilganda manba ro'yxati tayyor bo'ladi.
 *
 * ⚠️ FAQAT BOT ADMIN BO'LGAN GURUHDA QO'YILADI. Oddiy a'zo bo'lgan
 * guruhni "rasmiy" deb belgilash, keyinchalik yuborish qo'shilganda jim
 * ishlamaydigan sozlamaga aylanardi: belgi bor, lekin xabar ketmaydi.
 * Tekshiruv SERVERDA — tugmani yashirish yetarli emas, chunki reyestr
 * eskirgan bo'lishi mumkin (botni shu orada adminlikdan tushirishgan).
 *
 * ⚠️ OLIB TASHLASHDA tekshiruv YO'Q: bot adminlikdan tushirilgan guruhni
 * "rasmiy emas" deb belgilash har doim mumkin bo'lishi kerak, aks holda
 * belgi abadiy qotib qolardi.
 *
 * @param {string} chatId
 * @param {boolean} isOfficial
 * @param {{ userId: string, branchId?: string }} actor
 */
async function setOfficial(chatId, isOfficial, actor) {
  const group = await platformPrisma.telegramGroup.findUnique({
    where: { chatId },
  });
  if (!group) throw new NotFoundError("Guruh topilmadi");

  if (isOfficial && !isAdmin(group.status)) {
    throw new ValidationError(
      "Bot bu guruhda admin emas — rasmiy guruh sifatida belgilash mumkin emas",
    );
  }

  return platformPrisma.telegramGroup.update({
    where: { chatId },
    data: isOfficial
      ? {
          isOfficial: true,
          officialBy: actor.userId,
          officialAt: new Date(),
          officialBranch: actor.branchId || null,
        }
      : {
          isOfficial: false,
          // Kim/qachon belgilagani TOZALANADI: belgi yo'q bo'lsa uning
          // muallifi ham qolmasligi kerak — aks holda panelda "rasmiy
          // emas, lekin falonchi belgilagan" degan ziddiyat ko'rinardi.
          officialBy: null,
          officialAt: null,
          officialBranch: null,
        },
  });
}

module.exports = {
  ADMIN_STATUSES,
  PRESENT_STATUSES,
  isAdmin,
  listGroups,
  refreshGroups,
  setOfficial,
};
