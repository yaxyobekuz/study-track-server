/**
 * XODIMLAR TOPSHIRIQLARI — TARMOQ HISOBOTINING ARIFMETIKASI.
 *
 * Bu hisobot umumiy birlashtiruvchidan ATAYLAB chetlab o'tadi
 * (`aggregateRoute.registry.js` → `anchor`), ya'ni filiallarni qo'shish
 * mas'uliyati `taskNetwork.service.js` ning o'zida. Shuning uchun bu
 * yerda aynan O'SHA uchta xato sinaladi — ular bo'lsa hujjatdagi raqam
 * jimgina yolg'on bo'lardi:
 *
 *  1. FOIZ filiallar o'rtachasi sifatida chiqishi (400 topshiriqli filial
 *     3 topshiriqli filial bilan teng vazn olishi);
 *  2. O'RTACHA VAQT og'irliksiz qo'shilishi;
 *  3. REYTING va IJROCHILAR SONI ulanib qolishi (har filialning birinchi
 *     beshtasi ketma-ket, bir odam ikki marta sanalishi).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  combineReports,
  combinePulse,
} = require("../src/services/taskNetwork.service");

const branch = (id, name) => ({ id, name, shortName: name });

const person = (userId, name, role, over) => ({
  userId,
  name,
  role,
  assigned: 0,
  completed: 0,
  inProgress: 0,
  review: 0,
  overdue: 0,
  stopped: 0,
  onTime: 0,
  late: 0,
  rejected: 0,
  penaltyPoints: 0,
  rate: null,
  onTimeRate: null,
  avgCompletionMinutes: null,
  ...over,
});

/** Bitta filial hisobotining soddalashtirilgan nusxasi. */
const report = ({
  total,
  completed,
  stopped = 0,
  overdue = 0,
  inProgress = 0,
  review = 0,
  assignees,
  avgCompletionMinutes,
  completionSamples,
  people,
  timing = { early: 0, lastDay: 0, late: 0 },
  trend,
  dueSoonHours = 24,
  liveOverdue = 0,
}) => ({
  period: { from: "2026-10-01", to: "2026-10-02", days: 2, granularity: "day", label: "1-oktabr, 2026 — 2-oktabr, 2026" },
  kpis: {
    total,
    completed,
    inProgress,
    review,
    stopped,
    overdue,
    rejected: 0,
    extended: 0,
    penalized: 0,
    penaltyPoints: 0,
    assignees,
    completionRate: Math.round((completed / (total - stopped)) * 1000) / 10,
    onTimeRate: null,
    avgCompletionMinutes,
    avgReviewMinutes: null,
    completionSamples,
    reviewSamples: 0,
  },
  previous: { total: 10, completed: 5, stopped: 2, completionRate: 62.5 },
  breakdown: [],
  timing,
  kinds: [
    { key: "main", total, completed, overdue, inProgress, review, stopped, rate: null },
    { key: "extra", total: 0, completed: 0, overdue: 0, inProgress: 0, review: 0, stopped: 0, rate: null },
  ],
  trend,
  weekday: Array.from({ length: 7 }, (_, index) => ({ index, created: index, completed: 0 })),
  people,
  leaders: [],
  attention: [],
  byRole: [],
  creators: [],
  live: {
    overdue: [],
    dueSoon: [],
    review: [],
    counts: { overdue: liveOverdue, dueSoon: 0, review: 0 },
    dueSoonHours,
  },
  generatedAt: new Date(),
});

/**
 * KATTA va KICHIK filial. Aynan shu nisbat og'irliksiz o'rtachani
 * fosh qiladi: 80% va 25% ning oddiy o'rtachasi 52,5% bo'lardi,
 * haqiqiy raqam esa 77,9%.
 */
