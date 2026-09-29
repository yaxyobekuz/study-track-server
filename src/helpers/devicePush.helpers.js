/**
 * QURILMA NAZORATI — PUSH XABARLARI.
 *
 * ⚠️ `data` KALITLARI MOBIL ILOVA BILAN SHARTNOMA (`taskPush.helpers.js`
 * bilan bir xil naqsh): `type`, `event`, `policyId`, `version`. Ularni
 * o'zgartirish ilovaning yangilanmagan versiyasini jimgina "kar" qilib
 * qo'yadi — cheklov o'zgargani bilan telefonga yetib bormaydi.
 *
 * ⚠️ PUSH — TEZLATGICH, KAFOLAT EMAS. Qurilma baribir `syncIntervalMinutes`
 * da profilni o'zi so'raydi: Firebase ishlamay qolsa yoki telefon oflayn
 * bo'lsa, yangi qoida keyingi sinxronizatsiyada yetadi. Shuning uchun
 * yuborish hech qachon kutilmaydi va hech qachon xato tashlamaydi
 * (`push.service.js` doktrinasi).
 *
 * ⚠️ MATNDA CHEKLOVNING SABABI YOZILADI. "Qoida o'zgardi" degan quruq
 * xabar bolani telefoni nega yopilganini bilmay qoldiradi — u holda u
 * ota-onasiga emas, chetlab o'tish yo'liga murojaat qiladi.
 */

const PUSH_TYPE = "device_policy";

/** Android bildirishnoma kanali — ilovada shu nom bilan ochilgan. */
const CHANNEL_ID = "device_policy";

/** Siyosat o'zgardi / biriktirildi. */
function policyUpdated({ policyName, version, policyId }) {
  return {
    title: "Telefon qoidasi yangilandi",
    body: policyName
      ? `Endi «${policyName}» qoidasi amal qiladi. Tafsilotini ilovada ko'rishingiz mumkin.`
      : "Telefoningizga yangi qoida qo'llandi. Tafsilotini ilovada ko'rishingiz mumkin.",
    channelId: CHANNEL_ID,
    data: { type: PUSH_TYPE, event: "updated", policyId, version },
  };
}

/** Biriktirish olib tashlandi — cheklov tugadi. */
function policyCleared() {
  return {
    title: "Telefon cheklovi olib tashlandi",
    body: "Telefoningizga qo'llangan qoida bekor qilindi.",
    channelId: CHANNEL_ID,
    data: { type: PUSH_TYPE, event: "cleared" },
  };
}

/** Vaqtinchalik ochish berildi. */
function unlockGranted({ until, reason, kind }) {
  return {
    title: "Telefon vaqtincha ochildi",
    body: reason
      ? `${until} gacha: ${reason}`
      : `Cheklov ${until} gacha to'xtatildi.`,
    channelId: CHANNEL_ID,
    data: { type: PUSH_TYPE, event: "unlocked", kind },
  };
}

/** Vaqtinchalik ochish bekor qilindi. */
function unlockCancelled({ reason }) {
  return {
    title: "Vaqtinchalik ruxsat bekor qilindi",
    body: reason ? `Sabab: ${reason}` : "Telefon qoidasi yana amal qiladi.",
    channelId: CHANNEL_ID,
    data: { type: PUSH_TYPE, event: "unlock_cancelled" },
  };
}

/** Qurilma biriktirildi (o'quvchining o'ziga tasdiq). */
function deviceEnrolled({ label }) {
  return {
    title: "Qurilma biriktirildi",
    body: label
      ? `«${label}» maktab qoidalariga ulandi.`
      : "Qurilmangiz maktab qoidalariga ulandi.",
    channelId: CHANNEL_ID,
    data: { type: PUSH_TYPE, event: "enrolled" },
  };
}

module.exports = {
  PUSH_TYPE,
  CHANNEL_ID,
  policyUpdated,
  policyCleared,
  unlockGranted,
  unlockCancelled,
  deviceEnrolled,
};
