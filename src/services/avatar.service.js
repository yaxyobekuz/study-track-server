/**
 * PROFIL RASMI (AVATAR) — xodim va o'quvchi uchun.
 *
 * Qoida bitta jumlada:
 *
 * > Rasm odamning UY FILIALIDA saqlanadi (`User.profilePicture` → `Image`),
 * > lekin istoriya va chat uni PLATFORMADAGI `user_directory` dan o'qiydi.
 *
 * ⚠️ NIMA UCHUN IKKI JOY: lenta 300 xodimning kartochkasini chizadi va
 * ularning `users` qatorlari BOSHQA schema'larda yotadi — har biri uchun
 * o'z filialining bazasiga borish N+1 so'rov bo'lardi. Shuning uchun
 * `avatarUrl` (`sm` variant) va `avatarPreset` platformaga
 * DENORMALIZATSIYA qilinadi va har o'zgarishda qayta yoziladi.
 *
 * ⚠️ YANGI SAQLASH USULI YOZILMADI: `image.service.js` dagi
 * `uploadImageWithVariants` (premium o'quvchi rasmi uchun ishlatilgan)
 * QAYTA ISHLATILADI — `sm` / `md` / `lg` variantlari, bir xil papka,
 * bir xil o'chirish mantiqi. Ikkinchi yo'l ochilsa, rasmni o'chirish
 * ikki joyda ikki xil bo'lardi.
 *
 * ⚠️ EXIF VA GPS BU YERDA OLIB TASHLANADI, `image.service` da EMAS.
 * `uploadImageWithVariants` ASL faylni o'zgartirmasdan yuklaydi (shunday
 * bo'lishi kerak — do'kon rasmida metama'lumot zarar qilmaydi), avatar esa
 * telefonda olingan selfi bo'ladi va unda koordinata yotadi. Shuning uchun
 * bufer AVVAL shu yerda kvadrat 512 px WebP ga aylantiriladi va faqat
 * keyin yuklash servisiga beriladi.
 *
 * ⚠️ RASM VA TAYYOR AVATAR BIR-BIRINI ALMASHTIRADI: ikkisi birga turmaydi
 * (aks holda "qaysi biri ko'rinadi" degan savol har ekranda paydo
 * bo'lardi). Rasm yuklanganda `avatarPreset` tozalanadi va aksincha.
 */

const sharp = require("sharp");

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { runWithBranch } = require("../config/branchContext");
const branchService = require("./branch.service");
const { uploadImageWithVariants, deleteImageVariants } = require("./image.service");
const socialAccess = require("./socialAccess.service");
const pushService = require("./push.service");
const logger = require("../utils/logger");
const { ValidationError, NotFoundError, ForbiddenError } = require("../utils/errors");
const { AVATAR_SIZE, AVATAR_MAX_BYTES, KIND_RULES } = require("../helpers/socialMedia.helpers");
const { assertPreset, buildAvatar, USER_CARD_SELECT } = require("../helpers/socialAvatar.helpers");

const PROCESSED_MIME = "image/webp";

/* ───────────────────────── RASM YUKLASH ───────────────────────── */

/**
 * O'z rasmini yuklaydi.
 *
 * @param {{ actor: {id: string}, file: {buffer: Buffer, mimetype: string, size?: number} }} input
 * @returns {Promise<{avatar: object}>}
 */
