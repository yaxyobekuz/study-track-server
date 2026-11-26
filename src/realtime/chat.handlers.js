/**
 * SOCKET HODISALARI — chat.
 *
 * ⚠️ MANTIQ YO'Q, FAQAT TARJIMA. Har bir handler `chat.service` ni
 * chaqiradi — REST yo'li bilan AYNI funksiyani. Socket uchun alohida
 * nusxa yozilsa, biriga qo'shilgan shart (e'lon rejimi, sekin rejim,
 * ovozsiz qilish, tezlik chegarasi) ikkinchisida tushib qolardi va
 * socket qoidani chetlab o'tish yo'li bo'lardi.
 *
 * ⚠️ HAR HODISA `ack` BILAN JAVOB BERADI (`{ ok, data | error }`): ilova
 * javobni kutadi va kelmasa REST ga o'tadi (`docs/social-api.md`).
 * Javobsiz hodisa bo'lsa, ilova xabarni "yuborildi" deb ko'rsatib,
 * aslida yo'qotgan bo'lardi.
 *
 * ⚠️ FILIAL KONTEKSTI HAR HODISADA KO'TARILADI (`runWithBranch`):
 * socket ulanishi HTTP so'rov emas, ya'ni `auth.middleware` ning
 * konteksti unga tarqalmaydi. Usiz birinchi `prisma` so'rovi "Filial
 * konteksti yo'q" xatosi bilan yiqilardi.
 */

const { runWithBranch } = require("../config/branchContext");
const chatService = require("../services/chat.service");
const chatAccess = require("../services/chatAccess.service");
const platformPrisma = require("../config/platformPrisma");
const emitter = require("./emitter");
const logger = require("../utils/logger");

/** "Yozmoqda" hodisasini qayta yuborish oynasi (ilovaga maslahat). */
const TYPING_TTL_SEC = 5;

/**
 * Hodisani xavfsiz bajaradi: xato bo'lsa `ack` ga kod bilan qaytadi.
 *
 * ⚠️ XATO SOCKETNI UZMAYDI: bitta yaroqsiz xabar butun ulanishni
 * yiqitsa, ilova qayta ulanib navbatini boshidan yuborardi.
 */
function handle(socket, name, fn) {
  socket.on(name, async (payload, ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    try {
      const data = await runWithBranch(socket.data.branch, () => fn(payload || {}));
      reply({ ok: true, data });
    } catch (error) {
      const status = error.statusCode || 500;
      if (status >= 500) {
        logger.error(`[socket] ${name} xatosi: ${error.message}`);
      }
      reply({
        ok: false,
        error: {
          message: error.message || "Xatolik",
          status,
          code: error.details?.code || null,
          details: error.details || null,
        },
      });
    }
  });
}

/**
 * @param {import("socket.io").Server} io
 * @param {import("socket.io").Socket} socket
 */
module.exports = function registerChatHandlers(io, socket) {
  const { user, isStaff } = socket.data;

  // XABAR YUBORISH — REST bilan AYNI funksiya.
  handle(socket, "message:send", async (payload) => {
    const { conversationId, ...body } = payload;
    return chatService.sendMessage({
      actor: user,
      conversationId,
      body,
      isStaff,
    });
  });

  // O'QILDI.
  handle(socket, "conversation:read", async (payload) =>
    chatService.markRead({ actor: user, id: payload.conversationId, seq: payload.seq }),
  );

  /**
   * "YOZMOQDA" — SAQLANMAYDI.
   *
   * ⚠️ Bazaga yozilsa, har tugma bosilishida `UPDATE` bo'lardi. Server
   * uni shunchaki uzatadi; `ttlSec` — ilovaga "shu vaqtdan keyin o'zi
   * o'chir" degan maslahat (server taymer yuritmaydi).
   */
  handle(socket, "typing", async (payload) => {
    const { conversation, member } = await chatAccess.assertMember(
      payload.conversationId,
      user,
    );
    if (!member) return { sent: false };

    const others = await platformPrisma.conversationMember.findMany({
      where: {
        conversationId: conversation.id,
        leftAt: null,
        userId: { not: String(user.id) },
      },
      select: { userId: true },
      take: 200,
    });

    emitter.emitToUsers(
      others.map((o) => o.userId),
      "typing",
      {
        conversationId: conversation.id,
        userId: String(user.id),
        isTyping: Boolean(payload.isTyping),
        ttlSec: TYPING_TTL_SEC,
      },
    );

    return { sent: true };
  });

  // BO'SHLIQNI TO'LDIRISH — ilova `seq` da uzilish ko'rsa.
  handle(socket, "messages:after", async (payload) =>
    chatService.listMessages({
      actor: user,
      id: payload.conversationId,
      afterSeq: payload.afterSeq,
      limit: payload.limit,
    }),
  );
};
