/**
 * OTA-ONA NAZORATI — PUSH XABARLARI (sof funksiyalar).
 *
 * ⚠️ `data` KALITLARI VA `channels` — MOBIL ILOVALAR BILAN SHARTNOMA
 * (`taskPush.helpers.js` naqshi). Ularni o'zgartirish yangilanmagan ilovani
 * jimgina "kar" qilib qo'yadi:
 *
 *   type               kimga (seans kanali)   turi       data
 *   parental_policy    student                jim        version, branchId
 *   parental_unlock    student                ko'rinadi  requestId, appId, appKey, minutes, until, branchId
 *   parental_unlock_denied student            ko'rinadi  requestId, appId, appKey, branchId
 *   parental_alert     parent                 ko'rinadi  event, deviceId, appKey?, branchId
 *   parental_request   parent                 ko'rinadi  requestId, appId, appKey, appName, minutes, branchId
 *
 * ⚠️ KANAL MAJBURIY: ota-ona va bola telefoni — bitta `userId`. `channels`
 * siz yuborilgan jim policy ota-ona telefonini ham uyg'otar, ota-onaga
 * ketadigan ogohlantirish esa bolaning ekranida chiqardi.
 *
 * ⚠️ PUSH — TEZLATGICH, KAFOLAT EMAS (`devicePush.helpers.js` doktrinasi):
 * qurilma policy'ni baribir o'zi so'raydi, tasdiqlangan ruxsat esa policy'ning
 * `unlocks` maydoniga ham tushadi. Yuborish hech qachon kutilmaydi.
 *
 * Barcha qiymatlar STRING bo'lib ketadi (`push.service` → `stringifyData`).
 */

/** Push `data.type` qiymatlari. */
const PARENTAL_PUSH_TYPES = Object.freeze({
  POLICY: "parental_policy",
  UNLOCK: "parental_unlock",
  UNLOCK_DENIED: "parental_unlock_denied",
  ALERT: "parental_alert",
  REQUEST: "parental_request",
});

/** `parental_alert.event` qiymatlari. */
const PARENTAL_ALERT_EVENTS = Object.freeze({
  PERMISSION_REVOKED: "permission_revoked",
  UNINSTALL_ATTEMPT: "uninstall_attempt",
  WRONG_PIN: "wrong_pin",
  OFFLINE: "offline",
  PROTECTION_RESTORED: "protection_restored",
  PIN_RESET: "pin_reset",
});

/** Android bildirishnoma kanali — ilovalarda shu id bilan ochiladi. */
const PARENTAL_CHANNEL_ID = "parental";

/** Seans kanallari — push qaysi telefonga boradi. */
const TO_CHILD = Object.freeze(["student"]);
const TO_PARENT = Object.freeze(["parent"]);