const fixture = () => {
  const big = report({
    total: 100,
    completed: 80,
    overdue: 11,
    inProgress: 8,
    review: 1,
    assignees: 2,
    avgCompletionMinutes: 100,
    completionSamples: 80,
    timing: { early: 50, lastDay: 20, late: 10 },
    dueSoonHours: 24,
    liveOverdue: 11,
    trend: [
      { key: "2026-10-01", label: "1-oktabr, 2026", created: 60, completed: 50 },
      { key: "2026-10-02", label: "2-oktabr, 2026", created: 40, completed: 30 },
    ],
    people: [
      person("u1", "Ali Valiyev", "teacher", {
        assigned: 60, completed: 55, inProgress: 3, review: 1, overdue: 1, rate: 91.7, onTimeRate: 90,
      }),
      person("u2", "Vali Aliyev", "admin", {
        assigned: 40, completed: 25, inProgress: 5, overdue: 10, rate: 62.5, onTimeRate: 70,
      }),
    ],
  });

  const small = report({
    total: 4,
    completed: 1,
    overdue: 3,
    assignees: 1,
    avgCompletionMinutes: 1000,
    completionSamples: 1,
    timing: { early: 0, lastDay: 1, late: 0 },
    dueSoonHours: 48,
    liveOverdue: 3,
    trend: [
      { key: "2026-10-01", label: "1-oktabr, 2026", created: 3, completed: 1 },
      { key: "2026-10-02", label: "2-oktabr, 2026", created: 1, completed: 0 },
    ],
    people: [
      person("u1", "Ali Valiyev", "teacher", {
        assigned: 4, completed: 1, overdue: 3, rate: 25, onTimeRate: 100,
      }),
    ],
  });

  return combineReports({
    reports: [
      { branch: branch("b1", "MBSI"), report: big },
      { branch: branch("b2", "AiHub"), report: small },
    ],
    partial: ["WebKing"],
    roles: [{ value: "teacher", name: "O'qituvchi" }],
  });
};

test("sanoqchilar qo'shiladi, foiz esa YIG'INDIDAN qayta hisoblanadi", () => {
  const net = fixture();

  assert.equal(net.kpis.total, 104);
  assert.equal(net.kpis.completed, 81);
  assert.equal(net.kpis.overdue, 14);

  // 81 ÷ 104 = 77,88… → 77,9. Filiallar o'rtachasi bo'lsa 52,5 chiqardi.
  assert.equal(net.kpis.completionRate, 77.9);
  assert.notEqual(net.kpis.completionRate, 52.5);
});

test("o'rtacha vaqt OG'IRLIK bilan qo'shiladi", () => {
  const net = fixture();

  // (100 × 80 + 1000 × 1) ÷ 81 = 111,1 → 111 daqiqa.
  // Og'irliksiz o'rtacha 550 daqiqa bo'lib, "ish 9 soatda bajarilyapti"
  // degan yolg'on xulosa berardi.
  assert.equal(net.kpis.avgCompletionMinutes, 111);
});

test("o'z vaqtida foizi birlashtirilgan taqsimotdan chiqadi", () => {
  const net = fixture();

  assert.deepEqual(net.timing, { early: 50, lastDay: 21, late: 10 });
  // (50 + 21) ÷ 81 = 87,65… → 87,7
  assert.equal(net.kpis.onTimeRate, 87.7);
});

test("IJROCHILAR TAKRORSIZ sanaladi, qatorlar esa filial bo'yicha ajratiladi", () => {
  const net = fixture();

  // Ali ikkala filialda ishlaydi: `assignees` ni qo'shib yuborilsa 3
  // chiqardi — holbuki odam ikkita.
  assert.equal(net.kpis.assignees, 2);

  // Qatorlar esa ATAYLAB ajratilgan: topshiriq filialga tegishli.
  assert.equal(net.people.length, 3);
  const ali = net.people.filter((row) => row.userId === "u1");
  assert.deepEqual(
    ali.map((row) => row.branchName).sort(),
    ["AiHub", "MBSI"],
  );
});

test("reyting QAYTA saralanadi — filiallar ro'yxati ulanmaydi", () => {
  const net = fixture();

  assert.deepEqual(
    net.leaders.map((row) => `${row.name} (${row.branchName})`),
    [
      "Ali Valiyev (MBSI)",
      "Vali Aliyev (MBSI)",
      "Ali Valiyev (AiHub)",
    ],
  );

  // E'tibor ro'yxati — muddati o'tganlar bo'yicha kamayish tartibida
  assert.deepEqual(
    net.attention.map((row) => row.overdue),
    [10, 3, 1],
  );
});

