/**
 * DARS JADVALINI REJALASHTIRISH — sof funksiyalar.
 *
 * Bu yerda BAZA YO'Q va bo'lmasligi kerak: butun joylashtirish mantig'i shu
 * faylda, service esa faqat o'qiydi/yozadi. Sabab oddiy — jadval tuzish
 * qoidalarini (to'qnashuv, "oyna", kunlik chegara) baza bilan aralashtirsak,
 * ularni na o'qib bo'lardi, na tekshirib.
 *
 * KOORDINATA: (kun, order). `kun` — ScheduleDay enum qiymati, `order` esa
 * ScheduleSettings.periods dagi dars tartibi. Ya'ni preview grid amaldagi
 * jadval bilan AYNAN bir xil koordinatada yashaydi.
 */

const { DAYS } = require("../utils/constants");

// dushanba → shanba (ScheduleDay enum tartibi). Yakshanba YO'Q.
const SCHEDULE_DAYS = Object.values(DAYS);

// Joylashtirib bo'lmaganda beriladigan sabablar. Matn foydalanuvchiga
// ko'rinadi, shuning uchun kod emas — jumla.
const UNPLACED_REASONS = {
  CLASS_FULL: "sinfda bo'sh katak qolmadi",
  TEACHER_BUSY: "o'qituvchi barcha mos kataklarda band",
  CLASS_DAY_LIMIT: "sinfning kunlik dars chegarasi to'ldi",
  TEACHER_DAY_LIMIT: "o'qituvchining kunlik dars chegarasi to'ldi",
  SAME_SUBJECT_LIMIT: "bir kunda shu fandan ruxsat etilganidan ko'p bo'lib ketardi",
  NO_SLOT: "mos katak topilmadi",
};

/**
 * Ish kunlari: bo'sh massiv = HAMMA kun.
 * "Hech bir kun" holati ma'nosiz, shuning uchun bo'sh qiymat "hammasi" deb
 * o'qiladi — yangi filial sozlamaga tegmasdan ham ishlaydi.
 *
 * @param {string[]} workDays
 * @returns {string[]} ScheduleDay qiymatlari, hafta tartibida
 */
function resolveWorkDays(workDays) {
  if (!Array.isArray(workDays) || workDays.length === 0) return [...SCHEDULE_DAYS];
  const set = new Set(workDays);
  return SCHEDULE_DAYS.filter((day) => set.has(day));
}

/**
 * `periods` (JSON) dan dars tartiblarini ajratib oladi.
 * @param {Array} periods - [{ order, startTime, endTime }]
 * @returns {number[]} o'sish tartibida, takrorsiz
 */
function resolveOrders(periods) {
  if (!Array.isArray(periods)) return [];
  const orders = periods
    .map((p) => Number(p?.order))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(orders)].sort((a, b) => a - b);
}

/**
 * Seed'li PRNG (mulberry32).
 *
 * `Math.random()` ATAYLAB ishlatilmaydi: bir xil kirim + bir xil seed AYNAN
 * bir xil jadval berishi kerak. Aks holda "kecha yaxshiroq chiqqan edi" degan
 * holatni qaytarib bo'lmasdi, seed o'zgartirish esa boshqa variant beradi.
 *
 * @param {number} seed
 * @returns {() => number} [0, 1)
 */
