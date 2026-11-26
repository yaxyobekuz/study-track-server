const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * CHAT DARVOZALARI — `chatAccess.service` HAQIQIY kodi, baza xotirada.
 *
 * Modulning eng xavfli teshigi: `conversationId` ni almashtirib boshqa
 * suhbatni o'qib olish. Shu sababli birinchi test aynan shu haqda.
 *
 * Qolgan to'rtta to'siq ham tekshiriladi va ularning TARTIBI muhim:
 * avval SUHBAT holati (yopilgan), keyin SHAXSIY taqiq — aks holda
 * yopilgan guruhda ovozsiz qilingan o'quvchi noto'g'ri sababni ko'rardi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const CONV = "1".repeat(24);
const OTHER_CONV = "2".repeat(24);
const STAFF = "a".repeat(24);
const STUDENT = "b".repeat(24);
const OUTSIDER = "c".repeat(24);

let db;

const resetDb = () => {
  db = {
    conversations: [
      {
        id: CONV,
        type: "class",
        onlyStaffPost: false,
        slowModeSec: 0,
        closedAt: null,
        lastSeq: 5,
        title: "5-A",
      },
      { id: OTHER_CONV, type: "group", onlyStaffPost: false, slowModeSec: 0, closedAt: null, lastSeq: 1 },
    ],
    members: [
      { conversationId: CONV, userId: STAFF, role: "admin", leftAt: null, lastReadSeq: 5, clearedSeq: 0 },
      {
        conversationId: CONV,
        userId: STUDENT,
        role: "member",
        leftAt: null,
        lastReadSeq: 0,
        clearedSeq: 0,
        postBannedUntil: null,
        postBanReason: null,
      },
    ],
    messages: [],
  };
};

fakeModule("../../src/config/platformPrisma", {
  conversation: {
    findUnique: async ({ where }) => db.conversations.find((c) => c.id === where.id) || null,
  },
  conversationMember: {
    findUnique: async ({ where }) => {
      const key = where.conversationId_userId;
      return (
        db.members.find((m) => m.conversationId === key.conversationId && m.userId === key.userId) ||
        null
      );
    },
  },
  message: {
    findFirst: async ({ where }) =>
      db.messages
        .filter((m) => m.conversationId === where.conversationId && m.senderId === where.senderId)
        .sort((a, b) => b.createdAt - a.createdAt)[0] || null,
  },
});

const chatAccess = require("../../src/services/chatAccess.service");

const staffUser = { id: STAFF, role: "teacher", permissions: [] };
const studentUser = { id: STUDENT, role: "student", permissions: [] };
const outsiderUser = { id: OUTSIDER, role: "teacher", permissions: [] };
const moderator = { id: OUTSIDER, role: "teacher", permissions: ["chat.moderate"] };

test.beforeEach(() => {
  resetDb();
  chatAccess.resetRateLimits();
});

/* ═════════════════════════ A'ZOLIK ═════════════════════════ */

test("a'zo bo'lmagan odam suhbatni O'QIY OLMAYDI (403, 404 emas)", async () => {
  await assert.rejects(() => chatAccess.assertMember(CONV, outsiderUser), (error) => {
    assert.equal(error.statusCode, 403);
    assert.equal(error.details.code, "NOT_MEMBER");
    return true;
  });
});

