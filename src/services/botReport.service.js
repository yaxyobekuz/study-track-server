/**
 * BOT FOYDALANUVCHILARI — HUJJAT KO'RINISHIDAGI HISOBOT.
 *
 * Bosh sahifadagi "Bot foydalanuvchilar" kartasining to'liq javobi:
 * nechta ota-ona botga ulangan, qancha o'quvchi qamrab olingan, kim
 * qolgan, kim ulangani bilan ishlatmayapti va xabarlar yetib boryaptimi.
 *
 * ──────────────────────────────────────────────────────────────────────
 * IKKINCHI DVIGATEL YOZILMAYDI
 * ──────────────────────────────────────────────────────────────────────
 *
 * Raqamlarni `activityDashboard.service.js` dagi `getOverview` beradi —
 * "Faollik" bo'limi va bosh sahifadagi karta ham AYNI shundan oziqlanadi.
 * Bu yerda faqat PROYEKSIYA bor: hujjatga tushadigan qatorlar tanlanadi
 * va tartibga solinadi. Nusxa ko'chirilsa, bitta ekranda 6,13%,
 * ikkinchisida 6,4% turib qolardi.
 *
 * ⚠️ QAMROV FOIZI "O'QIYOTGAN" O'QUVCHILARGA nisbatan: ketgan
 * o'quvchining ota-onasi hali botda tursa ham maxrajga kirmaydi
 * (`studyingStudentIds`). Boshqacha hisoblansa, qamrov o'z-o'zidan
 * pasayib ko'rinardi.
 *
 * ⚠️ RO'YXATLAR ALOHIDA RUXSAT BILAN (`activity.roster`): "qamrab
 * olinmagan o'quvchilar" va "jim turgan ota-onalar" — ism ro'yxati va u
 * bilan qo'ng'iroq qilinadi. Umumiy foizni ko'rish huquqi uni ochib
 * bermasligi kerak, shuning uchun qaror CHAQIRUVCHIDA (controller).
 */

const { getOverview } = require("./activityDashboard.service");

/** Hujjatdagi ro'yxatlarning uzunligi — ekranda ham, faylda ham AYNI. */
const TOP_UNLINKED = 60;
const TOP_SILENT = 40;

const rate = (part, whole) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

/**
 * BITTA FILIALNING HISOBOTI.
 *
 * @param {{days?: number|string}} [query]
 * @param {{branch?: object|null, withRoster?: boolean}} [options]
 */
const getBotReport = async (query = {}, options = {}) => {
  const { branch = null, withRoster = false } = options;

  const overview = await getOverview({ days: query.days, withRoster });

  const parents = overview.parents;
  const today = overview.today.bot;
  const newLinks =
    overview.metrics?.find((item) => item.key === "newLinks")?.value ?? 0;

  const totals = {
    linked: parents.linked,
    students: parents.students,
    linkedStudents: parents.linkedStudents,
    unlinked: parents.unlinked,
    coverage: rate(parents.linkedStudents, parents.students),
    todayActive: today.active,
    todayRate: today.rate,
    activeInPeriod: parents.active,
    activeRate: rate(parents.active, parents.linked),
    silent: parents.silent,
    notificationsOff: parents.notificationsOff,
    newLinks,
  };

  return {
    kind: "bot",
    period: {
      days: overview.period.days,
      rangeLabel: overview.period.rangeLabel,
      fromLabel: overview.period.fromLabel,
      toLabel: overview.period.toLabel,
    },
    branch,
    isNetwork: false,
    branches: branch ? [branch] : [],
    partial: [],
    generatedAt: new Date(),
    // ⚠️ Tarix yig'ilmagan bo'lsa hujjat buni AYTADI: 0% ni falokat
    // sifatida ko'rsatish yolg'on bo'lardi (hech kim yozmagan edi).
    collecting: overview.collecting,
    sinceLabel: overview.sinceLabel,
    todayLabel: overview.today.label,
    withRoster,
    totals,
    trend: overview.trend.map((row) => ({
      day: row.day,
      label: row.label,
      bot: row.bot,
    })),
    classes: overview.classes.map((row) => ({
      id: row.id,
      name: row.name,
      students: row.students,
      linkedStudents: row.linkedStudents,
      linkRate: row.linkRate,
      linked: row.linked,
      active: row.active,
      silent: row.silent,
      rate: row.rate,
    })),
    unlinkedStudents: (overview.roster?.unlinked ?? []).slice(0, TOP_UNLINKED),
    unlinkedTotal: overview.roster?.unlinkedTotal ?? 0,
    silentParents: (overview.roster?.silentParents ?? []).slice(0, TOP_SILENT),
    silentTotal: overview.roster?.silentParentsTotal ?? 0,
    delivery: overview.delivery,
  };
};

module.exports = { getBotReport, rate, TOP_UNLINKED, TOP_SILENT };