async function uploadAvatar({ actor, file }) {
  if (!file?.buffer) throw new ValidationError("Rasm fayli talab qilinadi");
  if (!KIND_RULES.image.mimes.includes(String(file.mimetype || "").toLowerCase())) {
    throw new ValidationError("Rasm formati qo'llab-quvvatlanmaydi (jpeg / png / webp)");
  }
  if ((file.size || file.buffer.length) > AVATAR_MAX_BYTES) {
    throw new ValidationError(
      `Rasm hajmi ${Math.round(AVATAR_MAX_BYTES / (1024 * 1024))} MB dan oshmasligi kerak`,
    );
  }

  // ⚠️ KVADRAT `cover` BILAN: `inside` bo'lsa, uzun rasm doira ichida
  // ikki yonidan bo'sh joy bilan turardi. `withMetadata()` chaqirilmaydi —
  // shu bitta qarorda EXIF va GPS yo'qoladi.
  let processed;
  try {
    processed = await sharp(file.buffer, { failOnError: false })
      .rotate()
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover", position: "centre" })
      .toFormat("webp", { quality: 85 })
      .toBuffer();
  } catch (error) {
    throw new ValidationError(`Rasmni o'qib bo'lmadi: ${error.message}`);
  }

  const { home, user } = await loadHomeProfile(actor.id);

  const image = await runWithBranch(home, async () => {
    const { mimeType, extension, variants } = await uploadImageWithVariants({
      buffer: processed,
      mimeType: PROCESSED_MIME,
    });

    const created = await prisma.image.create({
      data: {
        originalName: `avatar.${extension}`,
        mimeType,
        extension,
        originalSizeBytes: processed.length,
        variants,
        uploadedBy: String(actor.id),
      },
    });

    await prisma.user.update({
      where: { id: String(actor.id) },
      data: { profilePicture: created.id },
    });

    // Eski rasm — yangisi yozilgandan KEYIN o'chiriladi: oraliqda yiqilsa
    // odam rasmsiz qolmasligi kerak (eski rasm hali ishlaydi).
    if (user.profilePicture) await dropImage(user.profilePicture);

    return created;
  });

  const url = pickSmallUrl(image.variants);
  const avatar = await writeDirectory(actor.id, { avatarUrl: url, avatarPreset: null });

  logger.info(`[avatar] rasm yuklandi: user=${actor.id}, image=${image.id}`);
  return { avatar };
}

/* ───────────────────────── TAYYOR AVATAR ───────────────────────── */

/**
 * Tayyor avatarni tanlaydi ("a07").
 *
 * ⚠️ RASM SERVERDA SAQLANMAYDI — faqat KOD. Rasmning o'zi `mbsi_social`
 * paketi ichida (`assets/avatars/a07.webp`), shuning uchun u tarmoqsiz ham
 * darhol chiziladi va yangi avatar qo'shish = paketning yangi versiyasi.
 * Noma'lum kod kelsa ilova bosh harflarni ko'rsatadi, ya'ni server
 * ro'yxatini kengaytirish eski ilovani SINDIRMAYDI.
 */
async function setPreset({ actor, preset }) {
  const code = assertPreset(preset);
  const { home, user } = await loadHomeProfile(actor.id);

  // Yuklangan rasm bo'lsa — o'chiriladi (ikkisi birga turmaydi).
  if (user.profilePicture) {
    await runWithBranch(home, async () => {
      await prisma.user.update({
        where: { id: String(actor.id) },
        data: { profilePicture: null },
      });
      await dropImage(user.profilePicture);
    });
  }

  const avatar = await writeDirectory(actor.id, { avatarUrl: null, avatarPreset: code });
  return { avatar };
}

/** Avatarni butunlay olib tashlaydi — bosh harflarga qaytadi. */
async function removeAvatar({ actor }) {
  const { home, user } = await loadHomeProfile(actor.id);

  if (user.profilePicture) {
    await runWithBranch(home, async () => {
      await prisma.user.update({
        where: { id: String(actor.id) },
        data: { profilePicture: null },
      });
      await dropImage(user.profilePicture);
    });
  }

  const avatar = await writeDirectory(actor.id, { avatarUrl: null, avatarPreset: null });
  return { avatar };
}

/**
 * MODERATOR nomaqbul rasmni olib tashlaydi (`stories.moderate`).
 *
 * ⚠️ EGASIGA PUSH KETADI: rasm jimgina yo'qolsa, odam buni tizim
 * nosozligi deb o'ylardi va qayta-qayta yuklab ko'rardi.
 */
