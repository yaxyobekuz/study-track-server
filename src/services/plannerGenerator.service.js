/**
 * REJALASHTIRISH — TAYYORGARLIK VA SHAKLLANTIRISH.
 *
 * Bu yerda BAZA bilan ishlash bor, joylashtirish mantig'i esa
 * `helpers/planner.helpers.js` da (sof funksiyalar). Chegara ataylab shu
 * yerdan o'tadi: qoidalarni baza bilan aralashtirsak, na o'qib bo'lardi,
 * na tekshirib.
 *
 * Natija AMALDAGI jadvalga yozilmaydi — u `planner_runs` + `planner_lessons`
 * da yashaydi. Bitta shakllantirish = bitta VARIANT.
 */

const prisma = require("../config/prisma");
const { BadRequestError, NotFoundError } = require("../utils/errors");
const logger = require("../utils/logger");
const { getGrid } = require("./plannerSettings.service");
const { getRawLoads } = require("./plannerLoad.service");
const { getBusySet } = require("./plannerAvailability.service");
const {
  UNPLACED_REASONS,
  createRandom,
  buildDemands,
  busyKey,
  createBoard,
  gapCount,
  canPlace,
  scorePlacement,
  compactClassDay,
} = require("../helpers/planner.helpers");

const demandKey = (d) => `${d.teacherId}|${d.subjectId}|${d.classId}`;

// O'qituvchining bandlik chegarasi: shu ulushdan oshsa, matematik jihatdan
// sig'adi-yu, joylashtirishga erkinlik qolmaydi. 0.85 tajribadan olingan —
// undan yuqorida to'liq jadval chiqishi sezilarli kamayadi.
const SATURATION_LIMIT = 0.85;

/**
 * Shakllantirishdan OLDINGI tekshiruv.
 *
 * `blocking` — shakllantirish umuman mumkin emas (talab sig'imdan katta,
 * dars soatlari belgilanmagan). `warnings` — natija chiqadi, lekin e'tibor
 * berish kerak. Ikkalasi ajratilgan: hammasini "xato" deb ko'rsatsak,
 * foydalanuvchi qaysi biri haqiqiy to'siq ekanini bilmasdi.
 */
