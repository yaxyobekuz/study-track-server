/**
 * SOCKET.IO SERVERI — real vaqtli chat va istoriya hodisalari.
 *
 * ⚠️ XUDDI SHU NODE JARAYONIDA, alohida xizmat EMAS: alohida bo'lsa,
 * tokenni tekshirish, filial kontekstini ko'tarish va `chat.service` ni
 * chaqirish uchun ikkinchi nusxa kerak bo'lardi — ya'ni butun qoida
 * to'plami ikki joyda yashardi.
 *
 * ⚠️ SOCKET — TEZLATGICH, HAQIQAT MANBAI EMAS. Hodisa yo'qolishi mumkin
 * (fon rejimi, tarmoq), shuning uchun ilova qayta ulanganda
 * `GET /api/chat/sync` ni MAJBURIY chaqiradi (`docs/social-api.md`).
 * Shu qaror tufayli socket'ning ishonchliligi uchun kurashish kerak emas.
 *
 * ⚠️ XONA — `user:<id>`, suhbat xonasi EMAS (izoh `emitter.js` da).
 *
 * ⚠️ `maxHttpBufferSize` KICHIK (100 KB): fayl socket orqali KELMAYDI,
 * u Spaces'ga to'g'ridan-to'g'ri yuklanadi (`mediaUpload.service.js`).
 * Katta bufer ruxsat etilsa, socket faylni xotiraga oladigan ikkinchi
 * yuklash yo'liga aylanib qolardi.
 *
 * ⚠️ SEANS TIRIKLIGI DAVRIY TEKSHIRILADI. HTTP so'rovda buni
 * `auth.middleware` qiladi, socket esa soatlab ochiq turadi: "seansni
 * tugat" tugmasi bosilganda ulanish ham uzilishi kerak, aks holda
 * xabarlar o'sha telefonga kelishda davom etardi.
 */

const { Server } = require("socket.io");

const prisma = require("../config/prisma");
const platformPrisma = require("../config/platformPrisma");
const { runWithBranch } = require("../config/branchContext");
const branchService = require("../services/branch.service");
const securityService = require("../services/security.service");
const socialAccess = require("../services/socialAccess.service");
const { verifyToken, isAggregateToken } = require("../utils/jwt");
const { config } = require("../config/env.config");
const logger = require("../utils/logger");
const emitter = require("./emitter");
const registerChatHandlers = require("./chat.handlers");

/** Bir IP'dan daqiqada ruxsat etilgan ulanish soni. */
const HANDSHAKE_LIMIT = 20;
const HANDSHAKE_WINDOW_MS = 60_000;
const handshakeBuckets = new Map();

/** Seanslarni qayta tekshirish davri. */
const SESSION_RECHECK_MS = 60_000;

let io = null;
let recheckTimer = null;

/**
 * Socket serverini HTTP server ustiga o'rnatadi.
 *
 * @param {import("http").Server} httpServer
 * @returns {Promise<import("socket.io").Server>}
 */
async function initSocket(httpServer) {
  io = new Server(httpServer, {
    // ⚠️ FAQAT WEBSOCKET: polling bilan sticky session kerak bo'ladi
    // (bir nechta nusxada so'rovlar bir xil jarayonga tushishi shart),
    // u esa load balancer sozlamasiga bog'liq. WebSocket bitta uzluksiz
    // ulanish — muammo tug'ilmaydi.
    transports: ["websocket"],
    maxHttpBufferSize: 1e5,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    cors:
      config.corsOrigins.length > 0
        ? { origin: config.corsOrigins, credentials: true }
        : { origin: "*" },
  });

  await attachRedisAdapter();

  io.use(handshakeRateLimit);
  io.use(authenticate);

  io.on("connection", (socket) => {
    const { userId } = socket.data;
    socket.join(`user:${userId}`);

    registerChatHandlers(io, socket);

    socket.on("disconnect", () => {
      broadcastPresence(socket, false).catch(() => {});
    });

    broadcastPresence(socket, true).catch(() => {});
  });

  emitter.register(io, logger);
  startSessionRecheck();

  logger.info("[socket] Socket.IO ishga tushdi");
  return io;
}

/**
 * BIR NECHTA NUSXA (PM2 cluster) — Redis adapter.
 *
 * ⚠️ `REDIS_URL` BERILMASA bitta nusxa rejimi va bu NORMAL hol. Lekin
 * ikki nusxa bo'lib URL berilmasa, bir nusxadagi xabar boshqa nusxaga
 * ulangan odamga YETMAYDI — shuning uchun paket yo'q bo'lsa ham server
 * jim qolmaydi, OGOHLANTIRADI va ishlashda davom etadi (push va `sync`
 * baribir xabarni yetkazadi).
 */
async function attachRedisAdapter() {
  if (!config.redisUrl) return;

  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { createAdapter } = require("@socket.io/redis-adapter");
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const { createClient } = require("redis");

    const pubClient = createClient({ url: config.redisUrl });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    logger.info("[socket] Redis adapter yoqildi");
  } catch (error) {
    logger.error(
      `[socket] Redis adapter yoqilmadi (${error.message}). Bir nechta nusxada ` +
        "xabarlar nusxalar orasida tarqalmaydi — @socket.io/redis-adapter va redis " +
        "paketlarini o'rnating yoki REDIS_URL ni bo'sh qoldiring.",
    );
  }
}

/* ────────────────────────── HANDSHAKE ────────────────────────── */

