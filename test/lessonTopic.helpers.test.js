const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * DARS MAVZUSI — ANKORDAN SANOQ.
 *
 * Bu sanoq jadvalda ko'rinadigan mavzuni ham, bahoga yoziladigan mavzuni ham
 * beradi (`lessonTopic.service.js`). Ikkalasi bitta funksiyadan o'qiydi, ya'ni
 * bu yerdagi har bir holat ikkala ekranni birdan himoya qiladi.
 */

const {
  TOPIC_MISS_REASONS,
  bindingActiveKey,
  lessonKey,
  daysBetween,
  topicOrdersForDays,
  MAX_SPAN_DAYS,
} = require("../src/helpers/lessonTopic");

// 2026-10-12 — dushanba. Hafta: 12(Du) 13(Se) 14(Cho) 15(Pa) 16(Ju) 17(Sha)
const WEEK = [
  "2026-10-12",
  "2026-10-13",
  "2026-10-14",
  "2026-10-15",
  "2026-10-16",
  "2026-10-17",
];

/** Dushanba 2-dars, chorshanba 4-dars, juma 1-dars. */
const ORDERS = new Map([
  [1, [2]],
  [3, [4]],
  [5, [1]],
]);

const always = () => true;
const at = (map, day, order) => map.get(lessonKey(day, order));

test("sanoq: ankordan keyin har bir dars mavzuni bittaga suradi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 50 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
  });

  assert.equal(at(result, "2026-10-12", 2).topicOrder, 50);
  assert.equal(at(result, "2026-10-14", 4).topicOrder, 51);
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 52);
});

test("sanoq: keyingi haftaga ham davom etadi (jadval — haftalik shablon)", () => {
  const nextWeek = WEEK.map((day) => {
    const date = new Date(`${day}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 7);
    return date.toISOString().slice(0, 10);
  });

  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 50 },
    ordersByDayNumber: ORDERS,
    targetDays: nextWeek,
    isTeachingDay: always,
    lastTopicOrder: 200,
  });

  // 12→50, 14→51, 16→52, keyin 19→53, 21→54, 23→55
  assert.equal(at(result, "2026-10-19", 2).topicOrder, 53);
  assert.equal(at(result, "2026-10-21", 4).topicOrder, 54);
  assert.equal(at(result, "2026-10-23", 1).topicOrder, 55);
});

test("bayram / ta'til kuni sanalmaydi — mavzu o'sha joyda turadi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 50 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: (day) => day !== "2026-10-14", // chorshanba — bayram
    lastTopicOrder: 200,
  });

  assert.equal(at(result, "2026-10-12", 2).topicOrder, 50);
  assert.equal(at(result, "2026-10-14", 4), undefined); // dars yo'q — qator ham yo'q
  // Chorshanba sanalmadi: juma 51 bo'ladi, 52 EMAS
  assert.equal(at(result, "2026-10-16", 1).topicOrder, 51);
});

test("ankor kunidagi undan OLDINGI darslar ankorga tegishli emas", () => {
  const orders = new Map([[1, [1, 2, 3]]]); // dushanba 1-, 2-, 3-darslar

  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 7 },
    ordersByDayNumber: orders,
    targetDays: ["2026-10-12"],
    isTeachingDay: always,
    lastTopicOrder: 100,
  });

  assert.equal(at(result, "2026-10-12", 1), undefined);
  assert.equal(at(result, "2026-10-12", 2).topicOrder, 7);
  assert.equal(at(result, "2026-10-12", 3).topicOrder, 8);
});

test("ankordan OLDINGI kunlar bo'sh qoladi — orqaga sanalmaydi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-15", lessonOrder: 4, topicOrder: 50 },
    ordersByDayNumber: new Map([[3, [4]], [4, [4]]]),
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
  });

  const before = at(result, "2026-10-14", 4);
  assert.equal(before.topicOrder, null);
  assert.equal(before.reason, TOPIC_MISS_REASONS.beforeAnchor);
  assert.equal(at(result, "2026-10-15", 4).topicOrder, 50);
});

test("mavzular tugaganda raqam o'rniga sabab qaytadi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2026-10-12", lessonOrder: 2, topicOrder: 5 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 6,
  });

  assert.equal(at(result, "2026-10-12", 2).topicOrder, 5);
  assert.equal(at(result, "2026-10-14", 4).topicOrder, 6);
  const exhausted = at(result, "2026-10-16", 1);
  assert.equal(exhausted.topicOrder, null);
  assert.equal(exhausted.reason, TOPIC_MISS_REASONS.exhausted);
});

test("juda uzoq ankor — sanoq yurmaydi, sabab aytiladi", () => {
  const result = topicOrdersForDays({
    anchor: { day: "2000-01-03", lessonOrder: 2, topicOrder: 1 },
    ordersByDayNumber: ORDERS,
    targetDays: WEEK,
    isTeachingDay: always,
    lastTopicOrder: 200,
  });

  assert.equal(at(result, "2026-10-12", 2).reason, TOPIC_MISS_REASONS.outOfRange);
  assert.ok(daysBetween("2000-01-03", "2026-10-17") > MAX_SPAN_DAYS);
});

test("faol ankor kaliti — `scheduleLessonId` emas, katakning o'rni", () => {
  assert.equal(
    bindingActiveKey("c1", "s1", "2026-10-12", 3),
    "c1|s1|2026-10-12|3",
  );
});