async function getPreflight() {
  const [grid, loads, busy, teachers, classes] = await Promise.all([
    getGrid(),
    getRawLoads(),
    getBusySet(),
    prisma.user.findMany({
      where: { role: { not: "student" }, isArchived: false },
      select: { id: true, firstName: true, lastName: true, fullName: true },
    }),
    prisma.class.findMany({ select: { id: true, name: true } }),
  ]);

  const { days, orders, settings } = grid;
  const slotsPerWeek = days.length * orders.length;
  const demands = buildDemands(loads);

  const classMap = new Map(classes.map((c) => [c.id, c.name]));
  const teacherMap = new Map(teachers.map((t) => [t.id, t.fullName]));

  const blocking = [];
  const warnings = [];

  if (orders.length === 0) {
    blocking.push({
      code: "no_periods",
      message: "Dars soatlari belgilanmagan",
      hint: "Sozlamalar tabidagi \"Dars soatlari\" ro'yxatiga kamida bitta dars qo'shing",
    });
  }

  if (days.length === 0) {
    blocking.push({
      code: "no_days",
      message: "Ish kunlari belgilanmagan",
      hint: "Sozlamalar tabida kamida bitta kunni belgilang",
    });
  }

  if (demands.length === 0) {
    blocking.push({
      code: "no_demand",
      message: "Hech bir o'qituvchiga dars soati belgilanmagan",
      hint: "Asosiy tabda soat va sinflarni to'ldiring",
    });
  }

  // Sinf kesimi: haftalik sig'im va kunlik chegara.
  const perClass = new Map();
  for (const d of demands) {
    perClass.set(d.classId, (perClass.get(d.classId) || 0) + d.hours);
  }
  for (const [classId, demand] of perClass) {
    const name = classMap.get(classId) || classId;
    if (demand > slotsPerWeek) {
      blocking.push({
        code: "class_over_capacity",
        message: `${name}: haftasiga ${demand} soat kerak, jadvalda esa ${slotsPerWeek} katak bor`,
        hint: "Soatni kamaytiring yoki Sozlamalarda dars sonini oshiring",
      });
    } else if (demand > days.length * settings.maxLessonsPerDay) {
      blocking.push({
        code: "class_over_daily_limit",
        message: `${name}: ${demand} soat kunlik chegaraga (${settings.maxLessonsPerDay}) sig'maydi`,
        hint: "Kunlik maksimal darsni oshiring yoki soatni kamaytiring",
      });
    } else if (demand < days.length * settings.minLessonsPerDay) {
      warnings.push({
        code: "class_under_minimum",
        message: `${name}: ${demand} soat kunlik minimumni (${settings.minLessonsPerDay}) to'ldirmaydi`,
      });
    }
  }

  // O'qituvchi kesimi: bandlikdan keyingi bo'sh sig'im.
  const perTeacher = new Map();
  for (const d of demands) {
    perTeacher.set(d.teacherId, (perTeacher.get(d.teacherId) || 0) + d.hours);
  }
  for (const [teacherId, demand] of perTeacher) {
    const name = teacherMap.get(teacherId) || teacherId;
    let busyCount = 0;
    for (const day of days) {
      for (const order of orders) {
        if (busy.has(busyKey(teacherId, day, order))) busyCount += 1;
      }
    }
    const available = slotsPerWeek - busyCount;

    if (demand > available) {
      blocking.push({
        code: "teacher_over_capacity",
        message: `${name}: ${demand} soat dars bor, bo'sh katak esa ${available} ta`,
        hint: "Bandlik tabida band kataklarni kamaytiring yoki soatni bo'lishtiring",
      });
    } else if (demand > days.length * settings.teacherMaxPerDay) {
      blocking.push({
        code: "teacher_over_daily_limit",
        message: `${name}: ${demand} soat kunlik chegaraga (${settings.teacherMaxPerDay}) sig'maydi`,
        hint: "O'qituvchi uchun kunlik maksimal darsni oshiring",
      });
    } else if (demand > available * SATURATION_LIMIT) {
      // Matematik jihatdan sig'adi, AMMO deyarli hamma katak band bo'ladi.
      // Bunday holatda joylashtirish uchun erkinlik qolmaydi va jadval
      // to'liq chiqmasligi mumkin. Buni oldindan aytmasak, foydalanuvchi
      // "to'siq ham, ogohlantirish ham yo'q edi-ku" deb hayron qolardi.
      warnings.push({
        code: "teacher_saturated",
        message: `${name}: ${demand} soat dars, bo'sh katak ${available} ta — jadval to'liq chiqmasligi mumkin`,
        hint: settings.avoidConsecutiveSame
          ? "Sozlamalarda \"Ketma-ket ikkita bir xil dars bo'lmasin\" ni o'chirish odatda eng ko'p yordam beradi (juft dars)"
          : "Bandlik tabida band kataklarni kamaytiring yoki soatni boshqa o'qituvchi bilan bo'lishing",
      });
    }
  }

  // Bitta sinfga bitta fandan ikki o'qituvchi — ko'pincha xato kiritish.
  const pairs = new Map();
  for (const d of demands) {
    const key = `${d.classId}|${d.subjectId}`;
    if (!pairs.has(key)) pairs.set(key, new Set());
    pairs.get(key).add(d.teacherId);
  }
  for (const [key, set] of pairs) {
    if (set.size > 1) {
      const [classId] = key.split("|");
      warnings.push({
        code: "shared_subject",
        message: `${classMap.get(classId) || classId}: bitta fanni ${set.size} o'qituvchi olib boradi`,
      });
    }
  }

  for (const load of loads) {
    if (load.classes.length === 0 && load.weeklyHours > 0) {
      warnings.push({
        code: "no_class",
        message: `${teacherMap.get(load.teacherId) || load.teacherId}: soat kiritilgan, sinf tanlanmagan`,
      });
    }
  }

  const demandTotal = demands.reduce((sum, d) => sum + d.hours, 0);

  return {
    blocking,
    warnings,
    totals: {
      demand: demandTotal,
      capacity: slotsPerWeek * perClass.size,
      slotsPerWeek,
      days: days.length,
      periods: orders.length,
      classes: perClass.size,
      teachers: perTeacher.size,
    },
  };
}

