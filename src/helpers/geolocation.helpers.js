/**
 * JOYLASHUV — QAYD ETISH PAYTIDAGI YAGONA HAQIQAT MANBAI.
 *
 * Bu yerda bitta savolga javob beriladi: "xodim qayd etganda ofis hududida
 * edimi?". Javob HA/YO'Q emas, chunki GPS o'zi ham HA/YO'Q emas — har bir
 * o'lchovda aniqlik radiusi bor. Shuning uchun natija UCH holatli:
 *
 *   inside   — ishonchli ichkarida  (distance + bufer <= radius)
 *   outside  — ishonchli tashqarida (distance − bufer >  radius)
 *   edge     — GPS aniqligi qaror qildirmaydi (ikkisi orasidagi zona)
 *
 * Ustiga ma'lumotning o'zi bo'lmagan uch holat:
 *
 *   missing       — qurilma joylashuvni bermadi (GPS o'chiq, ruxsat yo'q)
 *   invalid       — kelgan qiymat koordinata emas
 *   unconfigured  — ofis joylashuvi sozlanmagan, taqqoslashning o'zi yo'q
 *
 * ⚠️ NIMA UCHUN "edge" ALOHIDA: ilgari `withinOffice = !outOfOffice` edi,
 * ya'ni chegaradagi noaniq o'lchov "ichkarida" deb yozilardi. Aniqligi
 * 2 km bo'lgan bitta o'lchov ham shu yo'l bilan "ofisda" bo'lib qolardi.
 *
 * ⚠️ NIMA UCHUN BUFER CHEKLANGAN (`MAX_ACCURACY_BUFFER`): `accuracy`
 * MIJOZDAN keladi va uni hech kim tekshirmaydi. Cheklanmagan bufer bilan
 * telefondan `accuracy: 100000` yuborgan odam qayerda bo'lsa ham "ofisda"
 * bo'lardi — geotekshiruvning o'zi ma'nosini yo'qotardi. Bufer 200 m ga
 * cheklangani uchun radiusdan 200 m nariga chiqqan odam qanday aniqlik
 * yozmasin `outside` bo'ladi.
 */

/** Bufer sifatida ishonish mumkin bo'lgan eng katta aniqlik (metr). */
const MAX_ACCURACY_BUFFER = 200;

/** Shundan yomon o'lchov GPS emas — wifi/IP bo'yicha taxmin (metr). */
const UNRELIABLE_ACCURACY = 1000;

/** Foydalanuvchiga "aniqlik yaxshi emas" deb ko'rsatiladigan chegara (metr). */
const LOW_ACCURACY = 150;

const LOCATION_STATUS = {
  INSIDE: "inside",
  EDGE: "edge",
  OUTSIDE: "outside",
  MISSING: "missing",
  INVALID: "invalid",
  UNCONFIGURED: "unconfigured",
};

/** Yer radiusi (metr) — Haversine uchun. */
const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Ikkita koordinata orasidagi masofa (metr, Haversine).
 *
 * @param {{ lat: number, lng: number }} coord1
 * @param {{ lat: number, lng: number }} coord2
 * @returns {number} Metrda masofa
 */