test("rollar kesimi filiallar bo'ylab QO'SHILADI va nomi bilan keladi", () => {
  const net = fixture();

  const teacher = net.byRole.find((row) => row.role === "teacher");
  assert.equal(teacher.assigned, 64);
  assert.equal(teacher.completed, 56);
  // Bir odam ikki filialda — qator ikkita, shuning uchun "xodim" ham 2
  assert.equal(teacher.people, 2);
  assert.equal(teacher.roleName, "O'qituvchi");

  // Katalogda yo'q rol kaliti o'zi ko'rinadi — jim "Noma'lum" bo'lib qolmaydi
  assert.equal(net.byRole.find((row) => row.role === "admin").roleName, "admin");
});

test("dinamika KALIT bo'yicha qo'shiladi, yorliq saqlanadi", () => {
  const net = fixture();

  assert.deepEqual(net.trend, [
    { key: "2026-10-01", label: "1-oktabr, 2026", created: 63, completed: 51 },
    { key: "2026-10-02", label: "2-oktabr, 2026", created: 41, completed: 30 },
  ]);

  // Hafta kunlari indeks bo'yicha va TARTIBDA
  assert.deepEqual(
    net.weekday.map((row) => row.created),
    [0, 2, 4, 6, 8, 10, 12],
  );
});

test("filiallar kesimi javobda bor va ish qolgani yuqorida turadi", () => {
  const net = fixture();

  // ⚠️ Hujjatdagi "Filiallar kesimi" jadvali va kartadagi `BranchSplit`
  // ikkalasi ham shu ro'yxatdan oziqlanadi — u tushib qolsa hujjat
  // umuman qurilmasdi.
  assert.equal(net.byBranch.length, 2);
  assert.deepEqual(
    net.byBranch.map((row) => row.branchName),
    ["MBSI", "AiHub"],
  );
  assert.equal(net.byBranch[0].overdue, 11);
  assert.equal(net.byBranch[0].branchShortName, "MBSI");
});

test("jonli sanoqchilar qo'shiladi, SOZLAMA esa qo'shilmaydi", () => {
  const net = fixture();

  assert.equal(net.live.counts.overdue, 14);
  // 24 va 48 — sozlama: qo'shilsa 72 soat bo'lib, yorliq yolg'on bo'lardi
  assert.equal(net.live.dueSoonHours, 48);
});

test("tushib qolgan filial JIM qolmaydi", () => {
  const net = fixture();

  assert.equal(net.isNetwork, true);
  assert.equal(net.branch, null);
  assert.deepEqual(net.partial, ["WebKing"]);
  assert.deepEqual(
    net.branches.map((row) => row.name),
    ["MBSI", "AiHub"],
  );
});

test("oldingi davr foizi ham yig'indidan hisoblanadi", () => {
  const net = fixture();

  // (5 + 5) ÷ ((10 + 10) − (2 + 2)) = 10 ÷ 16 = 62,5
  assert.equal(net.previous.total, 20);
  assert.equal(net.previous.completed, 10);
  assert.equal(net.previous.completionRate, 62.5);
});

test("karta raqamlari hujjat bilan AYNI formuladan chiqadi", () => {
  const pulse = combinePulse({
    items: [
      {
        branch: branch("b1", "MBSI"),
        pulse: { total: 100, completed: 80, review: 1, inProgress: 8, overdue: 11, stopped: 0, period: { label: "x" } },
      },
      {
        branch: branch("b2", "AiHub"),
        pulse: { total: 4, completed: 1, review: 0, inProgress: 0, overdue: 3, stopped: 0, period: { label: "x" } },
      },
    ],
    partial: [],
  });

  assert.equal(pulse.total, 104);
  assert.equal(pulse.completed, 81);
  assert.equal(pulse.overdue, 14);
  // Hujjatdagi `completionRate` bilan AYNI raqam
  assert.equal(pulse.completionRate, 77.9);

  // Filiallar kesimi — jami bo'yicha kamayish tartibida
  assert.deepEqual(
    pulse.byBranch.map((row) => row.branchName),
    ["MBSI", "AiHub"],
  );
  assert.equal(pulse.byBranch[0].branchShortName, "MBSI");
});