/**
 * Birlik uchun ENG YAXSHI katak.
 *
 * Barcha kataklar ko'rib chiqiladi va eng arzoni tanlanadi. Rad etilgan
 * kataklarning sabablari ham yig'iladi — birorta katak topilmasa, aynan
 * shulardan "nega joylashmadi" degan javob tug'iladi.
 *
 * @returns {{slot: object|null, reasons: Map<string, number>}}
 */
function findBestSlot(board, unit, days, orders, ctx, random) {
  let best = null;
  const reasons = new Map();

  for (const day of days) {
    for (const order of orders) {
      const check = canPlace(board, unit, day, order, ctx);
      if (!check.ok) {
        reasons.set(check.reason, (reasons.get(check.reason) || 0) + 1);
        continue;
      }
      const score = scorePlacement(board, unit, day, order, ctx, random);
      if (!best || score < best.score) best = { day, order, score };
    }
  }

  return { slot: best, reasons };
}

// Eng ko'p uchragan sababni tanlaydi — "nega joylashmadi" degan savolga
// bitta, aniq jumla bilan javob berish uchun.
function topReason(reasons) {
  let bestReason = UNPLACED_REASONS.NO_SLOT;
  let bestCount = -1;
  for (const [reason, count] of reasons) {
    if (count > bestCount) {
      bestCount = count;
      bestReason = reason;
    }
  }
  return bestReason;
}

/**
 * TA'MIRLASH: to'sqinlik qilayotgan darsni boshqa katakka ko'chirib, bo'shagan
 * joyga joriy birlikni qo'yishga urinadi ("ejection chain").
 *
 * `depth` — to'siqning o'zi ham joy topolmasa, uni ko'chirish uchun YANA
 * bir bosqich urinish. Ikki bosqich yetarli: uchinchisi natijani deyarli
 * o'zgartirmaydi-yu, vaqtni bir necha barobar oshiradi.
 *
 * ⚠️ Ichki bosqich muvaffaqiyatli bo'lib, tashqarisi yiqilsa, ichkarida
 * ko'chirilgan dars joyiga QAYTARILMAYDI. Bu xavfsiz: taxta baribir haqiqiy
 * qoladi (birorta dars yo'qolmaydi va to'qnashuv paydo bo'lmaydi), shunchaki
 * boshqacha joylashadi.
 */
function tryRepair(board, unit, days, orders, ctx, random, budget, depth = 1) {
  for (const day of days) {
    for (const order of orders) {
      if (budget.left <= 0) return null;

      const byClass = board.classAt(unit.classId, day, order);
      const byTeacher = board.teacherAt(unit.teacherId, day, order);

      const blocker = byClass || byTeacher;
      if (!blocker) continue;
      // Ikki xil to'siq bo'lsa, bittasini ko'chirish yetmaydi.
      if (byClass && byTeacher && byClass !== byTeacher) continue;
      if (blocker.isPinned) continue;

      // To'siqni hisobga olmaganda qolgan qoidalar bajariladimi?
      if (!canPlace(board, unit, day, order, { ...ctx, skip: blocker }).ok) continue;

      budget.left -= 1;

      const from = { day: blocker.day, order: blocker.order };
      board.remove(blocker);

      let moved = false;
      const { slot } = findBestSlot(board, blocker, days, orders, ctx, random);
      if (slot) {
        blocker.day = slot.day;
        blocker.order = slot.order;
        board.place(blocker);
        moved = true;
      } else if (depth > 1) {
        const chained = tryRepair(board, blocker, days, orders, ctx, random, budget, depth - 1);
        if (chained) {
          blocker.day = chained.day;
          blocker.order = chained.order;
          board.place(blocker);
          moved = true;
        }
      }

      if (moved) {
        if (canPlace(board, unit, day, order, ctx).ok) return { day, order };
        board.remove(blocker);
      }

      blocker.day = from.day;
      blocker.order = from.order;
      board.place(blocker);
    }
  }

  return null;
}

