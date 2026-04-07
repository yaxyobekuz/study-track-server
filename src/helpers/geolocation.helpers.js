/**
 * Ikkita koordinata orasidagi masofani metrda hisoblaydi (Haversine formulasi)
 * @param {{ lat: number, lng: number }} coord1
 * @param {{ lat: number, lng: number }} coord2
 * @returns {number} Metrda masofa
 */
function haversineDistance(coord1, coord2) {
  const R = 6371000; // Yer radiusi (metr)
  const toRad = (deg) => (deg * Math.PI) / 180;

  const dLat = toRad(coord2.lat - coord1.lat);
  const dLng = toRad(coord2.lng - coord1.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(coord1.lat)) *
      Math.cos(toRad(coord2.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Foydalanuvchi ofis hududida ekanligini tekshiradi.
 * Accuracy ni bufer sifatida ishlatadi — agar distance - accuracy <= officeRadius bo'lsa true.
 * @param {number} lat Foydalanuvchi kengligi
 * @param {number} lng Foydalanuvchi uzunligi
 * @param {number} accuracy GPS aniqligi (metr)
 * @param {number} officeLat Ofis kengligi
 * @param {number} officeLng Ofis uzunligi
 * @param {number} officeRadius Ofis hududi radiusi (metr)
 * @returns {{ withinOffice: boolean, distance: number, outOfOffice: boolean, locationWarning: boolean }}
 */
function checkOfficeLocation(lat, lng, accuracy, officeLat, officeLng, officeRadius) {
  const distance = haversineDistance(
    { lat, lng },
    { lat: officeLat, lng: officeLng }
  );

  // GPS aniqligi past bo'lsa ogohlantirish
  const lowAccuracy = accuracy > 150;

  // Aniq tashqarida: distance - accuracy > officeRadius
  const outOfOffice = distance - accuracy > officeRadius;

  // Chegarada (noaniq zona): distance > officeRadius lekin distance - accuracy <= officeRadius
  const locationWarning = outOfOffice || lowAccuracy;

  return {
    withinOffice: !outOfOffice,
    distance: Math.round(distance),
    outOfOffice,
    locationWarning,
  };
}

module.exports = { haversineDistance, checkOfficeLocation };