function createRandom(seed) {
  let a = (Number(seed) || 1) >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Yuklama satrlarini talab birliklariga yoyadi.
 *
 * Soat HAR BIR SINF uchun: `weeklyHours` standart, sinfdagi qiymat esa
 * istisno (null bo'lsa standart amal qiladi).
 *
 * @param {Array} loads - [{ teacherId, subjectId, weeklyHours, classes: [{ classId, weeklyHours }] }]
 * @returns {Array} [{ teacherId, subjectId, classId, hours }]
 */
function buildDemands(loads = []) {
  const out = [];
  for (const load of loads) {
    for (const cls of load.classes || []) {
      const hours =
        cls.weeklyHours === null || cls.weeklyHours === undefined
          ? Number(load.weeklyHours) || 0
          : Number(cls.weeklyHours) || 0;
      if (hours > 0) {
        out.push({
          teacherId: load.teacherId,
          subjectId: load.subjectId,
          classId: cls.classId,
          hours,
        });
      }
    }
  }
  return out;
}

/**
 * Joylashtirish taxtasi — indekslar ustidagi ingichka qobiq.
 *
 * Ikkita "bir vaqtda bitta joyda" qoidasi (sinf va o'qituvchi) shu yerda,
 * bitta joyda ushlanadi. Ular tekshiruv sifatida emas, INDEKS sifatida
 * saqlanadi: `place()` chaqirilgan zahoti to'qnashuv ko'rinadi.
 *
 * @param {object} p
 * @param {number[]} p.orders - dars tartiblari, o'sish bo'yicha
 */
function createBoard({ orders }) {
  const classSlot = new Map(); // "classId|day|order" → dars
  const teacherSlot = new Map(); // "teacherId|day|order" → dars
  const classDay = new Map(); // "classId|day" → Set<order>
  const teacherDay = new Map(); // "teacherId|day" → Set<order>
  const subjectDay = new Map(); // "classId|day|subjectId" → son
  const lessons = new Set();

  const orderPos = new Map(orders.map((o, i) => [o, i]));

  const k3 = (a, b, c) => `${a}|${b}|${c}`;
  const k2 = (a, b) => `${a}|${b}`;

  const bump = (map, key, delta) => {
    const next = (map.get(key) || 0) + delta;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  };

  const addTo = (map, key, value) => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(value);
  };

  const EMPTY = new Set();

  return {
    orders,
    orderPos,

    place(lesson) {
      classSlot.set(k3(lesson.classId, lesson.day, lesson.order), lesson);
      teacherSlot.set(k3(lesson.teacherId, lesson.day, lesson.order), lesson);
      addTo(classDay, k2(lesson.classId, lesson.day), lesson.order);
      addTo(teacherDay, k2(lesson.teacherId, lesson.day), lesson.order);
      bump(subjectDay, k3(lesson.classId, lesson.day, lesson.subjectId), 1);
      lessons.add(lesson);
    },

    remove(lesson) {
      classSlot.delete(k3(lesson.classId, lesson.day, lesson.order));
      teacherSlot.delete(k3(lesson.teacherId, lesson.day, lesson.order));
      classDay.get(k2(lesson.classId, lesson.day))?.delete(lesson.order);
      teacherDay.get(k2(lesson.teacherId, lesson.day))?.delete(lesson.order);
      bump(subjectDay, k3(lesson.classId, lesson.day, lesson.subjectId), -1);
      lessons.delete(lesson);
    },

    classAt: (classId, day, order) => classSlot.get(k3(classId, day, order)) || null,
    teacherAt: (teacherId, day, order) =>
      teacherSlot.get(k3(teacherId, day, order)) || null,
    classDayOrders: (classId, day) => classDay.get(k2(classId, day)) || EMPTY,
    teacherDayOrders: (teacherId, day) => teacherDay.get(k2(teacherId, day)) || EMPTY,
    subjectDayCount: (classId, day, subjectId) =>
      subjectDay.get(k3(classId, day, subjectId)) || 0,
    all: () => [...lessons],
  };
}

/** Band katak kaliti — busy Set bilan bir xil shaklda. */
const busyKey = (teacherId, day, order) => `${teacherId}|${day}|${order}`;

/**
 * Kun ichidagi "oyna" soni: birinchi va oxirgi dars orasidagi bo'sh kataklar.
 * Bo'sh kun ham, uzluksiz kun ham 0 beradi.
 */
function gapCount(orderSet, orderPos) {
  if (!orderSet || orderSet.size < 2) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const order of orderSet) {
    const pos = orderPos.get(order);
    if (pos === undefined) continue;
    if (pos < min) min = pos;
    if (pos > max) max = pos;
  }
  if (min === Infinity) return 0;
  return max - min + 1 - orderSet.size;
}