/**
 * YAXSHILASH — "oyna"larni kamaytiradigan ko'chirishlar.
 *
 * O'lchov ANIQ va bitta: sinf va o'qituvchi kunlaridagi bo'sh oraliqlar
 * yig'indisi. Ball funksiyasi (`scorePlacement`) bo'yicha emas, aynan shu
 * o'lchov bo'yicha yaxshilanadi — aks holda tepalikka chiqish zichlash bilan
 * urishib ketardi.
 *
 * Darsni ko'chirish IKKI kunga ta'sir qiladi (ketgani va kelgani), shuning
 * uchun delta to'rt to'plamdan hisoblanadi. Faqat qat'iy yaxshilanish
 * qabul qilinadi — teng natijada joyida qoladi va sikl yuzaga kelmaydi.
 */
function improve(board, days, orders, ctx, maxPasses = 2) {
  const { orderPos } = board;

  // Sinf "oynasi" taqiqlangan bo'lsa, u o'qituvchi oynasidan BESH BAROBAR
  // qimmat: aks holda yaxshilash bitta o'qituvchining qulayligi uchun
  // o'quvchilarga bo'sh soat sovg'a qilib yuborardi.
  const classWeight = ctx.settings.allowClassGaps ? 1 : 5;

  const dayCost = (lesson, day, extraOrder) => {
    const classSet = board.classDayOrders(lesson.classId, day);
    const teacherSet = board.teacherDayOrders(lesson.teacherId, day);
    if (extraOrder === undefined) {
      return (
        gapCount(classSet, orderPos) * classWeight + gapCount(teacherSet, orderPos)
      );
    }
    return (
      gapCount(new Set([...classSet, extraOrder]), orderPos) * classWeight +
      gapCount(new Set([...teacherSet, extraOrder]), orderPos)
    );
  };

  for (let pass = 0; pass < maxPasses; pass += 1) {
    let improved = false;

    for (const lesson of board.all()) {
      if (lesson.isPinned) continue;

      const from = { day: lesson.day, order: lesson.order };
      const srcBefore = dayCost(lesson, from.day);

      board.remove(lesson);
      const srcAfter = dayCost(lesson, from.day);

      let best = null;
      for (const day of days) {
        for (const order of orders) {
          if (day === from.day && order === from.order) continue;
          if (!canPlace(board, lesson, day, order, ctx).ok) continue;

          const dstBefore = dayCost(lesson, day);
          const dstAfter = dayCost(lesson, day, order);
          const delta = srcAfter + dstAfter - (srcBefore + dstBefore);

          if (delta < 0 && (best === null || delta < best.delta)) {
            best = { day, order, delta };
          }
        }
      }

      if (best) {
        lesson.day = best.day;
        lesson.order = best.order;
        improved = true;
      } else {
        lesson.day = from.day;
        lesson.order = from.order;
      }
      board.place(lesson);
    }

    if (!improved) break;
  }
}

/**
 * SOLVER — talab birliklarini gridga joylashtiradi.
 *
 * Bosqichlar: qadalganlar → tartiblash → ochko'z joylashtirish (kerak bo'lsa
 * ta'mirlash bilan) → zichlash → yaxshilash. Har bosqich oldingisining
 * natijasini buzmaydi, shuning uchun ularni alohida o'qish mumkin.
 *
 * @returns {{ lessons: Array, unplaced: Array, board: object }}
 */
