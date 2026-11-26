/**
 * ISTORIYA VA CHAT PUSH XABARLARI — matn va `data` BITTA joyda.
 *
 * `data` kalitlari MOBIL ILOVA BILAN SHARTNOMA (`docs/social-api.md`):
 * ilova `data.type` bo'yicha ekranni tanlaydi (`chat` → suhbat oynasi,
 * `story` → istoriya). Shu sababli ular service ichida qo'lda yig'ilmaydi —
 * `taskPush.helpers.js` / `parentalPush.helpers.js` bilan AYNI qoida.
 *
 * ⚠️ YANGI ISTORIYA HAQIDA PUSH YUBORILMAYDI (biznes qarori): 60 xodim
 * kuniga 3 ta qo'ysa, bu kuniga 180 bildirishnoma — hamma ilovani
 * o'chirib qo'yardi. Lentadagi halqa yetarli.
 *
 * ⚠️ LAYK PUSH'I PAKETLANADI (`storyLikeDigest.job.js`, 10 daqiqada bir):
 * har laykka alohida xabar yuborilsa, mashhur istoriya egasining telefoni
 * uzluksiz jiringlardi.
 */

const { PREVIEW_MAX } = require("./socialMedia.helpers");

/** Push `data.type` qiymatlari — ilova shunga qarab ekran tanlaydi. */
const PUSH_TYPES = Object.freeze({ CHAT: "chat", STORY: "story", REPORT: "report" });

/** Bildirishnomadagi matn uzunligi. */
const BODY_MAX = 100;

/**
 * TUNGI SUKUNAT oynasi (Toshkent): 22:00 dan 07:00 gacha.
 *
 * ⚠️ O'QUVCHI XABARI YUBORILADI, lekin push OVOZSIZ bo'ladi (biznes
 * qarori): yozishni butunlay yopish "uyga vazifa nima edi" degan savolni
 * ham yopardi, ovozli bildirishnoma esa yarim kechada butun sinfni
 * uyg'otardi. Xodim xabarlari odatdagidek — ma'muriyat ongli yuboradi.
 */
const QUIET_FROM_HOUR = 22;
const QUIET_TO_HOUR = 7;

/**
 * Toshkent devor-soati bo'yicha tungi sukunat vaqtimi.
 *
 * ⚠️ `getHours()` EMAS (u server mintaqasini o'qiydi): +5 qo'shib
 * `getUTCHours()` bilan olinadi — `tashkentDayKey` bilan AYNI usul
 * (`helpers/lessonHours.js`).
 *
 * @param {Date} [at]
 * @returns {boolean}
 */
function isQuietHours(at = new Date()) {
  const hour = new Date(at.getTime() + 5 * 3600000).getUTCHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_TO_HOUR;
}

/** Media turi uchun qisqa yorliq — matnsiz xabarda shu ko'rinadi. */
const MEDIA_LABELS = Object.freeze({
  image: "📷 Rasm",
  video: "🎥 Video",
  voice: "🎤 Ovozli xabar",
  file: "📎 Fayl",
  story_reply: "💬 Istoriyaga javob",
  system: "ℹ️ Ma'lumot",
});

/**
 * Xabarning bir qatorli ko'rinishi — bildirishnomada ham, suhbatlar
 * ro'yxatidagi `lastPreview` da ham AYNI funksiya ishlatiladi.
 *
 * ⚠️ IKKI JOYDA IKKI XIL BO'LMASLIGI KERAK: ro'yxatda "📷 Rasm" turib,
 * bildirishnomada bo'sh matn chiqsa, foydalanuvchi ikki xil haqiqat
 * ko'rardi.
 *
 * @param {{type: string, text?: string|null}} message
 * @param {number} [max]
 * @returns {string}
 */
function messagePreview(message, max = PREVIEW_MAX) {
  const text = String(message?.text || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  return MEDIA_LABELS[message?.type] || "Xabar";
}

/**
 * YANGI XABAR push'i.
 *
 * ⚠️ `tag` / `threadId` = `conversationId`: Android bildirishnomalarni shu
 * kalit bo'yicha GURUHLAYDI, iOS esa `thread-identifier` bilan. Usiz 20
 * xabarli suhbat 20 ta alohida bildirishnoma bo'lib, ekranni to'ldirardi.
 *
 * @param {{conversation: object, message: object, senderName: string}} input
 * @returns {{title: string, body: string, data: object, tag: string, threadId: string}}
 */
function chatMessagePush({ conversation, message, senderName }) {
  const isGroup = conversation.type !== "direct";
  const title = isGroup ? conversation.title || "Guruh" : senderName || "Yangi xabar";
  const preview = messagePreview(message, BODY_MAX);

  return {
    title,
    // Guruhda kim yozganini ko'rsatish kerak: "Matematika 5-A" sarlavhasi
    // ostida "Ali: bugun uyga vazifa yo'q".
    body: isGroup && senderName ? `${senderName}: ${preview}` : preview,
    data: {
      type: PUSH_TYPES.CHAT,
      event: "message",
      conversationId: conversation.id,
      messageId: message.id,
      seq: message.seq,
    },
    tag: conversation.id,
    threadId: conversation.id,
  };
}

/**
 * «BOSHQA QURILMADA O'QILDI» — jim xabar.
 *
 * Nima uchun kerak: odam planshetda o'qisa, telefondagi bildirishnoma
 * o'zi yo'qolishi kerak. Busiz "o'qilmagan 3 xabar" belgisi hech qachon
 * tozalanmasdi.
 */
function chatReadPush({ conversationId, seq }) {
  return {
    silent: true,
    data: {
      type: PUSH_TYPES.CHAT,
      event: "read",
      conversationId,
      seq,
    },
    tag: conversationId,
    threadId: conversationId,
  };
}

/** Istoriyaga IZOH — har izohga (muallifga). */
function storyCommentPush({ storyId, authorName, text }) {
  return {
    title: "Istoriyangizga izoh",
    body: `${authorName}: ${messagePreview({ type: "text", text }, BODY_MAX)}`,
    data: { type: PUSH_TYPES.STORY, event: "comment", storyId },
    tag: `story:${storyId}`,
    threadId: `story:${storyId}`,
  };
}

/**
 * Istoriyaga LAYK — PAKET ("Ali va yana 4 kishi").
 *
 * @param {{storyId: string, firstName: string, othersCount: number}} input
 */
function storyLikePush({ storyId, firstName, othersCount }) {
  const body =
    othersCount > 0
      ? `${firstName} va yana ${othersCount} kishi istoriyangizni yoqtirdi`
      : `${firstName} istoriyangizni yoqtirdi`;

  return {
    title: "Yangi layk",
    body,
    data: { type: PUSH_TYPES.STORY, event: "like", storyId },
    tag: `story:${storyId}`,
    threadId: `story:${storyId}`,
  };
}

/** SHIKOYAT — moderatorlarga. */
function reportPush({ targetType, targetId }) {
  const label =
    { story: "istoriya", story_comment: "izoh", message: "xabar" }[targetType] || "kontent";
  return {
    title: "Yangi shikoyat",
    body: `Ko'rib chiqish kerak: ${label}`,
    data: { type: PUSH_TYPES.REPORT, event: "new", targetType, targetId },
  };
}

module.exports = {
  PUSH_TYPES,
  BODY_MAX,
  MEDIA_LABELS,
  QUIET_FROM_HOUR,
  QUIET_TO_HOUR,
  isQuietHours,
  messagePreview,
  chatMessagePush,
  chatReadPush,
  storyCommentPush,
  storyLikePush,
  reportPush,
};