/**
 * Qo'shni kataklarda shu fan bormi (ketma-ket bir xil dars tekshiruvi).
 * `skip` — o'zi ko'chirilayotgan dars (o'zini o'ziga qo'shni deb sanamaslik uchun).
 */
function hasSameSubjectNeighbour(board, classId, day, order, subjectId, skip) {
  const pos = board.orderPos.get(order);
  if (pos === undefined) return false;
  for (const delta of [-1, 1]) {
    const neighbour = board.orders[pos + delta];
    if (neighbour === undefined) continue;
    const lesson = board.classAt(classId, day, neighbour);
    if (lesson && lesson !== skip && lesson.subjectId === subjectId) return true;
  }
  return false;
}

/**
 * Sinf kunidagi darslar UZLUKSIZ zanjir bo'lib qoladimi?
 * `allowClassGaps = false` da yangi katak mavjud oraliqning chetiga tegishi
 * yoki uning ICHIDAGI teshikni to'ldirishi kerak.
 */
function keepsClassContiguous(board, classId, day, order) {
  const taken = board.classDayOrders(classId, day);
  if (taken.size === 0) return true;
  const pos = board.orderPos.get(order);
  if (pos === undefined) return false;

  let min = Infinity;
  let max = -Infinity;
  for (const value of taken) {
    const p = board.orderPos.get(value);
    if (p === undefined) continue;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return pos >= min - 1 && pos <= max + 1;
}

/**
 * Shu katakka qo'yish MUMKINMI?
 *
 * Qattiq cheklovlar shu yerda, bitta joyda. Rad etilganda sabab ham qaytadi —
 * "joylashmadi" degan quruq xabar foydalanuvchiga hech narsa bermaydi.
 *
 * @param {object} board
 * @param {object} unit - { classId, subjectId, teacherId }
 * @param {string} day
 * @param {number} order
 * @param {object} ctx - { busy:Set, settings, skip? }
 * @returns {{ ok: boolean, reason?: string }}
 */
function canPlace(board, unit, day, order, ctx) {
  const { busy, settings, skip } = ctx;

  const occupiedByClass = board.classAt(unit.classId, day, order);
  if (occupiedByClass && occupiedByClass !== skip) {
    return { ok: false, reason: UNPLACED_REASONS.CLASS_FULL };
  }

  const occupiedByTeacher = board.teacherAt(unit.teacherId, day, order);
  if (occupiedByTeacher && occupiedByTeacher !== skip) {
    return { ok: false, reason: UNPLACED_REASONS.TEACHER_BUSY };
  }

  if (busy.has(busyKey(unit.teacherId, day, order))) {
    return { ok: false, reason: UNPLACED_REASONS.TEACHER_BUSY };
  }

  const classCount = board.classDayOrders(unit.classId, day).size;
  if (classCount >= settings.maxLessonsPerDay) {
    return { ok: false, reason: UNPLACED_REASONS.CLASS_DAY_LIMIT };
  }

  const teacherCount = board.teacherDayOrders(unit.teacherId, day).size;
  if (teacherCount >= settings.teacherMaxPerDay) {
    return { ok: false, reason: UNPLACED_REASONS.TEACHER_DAY_LIMIT };
  }

  const sameSubject = board.subjectDayCount(unit.classId, day, unit.subjectId);
  if (sameSubject >= settings.maxSameSubjectPerDay) {
    return { ok: false, reason: UNPLACED_REASONS.SAME_SUBJECT_LIMIT };
  }

  if (
    settings.avoidConsecutiveSame &&
    hasSameSubjectNeighbour(board, unit.classId, day, order, unit.subjectId, skip)
  ) {
    return { ok: false, reason: UNPLACED_REASONS.SAME_SUBJECT_LIMIT };
  }

  if (
    !settings.allowClassGaps &&
    !keepsClassContiguous(board, unit.classId, day, order)
  ) {
    return { ok: false, reason: UNPLACED_REASONS.NO_SLOT };
  }

  return { ok: true };
}

/**
 * Katakning "narxi" — KICHIK bo'lgani yaxshiroq.
 *
 * Har bir qo'shiluvchi bitta aniq maqsadga xizmat qiladi; ular qo'shiladi,
 * ko'paytirilmaydi — shunda bittasini o'zgartirish qolganini buzmaydi.
 */
function scorePlacement(board, unit, day, order, ctx, random) {
  const { settings, orderPos } = ctx;
  let score = 0;

  // 1. Bir fanni haftaga YOYISH: shu kunda bu fan qancha bo'lsa, shuncha qimmat.
  score += board.subjectDayCount(unit.classId, day, unit.subjectId) * 12;

  // 2. Sinf kunlarini TENG taqsimlash: to'lgan kun qimmatroq.
  const classCount = board.classDayOrders(unit.classId, day).size;
  score += classCount * 3;

  // 3. Kun ichida YUQORIDAN zichlash (birinchi darsdan boshlab).
  score += (orderPos.get(order) ?? 0) * 2;

  // 4. Kunlik minimum: boshlangan-u minimumga yetmagan kunni to'ldirish arzon.
  if (classCount > 0 && classCount < settings.minLessonsPerDay) score -= 6;

  // 5. O'qituvchi kunini YIG'IQ tutish: allaqachon kelgan kuni arzonroq.
  const teacherOrders = board.teacherDayOrders(unit.teacherId, day);
  if (teacherOrders.size > 0) score -= 3;

  // 6. O'qituvchida hosil bo'ladigan "oyna" — asosiy jarima.
  const before = gapCount(teacherOrders, orderPos);
  const after = gapCount(new Set([...teacherOrders, order]), orderPos);
  score += (after - before) * (settings.allowTeacherGaps ? 4 : 20);

  // 7. Teng ballarni ajratish uchun mayda shovqin (seed'li — takrorlanadi).
  score += random() * 0.9;

  return score;
}

/**
 * Sinf kunidagi darslarni YUQORIDAN ketma-ket kataklarga zichlaydi.
 *
 * ⚠️ Bu funksiya bir marta noto'g'ri yozilgan edi: "har bir darsni undan
 * oldingi birinchi bo'sh katakka ko'chir" degan qoida {4,5,6} ni {1,5,6} ga
 * aylantirib, teshikni YOPISH o'rniga OCHIB qo'yardi. To'g'ri qoida teskari
 * tomondan qaraydi — maqsad kataklari boshidan to'ldiriladi.
 *
 * Teshikni yopib bo'lmasa (o'qituvchi o'sha katakda band yoki dars qadalgan)
 * shu yerda to'xtaydi: keyingi darslarni surish yangi teshik ochardi.
 */
function compactClassDay(board, classId, day, ctx) {
  const { busy, settings } = ctx;
  const count = board.classDayOrders(classId, day).size;
  if (count === 0) return;

  for (let i = 0; i < count; i += 1) {
    const target = board.orders[i];
    if (target === undefined) return;
    if (board.classAt(classId, day, target)) continue; // joyida

    const laterOrders = [...board.classDayOrders(classId, day)]
      .filter((order) => order > target)
      .sort((a, b) => a - b);

    let filled = false;
    for (const from of laterOrders) {
      const lesson = board.classAt(classId, day, from);
      if (!lesson || lesson.isPinned) continue;
      if (board.teacherAt(lesson.teacherId, day, target)) continue;
      if (busy.has(busyKey(lesson.teacherId, day, target))) continue;
      if (
        settings.avoidConsecutiveSame &&
        hasSameSubjectNeighbour(board, classId, day, target, lesson.subjectId, lesson)
      ) {
        continue;
      }

      board.remove(lesson);
      lesson.order = target;
      board.place(lesson);
      filled = true;
      break;
    }

    if (!filled) return;
  }
}

module.exports = {
  SCHEDULE_DAYS,
  UNPLACED_REASONS,
  resolveWorkDays,
  resolveOrders,
  createRandom,
  buildDemands,
  createBoard,
  busyKey,
  gapCount,
  canPlace,
  scorePlacement,
  compactClassDay,
  keepsClassContiguous,
  hasSameSubjectNeighbour,
};