function solve({ days, orders, demands, busy, settings, pinned = [] }) {
  const board = createBoard({ orders });
  const ctx = { busy, settings, orderPos: board.orderPos };
  const random = createRandom(settings.seed);

  // 1. QADALGAN darslar — avval joylashtiriladi va qotib qoladi.
  //    Sig'maganlari (grid o'zgargan, katak band bo'lib qolgan) jimgina
  //    tashlanadi: ular oddiy talab sifatida qayta joylashtiriladi.
  const pinnedCount = new Map();
  for (const lesson of pinned) {
    if (!days.includes(lesson.day) || !orders.includes(lesson.order)) continue;
    if (board.classAt(lesson.classId, lesson.day, lesson.order)) continue;
    if (board.teacherAt(lesson.teacherId, lesson.day, lesson.order)) continue;
    if (busy.has(busyKey(lesson.teacherId, lesson.day, lesson.order))) continue;

    const placed = { ...lesson, isPinned: true };
    board.place(placed);
    const key = demandKey(placed);
    pinnedCount.set(key, (pinnedCount.get(key) || 0) + 1);
  }

  // 2. Qolgan talabni birliklarga yoyamiz.
  const units = [];
  for (const demand of demands) {
    const already = pinnedCount.get(demandKey(demand)) || 0;
    for (let i = already; i < demand.hours; i += 1) {
      units.push({
        teacherId: demand.teacherId,
        subjectId: demand.subjectId,
        classId: demand.classId,
      });
    }
  }

  // 3. TARTIB: eng qattiq cheklangani oldin. Erkin o'qituvchini oxirida
  //    joylashtirish oson, bandini esa oxirida — deyarli imkonsiz.
  const slotsPerWeek = days.length * orders.length;
  const teacherDemand = new Map();
  const classDemand = new Map();
  for (const demand of demands) {
    teacherDemand.set(
      demand.teacherId,
      (teacherDemand.get(demand.teacherId) || 0) + demand.hours,
    );
    classDemand.set(
      demand.classId,
      (classDemand.get(demand.classId) || 0) + demand.hours,
    );
  }

  const tightness = new Map();
  for (const [teacherId, demand] of teacherDemand) {
    let busyCount = 0;
    for (const day of days) {
      for (const order of orders) {
        if (busy.has(busyKey(teacherId, day, order))) busyCount += 1;
      }
    }
    tightness.set(teacherId, demand / Math.max(1, slotsPerWeek - busyCount));
  }

  units.sort((a, b) => {
    const byTeacher = (tightness.get(b.teacherId) || 0) - (tightness.get(a.teacherId) || 0);
    if (byTeacher !== 0) return byTeacher;
    const byClass = (classDemand.get(b.classId) || 0) - (classDemand.get(a.classId) || 0);
    if (byClass !== 0) return byClass;
    return a.classId < b.classId ? -1 : a.classId > b.classId ? 1 : 0;
  });

  // 4. JOYLASHTIRISH.
  const leftovers = [];
  const repairBudget = { left: 600 };

  for (const unit of units) {
    const { slot, reasons } = findBestSlot(board, unit, days, orders, ctx, random);
    const target =
      slot || tryRepair(board, unit, days, orders, ctx, random, repairBudget);

    if (!target) {
      leftovers.push({ unit, reasons });
      continue;
    }

    board.place({ ...unit, day: target.day, order: target.order, isPinned: false });
  }

  // 5. ZICHLASH — sinf kunlaridagi "oyna"larni yuqoriga surib yopadi.
  const classIds = [...new Set(demands.map((d) => d.classId))];
  for (const classId of classIds) {
    for (const day of days) {
      compactClassDay(board, classId, day, ctx);
    }
  }

  // 6. YAXSHILASH — asosan o'qituvchi "oyna"lari uchun.
  improve(board, days, orders, ctx);

  // 7. QAYTA URINISH — zichlash va yaxshilash taxtani o'zgartirdi, ya'ni
  //    avval joy topolmagan darslar endi sig'ishi mumkin. Qolganlari kam
  //    bo'lgani uchun bu yerda ta'mirlash CHUQURROQ va budjet kattaroq:
  //    oxirgi bir necha dars uchun ko'proq harakat qilish arziydi.
  const failures = new Map();
  const lastChance = { left: 4000 };
  let recovered = 0;

  for (const { unit, reasons } of leftovers) {
    const retry = findBestSlot(board, unit, days, orders, ctx, random);
    const target =
      retry.slot ||
      tryRepair(board, unit, days, orders, ctx, random, lastChance, 2);

    if (target) {
      board.place({ ...unit, day: target.day, order: target.order, isPinned: false });
      recovered += 1;
      continue;
    }

    const key = demandKey(unit);
    const entry =
      failures.get(key) ||
      { ...unit, missing: 0, reason: topReason(retry.reasons.size ? retry.reasons : reasons) };
    entry.missing += 1;
    failures.set(key, entry);
  }

  // 8. YAKUNIY ZICHLASH — SHARTSIZ.
  //
  // ⚠️ `canPlace` katakka QO'YISHNI tekshiradi, katakdan KETISHNI emas:
  // ta'mirlash zanjiri darsni kun o'rtasidan olib chiqsa, o'sha joyda
  // teshik qolishi mumkin. Shuning uchun oxirida har doim zichlanadi —
  // qayta urinish natija bermagan taqdirda ham.
  for (const classId of classIds) {
    for (const day of days) {
      compactClassDay(board, classId, day, ctx);
    }
  }
  improve(board, days, orders, ctx, 3);

  return { lessons: board.all(), unplaced: [...failures.values()], board };
}