async function removeByModerator({ actor, userId }) {
  if (!socialAccess.isStoryModerator(actor)) {
    throw new ForbiddenError("Bu amal uchun ruxsatingiz yo'q");
  }

  const target = String(userId);
  await removeAvatar({ actor: { id: target } });

  pushService.sendToUsers([target], {
    title: "Profil rasmingiz olib tashlandi",
    body: "Moderator profil rasmingizni olib tashladi",
    data: { type: "story", event: "avatar_removed" },
  });

  logger.info(`[avatar] moderator rasmni olib tashladi: user=${target}, actor=${actor.id}`);
  return { userId: target, removed: true };
}

/* ───────────────────────── BACKFILL (skript) ───────────────────────── */

/**
 * MAVJUD RASMLARNI PLATFORMAGA KO'CHIRADI (`npm run avatar:backfill`).
 *
 * Nima uchun kerak: premium o'quvchilarda allaqachon `profilePicture` bor,
 * lekin `user_directory.avatarUrl` bo'sh — ya'ni sinf guruhida ularning
 * rasmi ko'rinmasdi. Bu BIR MARTALIK amal.
 *
 * ⚠️ FILIAL KONTEKSTI ICHIDA chaqiriladi (`forEachBranch`).
 *
 * @returns {Promise<{scanned: number, written: number}>}
 */
async function backfillBranch() {
  const users = await prisma.user.findMany({
    where: { profilePicture: { not: null } },
    select: { id: true, profileImage: { select: { variants: true } } },
  });

  let written = 0;
  for (const user of users) {
    const url = pickSmallUrl(user.profileImage?.variants);
    if (!url) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await platformPrisma.userDirectory.update({
        where: { id: user.id },
        data: { avatarUrl: url },
      });
      written += 1;
    } catch (error) {
      // Katalogda qatori yo'q odam (eski ma'lumot) — jim o'tmaydi
      logger.warn(`[avatar] backfill: ${user.id} yozilmadi — ${error.message}`);
    }
  }

  return { scanned: users.length, written };
}

/* ───────────────────────────── YORDAMCHI ───────────────────────────── */

/**
 * UY FILIALI va o'sha filialdagi profil.
 *
 * ⚠️ NIMA UCHUN UY FILIALI: xodim bir nechta filialda ishlaydi va har
 * filialda O'Z `users` qatori bor. Rasm joriy filialga yozilsa, boshqa
 * filialning admin panelida eski rasm turib qolardi — ya'ni bir odamning
 * ikki rasmi bo'lardi. Uy filiali esa bitta va `user_directory` da
 * yozilgan.
 */
async function loadHomeProfile(userId) {
  const directory = await platformPrisma.userDirectory.findUnique({
    where: { id: String(userId) },
    select: { branchId: true },
  });
  if (!directory) throw new NotFoundError("Foydalanuvchi topilmadi");

  const home = await branchService.getUsableById(directory.branchId);
  if (!home) throw new NotFoundError("Uy filiali aniqlanmadi");

  const user = await runWithBranch(home, () =>
    prisma.user.findUnique({
      where: { id: String(userId) },
      select: { id: true, profilePicture: true },
    }),
  );
  if (!user) throw new NotFoundError("Foydalanuvchi profili topilmadi");

  return { home, user };
}

/** Eski rasmni (fayllar + qator) o'chiradi — xatosi yutiladi. */
async function dropImage(imageId) {
  try {
    const image = await prisma.image.findUnique({ where: { id: imageId } });
    if (!image) return;
    await deleteImageVariants(image.variants);
    await prisma.image.delete({ where: { id: image.id } });
  } catch (error) {
    logger.warn(`[avatar] eski rasmni o'chirishda xato: ${error.message}`);
  }
}

/** `sm` variantining havolasi (bo'lmasa — original). */
function pickSmallUrl(variants) {
  if (!variants) return null;
  return variants.sm?.url || variants.md?.url || variants.original?.url || null;
}

/** Platformadagi katalogga yozadi va yangi avatar blokini qaytaradi. */
async function writeDirectory(userId, data) {
  const row = await platformPrisma.userDirectory.update({
    where: { id: String(userId) },
    data,
    select: USER_CARD_SELECT,
  });
  return buildAvatar(row);
}

module.exports = {
  uploadAvatar,
  setPreset,
  removeAvatar,
  removeByModerator,
  backfillBranch,
  pickSmallUrl,
};
