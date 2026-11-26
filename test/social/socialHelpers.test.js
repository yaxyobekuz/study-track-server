const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * ISTORIYALAR VA CHAT — SOF QOIDALAR (bazasiz).
 *
 * Shu fayl modulning ARIFMETIKASINI qulflaydi: media chegaralari, avatar
 * kartochkasi, kunlik limitning TOSHKENT kuni chegarasi, push matni va
 * so'kinish filtri. Ularning hammasi sof funksiya, ya'ni test soxta baza
 * talab qilmaydi va tez ishlaydi.
 */

const {
  validateUploadRequest,
  assertActualMatchesDeclared,
  buildMediaKey,
  cleanText,
  KIND_RULES,
} = require("../../src/helpers/socialMedia.helpers");
const {
  buildAvatar,
  buildUserCard,
  avatarColor,
  avatarInitials,
  assertPreset,
  AVATAR_PRESETS,
} = require("../../src/helpers/socialAvatar.helpers");
const { containsProfanity } = require("../../src/helpers/profanity.helpers");
const {
  messagePreview,
  isQuietHours,
  chatMessagePush,
  chatReadPush,
  storyLikePush,
} = require("../../src/helpers/socialPush.helpers");
const { tashkentDayKey } = require("../../src/helpers/lessonHours");
const { tashkentDayEnd } = require("../../src/services/story.service");

const OWNER = "a".repeat(24);

/* ═══════════════════════════ MEDIA ═══════════════════════════ */

test("yuklash: rasm istoriyaga — normalizatsiya qilingan holda o'tadi", () => {
  const spec = validateUploadRequest(
    { kind: "image", mime: "IMAGE/JPEG", size: 500_000, width: 1080, height: 1920, purpose: "story" },
    { isStaff: true },
  );
  assert.equal(spec.mime, "image/jpeg");
  assert.equal(spec.extension, "jpg");
  assert.equal(spec.width, 1080);
  assert.equal(spec.durationMs, null);
});

test("yuklash: HEIC rad etiladi — xato YUKLASHDAN OLDIN beriladi", () => {
  assert.throws(
    () =>
      validateUploadRequest(
        { kind: "image", mime: "image/heic", size: 1000, purpose: "story" },
        { isStaff: true },
      ),
    /qo'llab-quvvatlanmaydi/,
  );
  assert.ok(!KIND_RULES.image.mimes.includes("image/heic"));
});

test("yuklash: o'quvchi VIDEO va FAYL yubormaydi, rasm va ovoz — yuboradi", () => {
  for (const kind of ["video", "file"]) {
    assert.throws(
      () =>
        validateUploadRequest(
          { kind, mime: kind === "video" ? "video/mp4" : "application/pdf", size: 1000, purpose: "chat" },
          { isStaff: false },
        ),
      /faqat xodimlar/,
    );
  }

  assert.doesNotThrow(() =>
    validateUploadRequest(
      { kind: "image", mime: "image/jpeg", size: 1000, purpose: "chat" },
      { isStaff: false },
    ),
  );
  assert.doesNotThrow(() =>
    validateUploadRequest(
      { kind: "voice", mime: "audio/m4a", size: 1000, purpose: "chat" },
      { isStaff: false },
    ),
  );
});

test("yuklash: tur va maqsad JUFTLIGI tekshiriladi (ovoz istoriyaga tushmaydi)", () => {
  assert.throws(
    () =>
      validateUploadRequest(
        { kind: "voice", mime: "audio/m4a", size: 1000, purpose: "story" },
        { isStaff: true },
      ),
    /bu bo'limga yuklanmaydi/,
  );
});

test("yuklash: hajm va davomiylik chegaralari", () => {
  assert.throws(
    () =>
      validateUploadRequest(
        { kind: "video", mime: "video/mp4", size: 30 * 1024 * 1024, purpose: "story" },
        { isStaff: true },
      ),
    /25 MB/,
  );
  assert.throws(
    () =>
      validateUploadRequest(
        { kind: "video", mime: "video/mp4", size: 1000, durationMs: 61_000, purpose: "story" },
        { isStaff: true },
      ),
    /60 sekund/,
  );
});

test("yuklash: avatar chegarasi rasm chegarasidan QATTIQROQ (5 MB)", () => {
  assert.throws(
    () =>
      validateUploadRequest(
        { kind: "image", mime: "image/jpeg", size: 8 * 1024 * 1024, purpose: "avatar" },
        { isStaff: true },
      ),
    /5 MB/,
  );
  // Istoriyada o'sha hajm o'tadi (10 MB chegarasi)
  assert.doesNotThrow(() =>
    validateUploadRequest(
      { kind: "image", mime: "image/jpeg", size: 8 * 1024 * 1024, purpose: "story" },
      { isStaff: true },
    ),
  );
});