/**
 * Statistika — foydalanuvchi "nima bo'ldi" degan savolga bir qarashda javob
 * olishi uchun. Sinf va o'qituvchi kesimi ham bor: umumiy 98% yaxshi
 * ko'rinadi-yu, bitta sinf yarim bo'sh qolgan bo'lishi mumkin.
 */
function buildStats({ board, lessons, demands, unplaced, days, orders }) {
  const demandTotal = demands.reduce((sum, d) => sum + d.hours, 0);
  const placed = lessons.length;

  const byClass = new Map();
  const byTeacher = new Map();

  for (const demand of demands) {
    const cls = byClass.get(demand.classId) || { id: demand.classId, demand: 0, placed: 0, gaps: 0 };
    cls.demand += demand.hours;
    byClass.set(demand.classId, cls);

    const teacher = byTeacher.get(demand.teacherId) || { id: demand.teacherId, demand: 0, placed: 0, gaps: 0 };
    teacher.demand += demand.hours;
    byTeacher.set(demand.teacherId, teacher);
  }

  for (const lesson of lessons) {
    if (byClass.has(lesson.classId)) byClass.get(lesson.classId).placed += 1;
    if (byTeacher.has(lesson.teacherId)) byTeacher.get(lesson.teacherId).placed += 1;
  }

  for (const day of days) {
    for (const cls of byClass.values()) {
      cls.gaps += gapCount(board.classDayOrders(cls.id, day), board.orderPos);
    }
    for (const teacher of byTeacher.values()) {
      teacher.gaps += gapCount(board.teacherDayOrders(teacher.id, day), board.orderPos);
    }
  }

  const unplacedCount = unplaced.reduce((sum, u) => sum + u.missing, 0);

  return {
    demand: demandTotal,
    placed,
    unplacedCount,
    // PASTGA yaxlitlanadi: bitta dars joylashmay qolganda "100%" deb
    // ko'rsatish foydalanuvchini chalg'itardi.
    fillRate: demandTotal === 0 ? 0 : Math.floor((placed / demandTotal) * 100),
    slotsPerWeek: days.length * orders.length,
    classGaps: [...byClass.values()].reduce((sum, c) => sum + c.gaps, 0),
    teacherGaps: [...byTeacher.values()].reduce((sum, t) => sum + t.gaps, 0),
    byClass: [...byClass.values()],
    byTeacher: [...byTeacher.values()],
  };
}

