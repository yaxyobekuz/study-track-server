const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * OTA-ONA NAZORATI — "BU HODISA OTA-ONAGA PUSH BO'LADIMI" (TZ §8).
 *
 * `shouldAlert` HAQIQIY kodi ishlaydi, hodisalar jadvali — xotiradagi soxta
 * tranzaksiya. Qoida natija bilan tekshiriladi: qaysi hodisa push bo'ldi.
 */

function fakeModule(request, exports) {
  const path = require.resolve(request);
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

// push.service → platforma bazasi; bu testda push yuborilmaydi
fakeModule("../src/config/platformPrisma", {});

const { _shouldAlert: shouldAlert, _tashkentDayStart } = require(
  "../src/services/parentalEvent.service",
);

const STUDENT = "s".repeat(24);
const PHONE = "phone-aaaaaaaaaaaaaaaa";
const TABLET = "tablet-bbbbbbbbbbbbbbb";
const MIN = 60 * 1000;

let events = [];

function matches(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
      if ("in" in cond && !cond.in.includes(value)) return false;
      if ("gte" in cond && !(value >= cond.gte)) return false;
      return true;
    }
    return value === cond;
  });
}

const tx = {
  parentalEvent: {
    findFirst: async ({ where }) =>
      events
        .filter((e) => matches(e, where))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null,
    count: async ({ where }) => events.filter((e) => matches(e, where)).length,
  },
};

/** Oldingi hodisa — `agoMs` oldin yozilgan. */
const past = (type, agoMs, extra = {}) => ({
  studentId: STUDENT,
  deviceId: PHONE,
  type,
  alerted: true,
  createdAt: new Date(Date.now() - agoMs),
  ...extra,
});

const ask = (type, extra = {}) =>
  shouldAlert(tx, { studentId: STUDENT, deviceId: PHONE, type, ...extra });

/* ───────────────────────── Himoya jufti ───────────────────────── */

test("ruxsat olib tashlandi: birinchisi push, 1 soat ichidagi takrori — yo'q, soatdan keyin — yana push", async () => {
  events = [];
  assert.equal(await ask("permission_revoked"), true);

  events = [past("permission_revoked", 10 * MIN)];
  assert.equal(await ask("permission_revoked"), false);

  events = [past("permission_revoked", 61 * MIN)];
  assert.equal(await ask("permission_revoked"), true);

  // Boshqa qurilmaning cheklovi bu qurilmaga ta'sir qilmaydi
  events = [past("permission_revoked", 10 * MIN, { deviceId: TABLET })];
  assert.equal(await ask("permission_revoked"), true);
});

test("o'chir → yoq → yana o'chir: ota-ona eskirgan 'tiklandi' xabari bilan QOLMAYDI", async () => {
  events = [past("permission_revoked", 20 * MIN), past("protection_restored", 10 * MIN)];
  assert.equal(await ask("permission_revoked"), true, "soat kutilmaydi");
});

test("himoya tiklandi: faqat oldingi push 'o'chirildi' bo'lsa", async () => {
  events = [];
  assert.equal(await ask("protection_restored"), false, "birinchi sozlash — xabar yo'q");

  events = [past("permission_revoked", 5 * MIN)];
  assert.equal(await ask("protection_restored"), true);

  events = [past("permission_revoked", 20 * MIN), past("protection_restored", 10 * MIN)];
  assert.equal(await ask("protection_restored"), false, "ikki marta 'tiklandi' yo'q");

  // Push bo'lmagan (cheklangan) 'o'chirildi' juftni buzmaydi
  events = [
    past("permission_revoked", 20 * MIN),
    past("permission_revoked", 5 * MIN, { alerted: false }),
  ];
  assert.equal(await ask("protection_restored"), true);
});

/* ───────────────────────── O'chirishga urinish ───────────────────────── */

test("ilovani o'chirishga urinish: qurilma bo'yicha 10 daqiqada 1 marta", async () => {
  events = [past("uninstall_attempt", 5 * MIN)];
  assert.equal(await ask("uninstall_attempt"), false);

  events = [past("uninstall_attempt", 11 * MIN)];
  assert.equal(await ask("uninstall_attempt"), true);

  events = [past("uninstall_attempt", 5 * MIN, { deviceId: TABLET })];
  assert.equal(await ask("uninstall_attempt"), true);
});

/* ───────────────────────── Noto'g'ri PIN ───────────────────────── */

test("noto'g'ri PIN (server): 3-xatodan boshlab, kuniga ko'pi bilan 3 marta", async () => {
  events = [];
  assert.equal(await ask("wrong_pin", { attempts: 2 }), false);
  assert.equal(await ask("wrong_pin", { attempts: 3 }), true);

  const dayStart = _tashkentDayStart();
  const today = (n) =>
    Array.from({ length: n }, (_, i) =>
      past("wrong_pin", 0, { createdAt: new Date(dayStart.getTime() + (i + 1) * 1000), deviceId: null }),
    );

  events = today(3);
  assert.equal(await ask("wrong_pin", { attempts: 7 }), false, "bugungi limit tugagan");

  // Kechagi push'lar sanalmaydi
  events = today(2).concat(
    past("wrong_pin", 0, { createdAt: new Date(dayStart.getTime() - 60 * MIN) }),
    past("wrong_pin", 0, { createdAt: new Date(dayStart.getTime() - 30 * MIN) }),
  );
  assert.equal(await ask("wrong_pin", { attempts: 5 }), true);
});

test("noto'g'ri PIN (qurilma): shu qurilmaning bugungi 3-xatosidan boshlab", async () => {
  const dayStart = _tashkentDayStart();
  const at = (s) => new Date(dayStart.getTime() + s * 1000);

  events = [past("wrong_pin", 0, { alerted: false, createdAt: at(1) })];
  assert.equal(await ask("wrong_pin"), false, "bu 2-xato");

  events.push(past("wrong_pin", 0, { alerted: false, createdAt: at(2) }));
  assert.equal(await ask("wrong_pin"), true, "bu 3-xato");
});

/* ───────────────────────── Qolganlari ───────────────────────── */

test("oflayn va PIN tiklash — har doim push; 'ochildi' va boshqalar — faqat tarix", async () => {
  events = [];
  assert.equal(await ask("offline"), true);
  assert.equal(await ask("pin_reset"), true);
  assert.equal(await ask("unlocked"), false);
  assert.equal(await ask("unlock_request"), false);
  assert.equal(await ask("pin_changed"), false);
});
