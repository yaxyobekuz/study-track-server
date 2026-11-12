const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * MAVZU QADAMI — "BITTA DARSDA NECHTA MAVZU" (biznes qarori, 2026-11-12).
 *
 * Qoida bitta jumlada:
 *
 *     Har dars mavzuni BITTAGA emas, QADAMGA suradi:
 *     dars i → [anchor + i×step … anchor + i×step + step − 1]
 *
 * Shu tufayli "o'quvchiga 3 qilib qo'ysa, bitta dars bo'lib o'tganda u
 * uchun 3 mavzu o'tilgan hisoblanadi".
 *
 * ⚠️ ENG MUHIM TEKSHIRUV: `step = 1` da natija AYNAN avvalgidek qoladi —
 * sinf yo'li (butun jadval, jurnal, sertifikat progressi) shu funksiyadan
 * o'qiydi va u o'zgarmasligi kerak.
 *
 * Sof funksiyalar — baza ham, soxta modul ham yo'q.
 */

const { topicOrdersForDays, lessonKey } = require("../src/helpers/lessonTopic");

// 2026-10-12 — dushanba. Hafta: 12(Du) 13(Se) 14(Cho) 15(Pa) 16(Ju) 17(Sha)
const WEEK = [
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-17",
];

/** Fandan dushanba 2-dars, chorshanba 4-dars, juma 1-dars. */
const ORDERS = new Map([
  [1, [2]], // dushanba
  [3, [4]], // chorshanba
  [5, [1]], // juma
]);

const always = () => true;
const at = (result, day, order) => result.get(lessonKey(day, order));

test("qadam 1 — avvalgi xatti-harakat AYNAN saqlanadi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 50 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
    step: 1,
  });

  assert.equal(at(result, "2026-10-12", 2).topicOrder, 50);
  assert.equal(at(result, "2026-10-14", 4).topicOrder, 51);
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 52);

  // Blokning oxiri — qadam 1 da boshi bilan AYNI
  assert.equal(at(result, "2026-10-12", 2).topicOrderTo, 50);
  assert.equal(at(result, "2026-10-16", 1).topicOrderTo, 52);
});

test("qadam 3 — har dars uchta mavzuni oladi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 50 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
    step: 3,
  });

  // 1-dars: 50,51,52
  assert.equal(at(result, "2026-10-12", 2).topicOrder, 50);
  assert.equal(at(result, "2026-10-12", 2).topicOrderTo, 52);
  // 2-dars: 53,54,55
  assert.equal(at(result, "2026-10-14", 4).topicOrder, 53);
  assert.equal(at(result, "2026-10-14", 4).topicOrderTo, 55);
  // 3-dars: 56,57,58
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 56);
  assert.equal(at(result, "2026-10-16", 1).topicOrderTo, 58);
});

test("qadam BAYRAMNI hisobga oladi — o'tilmagan dars mavzuni surmaydi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 10 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: (day) => day !== "2026-10-14", // chorshanba — bayram
    lastTopicOrder: 200,
    step: 2,
  });

  assert.equal(at(result, "2026-10-12", 2).topicOrder, 10);
  assert.equal(at(result, "2026-10-12", 2).topicOrderTo, 11);
  assert.equal(at(result, "2026-10-14", 4), undefined, "bayram kuni dars sanalmaydi");
  // Juma — ikkinchi o'tilgan dars: 12,13 (14,15 EMAS)
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 12);
  assert.equal(at(result, "2026-10-16", 1).topicOrderTo, 13);
});

test("blokning oxiri fanning OXIRGI mavzusidan oshmaydi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 49 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    // Fanda 50 ta mavzu bor: 1-dars 49,50 ni oladi, 51 YO'Q
    lastTopicOrder: 50,
    step: 3,
  });

  const first = at(result, "2026-10-12", 2);
  assert.equal(first.topicOrder, 49);
  assert.equal(first.topicOrderTo, 50, "yo'q mavzu 'o'tilgan' bo'lib ko'rinmaydi");

  // Keyingi dars — mavzular tugagan
  const second = at(result, "2026-10-14", 4);
  assert.equal(second.topicOrder, null);
  assert.equal(second.topicOrderTo, null);
  assert.match(second.reason, /tugagan/);
});

test("yaroqsiz qadam (0, manfiy, matn) 1 ga keltiriladi — sanoq muzlab qolmaydi", () => {
  for (const bad of [0, -5, null, undefined, "abc", 1.7]) {
    const result = topicOrdersForDays({
      anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 5 },
      ordersByDayNumber: ORDERS,
      targetDays: WEEK,
      isTeachingDay: always,
      lastTopicOrder: 200,
      step: bad,
    });
    assert.equal(at(result, "2026-10-12", 2).topicOrder, 5, `qadam = ${bad}`);
    // Hammasi 1 ga keltiriladi (1.7 ham — butun songa PASTGA): keyingi
    // dars 6-mavzuni ko'rsatadi, sanoq bir joyda qotib qolmaydi.
    assert.equal(
      at(result, "2026-10-14", 4).topicOrder,
      6,
      `qadam = ${bad}: sanoq bir joyda qotib qolmaydi`,
    );
  }
});

test("ankordan OLDINGI kunlar qadam bilan ham orqaga sanalmaydi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-14", lessonOrder: 4, topicOrder: 30 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
    step: 4,
  });

  const before = at(result, "2026-10-12", 2);
  assert.equal(before.topicOrder, null);
  assert.equal(before.topicOrderTo, null);
  assert.match(before.reason, /oldin/);

  assert.equal(at(result, "2026-10-14", 4).topicOrder, 30);
  assert.equal(at(result, "2026-10-14", 4).topicOrderTo, 33);
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 34);
});