const truncate = (text, max) => {
  const value = String(text || "").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

/** "Aziz" yoki bo'sh bo'lsa "Farzandingiz". */
const childName = (name) => truncate(name, 60) || "Farzandingiz";

/** "«Instagram»" yoki "ilova". */
const appLabel = (appName) => (appName ? `«${truncate(appName, 60)}»` : "ilova");

/**
 * POLICY O'ZGARDI — bolaning telefoniga JIM push, faqat versiya.
 * Qurilma `GET /parental/device/policy?version=N` bilan yangisini oladi.
 */
function policyChanged({ version, branchId }) {
  return {
    silent: true,
    channels: [...TO_CHILD],
    data: { type: PARENTAL_PUSH_TYPES.POLICY, version, branchId },
  };
}

/**
 * RUXSAT BERILDI — ota-ona bolaning so'rovini tasdiqladi (bolaga, ko'rinadi).
 *
 * @param {{ requestId: string, appId?: string|null, appKey?: string|null, appName?: string|null,
 *           minutes: number, until: Date, branchId?: string }} input
 */
function unlockGranted({ requestId, appId, appKey, appName, minutes, until, branchId }) {
  return {
    title: "Ruxsat berildi",
    body: appKey
      ? `${appLabel(appName)} ${minutes} daqiqaga ochildi`
      : `Telefon ${minutes} daqiqaga ochildi`,
    channelId: PARENTAL_CHANNEL_ID,
    channels: [...TO_CHILD],
    data: {
      type: PARENTAL_PUSH_TYPES.UNLOCK,
      requestId,
      appId: appId || undefined,
      appKey: appKey || undefined,
      minutes,
      until: until instanceof Date ? until.toISOString() : until,
      branchId,
    },
  };
}

/**
 * RUXSAT BERILMADI — ota-ona so'rovni rad etdi (bolaga, ko'rinadi). Busiz
 * bola 15 daqiqa javob kutib qolardi.
 *
 * @param {{ requestId: string, appId?: string|null, appKey?: string|null, appName?: string|null,
 *           branchId?: string }} input
 */
function unlockDenied({ requestId, appId, appKey, appName, branchId }) {
  return {
    title: "Ruxsat berilmadi",
    body: appKey
      ? `Ota-onangiz ${appLabel(appName)} uchun ruxsat bermadi`
      : "Ota-onangiz telefonni ochishga ruxsat bermadi",
    channelId: PARENTAL_CHANNEL_ID,
    channels: [...TO_CHILD],
    data: {
      type: PARENTAL_PUSH_TYPES.UNLOCK_DENIED,
      requestId,
      appId: appId || undefined,
      appKey: appKey || undefined,
      branchId,
    },
  };
}

/** Ogohlantirish matnlari — `event` bo'yicha. */
const ALERT_TEXTS = {
  [PARENTAL_ALERT_EVENTS.PERMISSION_REVOKED]: ({ name }) => ({
    title: "Himoya o'chirildi",
    body: `${name} telefonida ota-ona nazorati o'chirildi`,
  }),
  [PARENTAL_ALERT_EVENTS.UNINSTALL_ATTEMPT]: ({ name }) => ({
    title: "Ilovani o'chirishga urinish",
    body: `${name} telefonidan nazorat ilovasini o'chirishga urinildi`,
  }),
  [PARENTAL_ALERT_EVENTS.WRONG_PIN]: ({ name, attempts }) => ({
    title: "Noto'g'ri PIN",
    body: attempts
      ? `${name}: PIN ketma-ket ${attempts} marta noto'g'ri kiritildi`
      : `${name}: PIN bir necha marta noto'g'ri kiritildi`,
  }),
  [PARENTAL_ALERT_EVENTS.OFFLINE]: ({ name }) => ({
    title: "Telefon aloqaga chiqmadi",
    body: `${name} telefoni 24 soatdan beri aloqaga chiqmadi`,
  }),
  [PARENTAL_ALERT_EVENTS.PROTECTION_RESTORED]: ({ name }) => ({
    title: "Himoya tiklandi",
    body: `${name} telefonida ota-ona nazorati qayta yoqildi`,
  }),
  [PARENTAL_ALERT_EVENTS.PIN_RESET]: () => ({
    title: "PIN tiklandi",
    body: "Ota-ona nazorati PIN kodi hisob paroli bilan tiklandi. Bu siz bo'lmasangiz, PIN'ni darhol almashtiring",
  }),
};

/**
 * MUHIM HODISA — ota-onaga (ko'rinadi).
 *
 * @param {{ event: string, name?: string, deviceId?: string|null, appKey?: string|null,
 *           attempts?: number, branchId?: string }} input
 */
function alert({ event, name, deviceId, appKey, attempts, branchId }) {
  const text = ALERT_TEXTS[event];
  if (!text) throw new Error(`Noma'lum ota-ona ogohlantirishi: ${event}`);

  return {
    ...text({ name: childName(name), attempts }),
    channelId: PARENTAL_CHANNEL_ID,
    channels: [...TO_PARENT],
    data: {
      type: PARENTAL_PUSH_TYPES.ALERT,
      event,
      deviceId: deviceId || undefined,
      appKey: appKey || undefined,
      branchId,
    },
  };
}

/**
 * RUXSAT SO'ROVI — bola ota-onadan vaqt so'radi (ota-onaga, ko'rinadi).
 *
 * @param {{ requestId: string, appId?: string|null, appKey?: string|null, appName?: string|null,
 *           minutes: number, name?: string, branchId?: string }} input
 */
function unlockRequested({ requestId, appId, appKey, appName, minutes, name, branchId }) {
  return {
    title: "Ruxsat so'rovi",
    body: appKey
      ? `${childName(name)} ${appLabel(appName)} uchun ${minutes} daqiqa so'rayapti`
      : `${childName(name)} telefonni ${minutes} daqiqaga ochishni so'rayapti`,
    channelId: PARENTAL_CHANNEL_ID,
    channels: [...TO_PARENT],
    data: {
      type: PARENTAL_PUSH_TYPES.REQUEST,
      requestId,
      appId: appId || undefined,
      appKey: appKey || undefined,
      appName: appName ? truncate(appName, 200) : undefined,
      minutes,
      branchId,
    },
  };
}

module.exports = {
  PARENTAL_PUSH_TYPES,
  PARENTAL_ALERT_EVENTS,
  PARENTAL_CHANNEL_ID,
  policyChanged,
  unlockGranted,
  unlockDenied,
  alert,
  unlockRequested,
};