test("haqiqiy fayl e'londan KATTA bo'lsa rad etiladi (presign himoyasi)", () => {
  const declared = { declaredMime: "image/jpeg", declaredSize: 1_000_000, kind: "image" };

  assert.doesNotThrow(() =>
    assertActualMatchesDeclared(declared, { size: 1_000_000, contentType: "image/jpeg" }),
  );
  // 10% zaxira ichida — o'tadi (qayta kodlash farqi)
  assert.doesNotThrow(() => assertActualMatchesDeclared(declared, { size: 1_050_000 }));
  // Zaxiradan tashqarida — rad
  assert.throws(
    () => assertActualMatchesDeclared(declared, { size: 5_000_000 }),
    /e'lon qilingan hajmdan katta/,
  );
  // Fayl umuman yuklanmagan
  assert.throws(() => assertActualMatchesDeclared(declared, { size: 0 }), /yuklanmagan/);
  // Boshqa format
  assert.throws(
    () => assertActualMatchesDeclared(declared, { size: 1000, contentType: "application/zip" }),
    /mos emas/,
  );
  // `application/octet-stream` — xato EMAS (ba'zi mijozlar shu bilan yuklaydi)
  assert.doesNotThrow(() =>
    assertActualMatchesDeclared(declared, { size: 1000, contentType: "application/octet-stream" }),
  );
});

test("media kaliti: kengaytma MIME dan, fayl nomidan EMAS", () => {
  const key = buildMediaKey({
    prefix: "social",
    ownerId: OWNER,
    id: "b".repeat(24),
    extension: "webp",
    at: new Date("2026-11-26T10:00:00Z"),
  });
  assert.equal(key, `social/${OWNER}/2026/11/${"b".repeat(24)}.webp`);

  const thumb = buildMediaKey({
    prefix: "social",
    ownerId: OWNER,
    id: "b".repeat(24),
    extension: "webp",
    at: new Date("2026-11-26T10:00:00Z"),
    variant: "t",
  });
  assert.ok(thumb.endsWith("_t.webp"));
});

test("matn: faqat bo'shliqdan iborat bo'lsa — bo'sh (null)", () => {
  assert.equal(cleanText("   ", 300), null);
  assert.equal(cleanText("  salom  ", 300), "salom");
  assert.equal(cleanText(null, 300), null);
  // NUL belgisi olib tashlanadi (PostgreSQL uni rad etadi)
  assert.equal(cleanText("a\u0000b", 300), "ab");
  assert.throws(() => cleanText("x".repeat(301), 300), /300 belgidan/);
});

/* ═══════════════════════════ AVATAR ═══════════════════════════ */

test("avatar: rang `userId` dan BARQAROR (bir odam — bir rang)", () => {
  const id = "6".repeat(24);
  assert.equal(avatarColor(id), avatarColor(id));
  assert.ok(avatarColor(id) >= 0 && avatarColor(id) < 8);
});

test("avatar: bosh harflar — familiyasiz ham bo'sh qolmaydi", () => {
  assert.equal(avatarInitials({ firstName: "Ali", lastName: "Valiyev" }), "AV");
  assert.equal(avatarInitials({ firstName: "Ali" }), "A");
  assert.equal(avatarInitials({}), "?");
});

test("avatar: kartochkada telefon va username YO'Q (o'quvchiga ham ko'rinadi)", () => {
  const card = buildUserCard({
    id: OWNER,
    firstName: "Ali",
    lastName: "Valiyev",
    role: "teacher",
    branchId: "c".repeat(24),
    phone: "+998901234567",
    username: "ali",
    avatarUrl: null,
    avatarPreset: "a07",
  });

  assert.equal(card.fullName, "Ali Valiyev");
  assert.equal(card.avatar.preset, "a07");
  assert.equal(card.avatar.initials, "AV");
  assert.ok(!("phone" in card));
  assert.ok(!("username" in card));
});

test("avatar: tayyor avatar kodi ro'yxatdan tashqarida bo'lsa rad etiladi", () => {
  assert.equal(assertPreset("A07"), "a07");
  assert.equal(AVATAR_PRESETS.length, 24);
  assert.throws(() => assertPreset("a99"), /noto'g'ri/);
  assert.throws(() => assertPreset(""), /noto'g'ri/);
});

test("avatar: url bo'lsa ham preset qaytadi — ilova ustunlikni o'zi hal qiladi", () => {
  const avatar = buildAvatar({ id: OWNER, firstName: "A", avatarUrl: "https://x/sm.webp", avatarPreset: null });
  assert.equal(avatar.url, "https://x/sm.webp");
  assert.equal(avatar.preset, null);
});

/* ═════════════════════ KUNLIK LIMIT CHEGARASI ═════════════════════ */