test("`conversationId` ni almashtirib boshqa suhbatga kirib bo'lmaydi", async () => {
  // O'quvchi O'Z guruhida a'zo, lekin xodimlar guruhida — yo'q
  await assert.doesNotReject(() => chatAccess.assertMember(CONV, studentUser));
  await assert.rejects(() => chatAccess.assertMember(OTHER_CONV, studentUser), /a'zosi emassiz/);
});

test("guruhdan chiqqan a'zo (leftAt) endi a'zo emas", async () => {
  db.members.find((m) => m.userId === STUDENT).leftAt = new Date();
  await assert.rejects(() => chatAccess.assertMember(CONV, studentUser), /a'zosi emassiz/);
});

test("moderator a'zo bo'lmasa ham ko'radi — lekin faqat ruxsat berilsa", async () => {
  const result = await chatAccess.assertMember(CONV, moderator, { allowModerator: true });
  assert.equal(result.member, null);
  assert.equal(result.isModerator, true);

  // Ruxsat berilmagan yo'lda moderator ham to'siladi
  await assert.rejects(() => chatAccess.assertMember(CONV, moderator), /a'zosi emassiz/);
  // Ruxsat kaliti yo'q odam `allowModerator` bilan ham o'tmaydi
  await assert.rejects(
    () => chatAccess.assertMember(CONV, outsiderUser, { allowModerator: true }),
    /a'zosi emassiz/,
  );
});

test("suhbat umuman yo'q bo'lsa — 404", async () => {
  await assert.rejects(() => chatAccess.assertMember("9".repeat(24), staffUser), /topilmadi/);
});

/* ═════════════════════════ YOZISH ═════════════════════════ */

const postAs = async (user, isStaff) => {
  const { conversation, member } = await chatAccess.assertMember(CONV, user);
  return chatAccess.assertCanPost({ conversation, member, user, isStaff });
};

test("odatiy holatda ikkalasi ham yozadi", async () => {
  await assert.doesNotReject(() => postAs(staffUser, true));
  await assert.doesNotReject(() => postAs(studentUser, false));
});

test("e'lon rejimi: o'quvchi yozmaydi, ustoz yozadi", async () => {
  db.conversations[0].onlyStaffPost = true;

  await assert.rejects(() => postAs(studentUser, false), (error) => {
    assert.equal(error.details.code, "ONLY_STAFF_POST");
    return true;
  });
  await assert.doesNotReject(() => postAs(staffUser, true));
});

test("ovozsiz qilingan o'quvchi yozmaydi; muddat o'tsa yana yozadi", async () => {
  const member = db.members.find((m) => m.userId === STUDENT);
  member.postBannedUntil = new Date(Date.now() + 3600_000);
  member.postBanReason = "Haqorat";

  await assert.rejects(() => postAs(studentUser, false), (error) => {
    assert.equal(error.details.code, "POST_BANNED");
    assert.equal(error.details.reason, "Haqorat");
    assert.ok(error.details.until);
    return true;
  });

  member.postBannedUntil = new Date(Date.now() - 1000);
  await assert.doesNotReject(() => postAs(studentUser, false));
});

test("YOPILGAN SUHBAT shaxsiy taqiqdan OLDIN tekshiriladi (sabab aralashmaydi)", async () => {
  db.conversations[0].closedAt = new Date();
  const member = db.members.find((m) => m.userId === STUDENT);
  member.postBannedUntil = new Date(Date.now() + 3600_000);
  member.postBanReason = "Haqorat";

  await assert.rejects(() => postAs(studentUser, false), (error) => {
    // ⚠️ "Siz 18:00 gacha yoza olmaysiz" EMAS: guruh butunlay yopilgan
    assert.equal(error.details.code, "CONVERSATION_CLOSED");
    return true;
  });

  // Yopilgan suhbatda XODIM ham yozmaydi
  await assert.rejects(() => postAs(staffUser, true), (error) => {
    assert.equal(error.details.code, "CONVERSATION_CLOSED");
    return true;
  });
});

test("sekin rejim faqat O'QUVCHIGA ta'sir qiladi", async () => {
  db.conversations[0].slowModeSec = 30;
  db.messages.push({
    conversationId: CONV,
    senderId: STUDENT,
    createdAt: new Date(Date.now() - 5000),
  });

  await assert.rejects(() => postAs(studentUser, false), (error) => {
    assert.equal(error.details.code, "SLOW_MODE");
    assert.ok(error.details.waitSec > 0 && error.details.waitSec <= 30);
    return true;
  });

  // Ustoz uchun sekin rejim yo'q
  db.messages.push({ conversationId: CONV, senderId: STAFF, createdAt: new Date() });
  await assert.doesNotReject(() => postAs(staffUser, true));
});

test("tezlik chegarasi: o'quvchi 10, xodim 30 xabar/daqiqa", async () => {
  for (let i = 0; i < chatAccess.RATE_STUDENT; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await postAs(studentUser, false);
  }
  await assert.rejects(() => postAs(studentUser, false), (error) => {
    assert.equal(error.statusCode, 429);
    assert.equal(error.details.code, "RATE_LIMITED");
    assert.equal(error.details.limit, chatAccess.RATE_STUDENT);
    return true;
  });

  // Xodimning chegarasi boshqa — o'quvchining hisobi unga ta'sir qilmaydi
  for (let i = 0; i < chatAccess.RATE_STAFF; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await postAs(staffUser, true);
  }
  await assert.rejects(() => postAs(staffUser, true), /Juda ko'p xabar/);
});

/* ═════════════════════════ BOSHQARISH ═════════════════════════ */

test("sinf guruhida a'zolik QO'LDA o'zgarmaydi", () => {
  assert.throws(
    () => chatAccess.assertMembershipEditable(db.conversations[0]),
    (error) => {
      assert.equal(error.details.code, "CLASS_GROUP_IMMUTABLE");
      return true;
    },
  );
  // Xodimlar guruhida — mumkin
  assert.doesNotThrow(() => chatAccess.assertMembershipEditable(db.conversations[1]));
});

test("sinf guruhini sozlash: ustoz (admin) mumkin, o'quvchi — yo'q", async () => {
  const staff = await chatAccess.assertMember(CONV, staffUser);
  assert.doesNotThrow(() =>
    chatAccess.assertCanManage({ ...staff, user: staffUser }),
  );

  const student = await chatAccess.assertMember(CONV, studentUser);
  assert.throws(
    () => chatAccess.assertCanManage({ ...student, user: studentUser }),
    /huquqi sizda yo'q/,
  );
});