function haversineDistance(coord1, coord2) {
  const dLat = toRad(coord2.lat - coord1.lat);
  const dLng = toRad(coord2.lng - coord1.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coord1.lat)) *
      Math.cos(toRad(coord2.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Mijozdan kelgan koordinatani tekshiradi.
 *
 * ⚠️ Raqam bo'lmagan qiymat `null` qaytaradi, `NaN` EMAS: ilgari `NaN`
 * arifmetikadan o'tib ketib, "ofisdan tashqarida emas" degan natija
 * berardi — ya'ni buzuq ma'lumot jimgina "ofisda" deb yozilardi.
 *
 * @param {*} lat
 * @param {*} lng
 * @returns {{ lat: number, lng: number }|null}
 */
function parseCoords(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) return null;
  if (latNum < -90 || latNum > 90) return null;
  if (lngNum < -180 || lngNum > 180) return null;

  // (0, 0) — Atlantika okeanidagi nuqta. Real qayd emas: bu odatda
  // to'ldirilmagan maydon yoki buzuq mijoz.
  if (latNum === 0 && lngNum === 0) return null;

  return { lat: latNum, lng: lngNum };
}

/**
 * Aniqlikni normallashtiradi: manfiy/raqam bo'lmagan qiymat — 0.
 *
 * @param {*} accuracy
 * @returns {number} Metrda aniqlik (xom qiymat, cheklanmagan)
 */
function parseAccuracy(accuracy) {
  const num = Number(accuracy);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

/**
 * Ofis joylashuvi sozlanganmi.
 *
 * ⚠️ `lat` 0 bo'lishi ham mumkin, shuning uchun truthy tekshiruv emas,
 * to'liq validatsiya ishlatiladi.
 *
 * @param {*} officeLocation
 * @returns {{ lat: number, lng: number }|null}
 */
function parseOfficeLocation(officeLocation) {
  if (!officeLocation || typeof officeLocation !== "object") return null;
  return parseCoords(officeLocation.lat, officeLocation.lng);
}

/** Radius yaroqsiz bo'lsa ishlatiladigan qiymat (metr). */
const DEFAULT_OFFICE_RADIUS = 100;

/**
 * Ofis radiusi (metr). Qayd etishdagi qaror ham, mijozga beriladigan radius
 * ham SHU funksiyadan — ilova bir radius bilan "hududdasiz" deb, server
 * boshqasi bilan "tashqarida" deb qaror chiqarmasligi uchun.
 *
 * @param {*} officeRadius
 * @returns {number}
 */
function parseOfficeRadius(officeRadius) {
  const radius = Number(officeRadius);
  return Number.isFinite(radius) && radius > 0 ? radius : DEFAULT_OFFICE_RADIUS;
}

/**
 * QAYD ETISH JOYLASHUVINI HAL QILADI.
 *
 * Bitta chaqiruv check-in va check-out uchun ham ishlatiladi — ikkita
 * mustaqil hisob bo'lsa, biri yangilanib ikkinchisi eskirib qolardi.
 *
 * @param {{ lat?: *, lng?: *, accuracy?: * }} payload - mijozdan kelgani
 * @param {*} officeLocation - `AttendanceSettings.officeLocation`
 * @param {*} officeRadius - `AttendanceSettings.officeRadius` (metr)
 * @returns {{
 *   status: string,
 *   distance: number|null,
 *   accuracy: number|null,
 *   buffer: number,
 *   trusted: boolean,
 *   lowAccuracy: boolean,
 *   outOfOffice: boolean,
 *   locationWarning: boolean,
 *   snapshot: object|null,
 * }}
 */
function resolveLocation(payload, officeLocation, officeRadius) {
  const { lat, lng, accuracy } = payload || {};

  const hasPayload = lat !== undefined && lat !== null && lng !== undefined && lng !== null;
  const coords = hasPayload ? parseCoords(lat, lng) : null;

  // ── Ma'lumotning o'zi yo'q ───────────────────
  if (!hasPayload) return buildResult(LOCATION_STATUS.MISSING, null, null, null);
  if (!coords) return buildResult(LOCATION_STATUS.INVALID, null, parseAccuracy(accuracy), null);

  const acc = parseAccuracy(accuracy);
  const office = parseOfficeLocation(officeLocation);

  // Ofis belgilanmagan — koordinata saqlanadi, lekin taqqoslash yo'q.
  if (!office) return buildResult(LOCATION_STATUS.UNCONFIGURED, coords, acc, null);

  const safeRadius = parseOfficeRadius(officeRadius);

  const distance = Math.round(haversineDistance(coords, office));
  const buffer = Math.min(acc, MAX_ACCURACY_BUFFER);

  let status;
  if (distance - buffer > safeRadius) {
    status = LOCATION_STATUS.OUTSIDE;
  } else if (distance + buffer <= safeRadius) {
    status = LOCATION_STATUS.INSIDE;
  } else {
    status = LOCATION_STATUS.EDGE;
  }

  return buildResult(status, coords, acc, distance, buffer);
}

/**
 * Natija obyektini yig'adi. `snapshot` — bazaga yoziladigan JSON:
 * koordinata, aniqlik, masofa va qaror BIR JOYDA saqlanadi, chunki
 * keyinchalik radius o'zgarsa eski qaror qayta hisoblanmasligi kerak.
 */
function buildResult(status, coords, accuracy, distance, buffer = 0) {
  const lowAccuracy = accuracy !== null && accuracy > LOW_ACCURACY;
  const trusted = accuracy !== null && accuracy <= UNRELIABLE_ACCURACY;

  return {
    status,
    distance: distance ?? null,
    accuracy: accuracy ?? null,
    buffer,
    trusted,
    lowAccuracy,
    // Bayroqlar — eski ustunlar uchun. Faqat "ishonchli tashqarida" holati
    // ayblovga aylanadi; qolgan noaniqliklar ogohlantirish bo'lib qoladi.
    outOfOffice: status === LOCATION_STATUS.OUTSIDE,
    locationWarning: status !== LOCATION_STATUS.INSIDE,
    snapshot: coords
      ? {
          lat: coords.lat,
          lng: coords.lng,
          accuracy,
          distance: distance ?? null,
          status,
        }
      : null,
  };
}

module.exports = {
  haversineDistance,
  resolveLocation,
  parseCoords,
  parseOfficeLocation,
  parseOfficeRadius,
  LOCATION_STATUS,
  MAX_ACCURACY_BUFFER,
  UNRELIABLE_ACCURACY,
  LOW_ACCURACY,
};