test("kunlik limit: TOSHKENT kuni chegarasi (23:59 / 00:01) UTC dan farq qiladi", () => {
  // 2026-11-26 23:59 Toshkent = 18:59 UTC
  const lateNight = new Date("2026-11-26T18:59:00Z");
  // 2026-11-27 00:01 Toshkent = 19:01 UTC (AVVALGI UTC kuni!)
  const justAfterMidnight = new Date("2026-11-26T19:01:00Z");

  assert.equal(tashkentDayKey(lateNight), "2026-11-26");
  assert.equal(tashkentDayKey(justAfterMidnight), "2026-11-27");

  // ⚠️ UTC bo'yicha olinsa IKKALASI ham "2026-11-26" bo'lardi — ya'ni
  // yarim tundan keyin qo'yilgan istoriya kechagi hisobga tushib, odamga
  // 4-chi imkon berib qo'yardi.
  assert.equal(lateNight.toISOString().slice(0, 10), justAfterMidnight.toISOString().slice(0, 10));
});

test("kunlik limit: `resetsAt` — kelgusi Toshkent yarim tuni", () => {
  const end = tashkentDayEnd(new Date("2026-11-26T18:59:00Z"));
  // 2026-11-27 00:00 Toshkent = 2026-11-26 19:00 UTC
  assert.equal(end.toISOString(), "2026-11-26T19:00:00.000Z");

  // Yarim tundan keyin — keyingi kunning oxiri
  const next = tashkentDayEnd(new Date("2026-11-26T19:01:00Z"));
  assert.equal(next.toISOString(), "2026-11-27T19:00:00.000Z");
  assert.ok(next > end);
});

/* ═══════════════════════════ PUSH ═══════════════════════════ */

test("push: matnsiz xabar media yorlig'i bilan ko'rinadi (ro'yxat bilan AYNI)", () => {
  assert.equal(messagePreview({ type: "image" }), "📷 Rasm");
  assert.equal(messagePreview({ type: "voice" }), "🎤 Ovozli xabar");
  assert.equal(messagePreview({ type: "text", text: "  salom\n dunyo " }), "salom dunyo");
  assert.equal(messagePreview({ type: "text", text: "x".repeat(200) }, 20).length, 20);
});

test("push: tungi sukunat 22:00–07:00 Toshkent bo'yicha", () => {
  assert.equal(isQuietHours(new Date("2026-11-26T17:30:00Z")), true); // 22:30
  assert.equal(isQuietHours(new Date("2026-11-26T01:30:00Z")), true); // 06:30
  assert.equal(isQuietHours(new Date("2026-11-26T05:00:00Z")), false); // 10:00
  assert.equal(isQuietHours(new Date("2026-11-26T16:30:00Z")), false); // 21:30
});

test("push: bildirishnomalar suhbat bo'yicha GURUHLANADI (tag = conversationId)", () => {
  const conversation = { id: "c".repeat(24), type: "class", title: "5-A" };
  const message = { id: "m".repeat(24), seq: 7, type: "text", text: "Uyga vazifa yo'q" };

  const push = chatMessagePush({ conversation, message, senderName: "Ali Valiyev" });
  assert.equal(push.tag, conversation.id);
  assert.equal(push.threadId, conversation.id);
  assert.equal(push.title, "5-A");
  // Guruhda kim yozgani ko'rinadi
  assert.ok(push.body.startsWith("Ali Valiyev: "));
  assert.deepEqual(push.data, {
    type: "chat",
    event: "message",
    conversationId: conversation.id,
    messageId: message.id,
    seq: 7,
  });

  // 1:1 da sarlavha — yuboruvchi, matnda ism takrorlanmaydi
  const direct = chatMessagePush({
    conversation: { id: "d".repeat(24), type: "direct" },
    message,
    senderName: "Ali Valiyev",
  });
  assert.equal(direct.title, "Ali Valiyev");
  assert.equal(direct.body, "Uyga vazifa yo'q");
});

test("push: boshqa qurilmada o'qilgani JIM ketadi", () => {
  const push = chatReadPush({ conversationId: "c".repeat(24), seq: 9 });
  assert.equal(push.silent, true);
  assert.equal(push.data.event, "read");
});

test("push: layk PAKETI — 'va yana N kishi'", () => {
  const one = storyLikePush({ storyId: "s".repeat(24), firstName: "Ali", othersCount: 0 });
  assert.ok(one.body.includes("Ali istoriyangizni"));
  const many = storyLikePush({ storyId: "s".repeat(24), firstName: "Ali", othersCount: 4 });
  assert.ok(many.body.includes("yana 4 kishi"));
});

/* ═══════════════════════ SO'KINISH FILTRI ═══════════════════════ */

test("so'kinish filtri: yozilish shaklini aylanib o'tib bo'lmaydi", () => {
  for (const text of ["sikma", "s1kma", "s.i.k.m.a", "Сука", "blyat", "jalab"]) {
    assert.equal(containsProfanity(text), true, text);
  }
});

test("so'kinish filtri: begunoh matn BELGILANMAYDI (soxta signal filtrni o'ldiradi)", () => {
  for (const text of [
    "Salom, qalaysiz?",
    "kotlet",
    "Onani chaqirdim",
    "matematika darsi",
    "assalomu alaykum",
    "mashina",
  ]) {
    assert.equal(containsProfanity(text), false, text);
  }
});