/**
 * SHAKLLANTIRISH — yangi variant yaratadi.
 *
 * Avvalgi variantlar TEGILMAYDI: har shakllantirish yangi qator yozadi,
 * shuning uchun ikkitasini yonma-yon solishtirib, yoqqanini qoldirish mumkin.
 *
 * @param {object} options - { name?, basedOnRunId? }
 *   `basedOnRunId` berilsa, o'sha variantdagi QADALGAN darslar joyida qoladi.
 * @param {string} userId
 * @returns {Promise<object>} to'liq variant (darslari bilan)
 */
async function generate(options = {}, userId) {
  const preflight = await getPreflight();
  if (preflight.blocking.length > 0) {
    throw new BadRequestError(preflight.blocking[0].message);
  }

  const [grid, loads, busy] = await Promise.all([
    getGrid(),
    getRawLoads(),
    getBusySet(),
  ]);

  const { days, orders, periods, settings } = grid;
  const demands = buildDemands(loads);

  let pinned = [];
  if (options.basedOnRunId) {
    const base = await prisma.plannerRun.findUnique({
      where: { id: options.basedOnRunId },
      include: { lessons: { where: { isPinned: true } } },
    });
    if (!base) throw new NotFoundError("Variant topilmadi");
    pinned = base.lessons.map((l) => ({
      classId: l.classId,
      day: l.day,
      order: l.order,
      subjectId: l.subjectId,
      teacherId: l.teacherId,
    }));
  }

  const startedAt = Date.now();
  const { board, lessons, unplaced } = solve({
    days,
    orders,
    demands,
    busy,
    settings,
    pinned,
  });

  const stats = buildStats({ board, lessons, demands, unplaced, days, orders });
  stats.durationMs = Date.now() - startedAt;

  const total = await prisma.plannerRun.count();
  const name = String(options.name || "").trim() || `${total + 1}-variant`;

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.plannerRun.create({
      data: {
        name,
        stats,
        unplaced,
        // Sozlama keyin o'zgarsa, bu variant QANDAY shartlarda tug'ilgani
        // ma'lum bo'lib qoladi.
        settingsSnapshot: {
          days,
          periods,
          maxLessonsPerDay: settings.maxLessonsPerDay,
          minLessonsPerDay: settings.minLessonsPerDay,
          teacherMaxPerDay: settings.teacherMaxPerDay,
          allowClassGaps: settings.allowClassGaps,
          allowTeacherGaps: settings.allowTeacherGaps,
          maxSameSubjectPerDay: settings.maxSameSubjectPerDay,
          avoidConsecutiveSame: settings.avoidConsecutiveSame,
          seed: settings.seed,
        },
        generatedBy: userId || null,
      },
    });

    if (lessons.length > 0) {
      await tx.plannerLesson.createMany({
        data: lessons.map((lesson) => ({
          runId: created.id,
          classId: lesson.classId,
          day: lesson.day,
          order: lesson.order,
          subjectId: lesson.subjectId,
          teacherId: lesson.teacherId,
          isPinned: Boolean(lesson.isPinned),
        })),
      });
    }

    return created;
  });

  logger.info(
    `[Planner] "${name}" shakllantirildi: ${stats.placed}/${stats.demand} dars, ${stats.durationMs}ms`,
  );

  return { runId: run.id, stats, unplaced, warnings: preflight.warnings };
}

module.exports = { getPreflight, generate, solve, buildStats };