/** Bir IP'dan ko'p ulanishni cheklaydi. */
function handshakeRateLimit(socket, next) {
  const ip = socket.handshake.address || "unknown";
  const now = Date.now();
  const bucket = (handshakeBuckets.get(ip) || []).filter((t) => now - t < HANDSHAKE_WINDOW_MS);

  if (bucket.length >= HANDSHAKE_LIMIT) {
    return next(new Error("too_many_connections"));
  }

  bucket.push(now);
  handshakeBuckets.set(ip, bucket);
  if (handshakeBuckets.size > 5000) handshakeBuckets.clear();
  return next();
}

/**
 * TOKEN TEKSHIRUVI — `auth.middleware` bilan AYNI qoidalar.
 *
 * ⚠️ UMUMIY KO'RINISH TOKENI (`scope: "all"`) RAD ETILADI: unda filial
 * yo'q va u har so'rovda dispatcher orqali hal qilinadi — socket esa
 * uzluksiz ulanish, ya'ni "qaysi filial" degan savol javobsiz qolardi.
 * Bunday token bilan kelgan panel oddiy tokenga o'tib qayta ulanadi.
 */
async function authenticate(socket, next) {
  try {
    const token =
      socket.handshake.auth?.token ||
      String(socket.handshake.headers?.authorization || "").replace(/^Bearer\s+/i, "");

    const decoded = verifyToken(token);
    if (!decoded) return next(new Error("unauthorized"));
    if (isAggregateToken(decoded)) return next(new Error("aggregate_token_not_supported"));

    let channel = null;
    if (decoded.jti) {
      const { alive, channel: sessionChannel } = await securityService.touchSessionState(
        decoded.jti,
      );
      if (!alive) return next(new Error("session_ended"));
      channel = sessionChannel;
    }

    const branch = decoded.branchId
      ? await branchService.getUsableById(decoded.branchId)
      : await branchService.getDefaultBranch();
    if (!branch) return next(new Error("branch_not_found"));

    const user = await runWithBranch(branch, () =>
      prisma.user.findUnique({
        where: { id: decoded.id },
        omit: { password: true, plainPassword: true },
      }),
    );
    if (!user) return next(new Error("user_not_found"));
    if (!user.isActive || user.isArchived) return next(new Error("account_disabled"));

    // ⚠️ OTA-ONA KANALI RAD ETILADI: ota-ona ilovasi o'quvchi hisobi bilan
    // kiradi va unga chat ham, istoriya ham ko'rinmaydi
    // (`socialAccess.service.js`).
    if (channel === "parent") return next(new Error("parent_channel_not_supported"));

    socket.data = {
      userId: String(user.id),
      jti: decoded.jti || null,
      branch,
      branchId: branch.id,
      role: user.role,
      isStaff: socialAccess.isStaff(user),
      user,
      channel,
    };

    return next();
  } catch (error) {
    logger.warn(`[socket] handshake xatosi: ${error.message}`);
    return next(new Error("handshake_failed"));
  }
}

/* ────────────────────────── ONLAYN HOLAT ────────────────────────── */

/**
 * Suhbatdoshlarga onlayn/oflayn holatini yuboradi.
 *
 * ⚠️ FAQAT 1:1 SHERIKLARGA: 200 kishilik guruhda har ulanish 200 ta
 * hodisa bo'lardi va onlayn nuqta hech kimga kerak bo'lmagan joyda
 * tarmoqni yeb qo'yardi. 1:1 da esa u aynan kerakli ma'lumot.
 */
async function broadcastPresence(socket, online) {
  const { userId } = socket.data;

  // Oflayn deb e'lon qilishdan OLDIN: boshqa qurilma hali ulangan
  // bo'lishi mumkin (telefon + planshet).
  if (!online && (await emitter.isOnline(userId))) return;

  const memberships = await platformPrisma.conversationMember.findMany({
    where: { userId, leftAt: null, conversation: { type: "direct" } },
    select: { conversationId: true },
    take: 300,
  });
  if (memberships.length === 0) return;

  const partners = await platformPrisma.conversationMember.findMany({
    where: {
      conversationId: { in: memberships.map((m) => m.conversationId) },
      userId: { not: userId },
      leftAt: null,
    },
    select: { userId: true },
  });

  emitter.emitToUsers(
    partners.map((p) => p.userId),
    "presence",
    { userId, online, lastSeenAt: new Date().toISOString() },
  );
}

/* ──────────────────── SEANSNI QAYTA TEKSHIRISH ──────────────────── */

/**
 * Yopilgan seansli socketlarni uzadi.
 *
 * ⚠️ NIMA UCHUN TAYMER: socket soatlab ochiq turadi va `auth.middleware`
 * unga tegmaydi. "Seansni tugat" bosilganda yoki hisob arxivlanganda
 * ulanish uzilishi kerak — aks holda xabarlar o'sha telefonga kelishda
 * davom etardi.
 */
function startSessionRecheck() {
  if (recheckTimer) clearInterval(recheckTimer);

  recheckTimer = setInterval(async () => {
    try {
      const sockets = await io.fetchSockets();
      for (const socket of sockets) {
        const { jti } = socket.data || {};
        if (!jti) continue;
        // eslint-disable-next-line no-await-in-loop
        const { alive } = await securityService.touchSessionState(jti);
        if (!alive) socket.disconnect(true);
      }
    } catch (error) {
      logger.warn(`[socket] seanslarni tekshirishda xato: ${error.message}`);
    }
  }, SESSION_RECHECK_MS);

  recheckTimer.unref?.();
}

/** Graceful shutdown. */
async function closeSocket() {
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
  emitter.unregister();
  if (!io) return;
  await new Promise((resolve) => io.close(resolve));
  io = null;
}

const getIo = () => io;

module.exports = { initSocket, closeSocket, getIo };
