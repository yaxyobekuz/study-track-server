const test = require("node:test");
const assert = require("node:assert/strict");

const {
  haversineDistance,
  resolveLocation,
  parseCoords,
  LOCATION_STATUS,
  MAX_ACCURACY_BUFFER,
} = require("../src/helpers/geolocation.helpers");

// Toshkent, shartli ofis nuqtasi
const OFFICE = { lat: 41.311081, lng: 69.240562 };
const RADIUS = 100;

/** Ofisdan shimolga N metr siljigan nuqta (1° kenglik ≈ 111 320 m). */
const north = (meters) => ({
  lat: OFFICE.lat + meters / 111320,
  lng: OFFICE.lng,
});

test("haversine: bir xil nuqta orasidagi masofa — 0", () => {
  assert.equal(haversineDistance(OFFICE, OFFICE), 0);
});

test("haversine: ma'lum masofani ±1% aniqlikda beradi", () => {
  const d = haversineDistance(OFFICE, north(500));
  assert.ok(Math.abs(d - 500) < 5, `kutilgan ≈500, olingan ${d}`);
});

test("koordinata validatsiyasi: yaroqsiz qiymatlar null", () => {
  assert.equal(parseCoords("abc", 69.2), null);
  assert.equal(parseCoords(undefined, 69.2), null);
  assert.equal(parseCoords(NaN, 69.2), null);
  assert.equal(parseCoords(91, 69.2), null); // kenglik chegarasi
  assert.equal(parseCoords(41.3, 181), null); // uzunlik chegarasi
  assert.equal(parseCoords(0, 0), null); // "null island"
  assert.deepEqual(parseCoords("41.3", "69.2"), { lat: 41.3, lng: 69.2 });
});

test("ofis markazida, aniqlik yaxshi → inside", () => {
  const r = resolveLocation({ ...OFFICE, accuracy: 10 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.INSIDE);
  assert.equal(r.distance, 0);
  assert.equal(r.outOfOffice, false);
  assert.equal(r.locationWarning, false);
});

test("radiusdan ancha uzoq → outside", () => {
  const r = resolveLocation({ ...north(800), accuracy: 15 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.OUTSIDE);
  assert.equal(r.outOfOffice, true);
  assert.ok(r.distance > 700);
});

test("chegara zonasi: radius ichida, lekin aniqlik qaror qildirmaydi → edge", () => {
  // 80 m masofa, ±60 m aniqlik: 80+60 > 100, lekin 80−60 < 100
  const r = resolveLocation({ ...north(80), accuracy: 60 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.EDGE);
  assert.equal(r.outOfOffice, false, "chegara ayblovga aylanmaydi");
  assert.equal(r.locationWarning, true, "lekin jim ham qolmaydi");
});

test("SOXTALASHTIRISHGA QARSHI: ulkan accuracy 'ofisda' degan natija bermaydi", () => {
  const r = resolveLocation({ ...north(5000), accuracy: 100000 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.OUTSIDE);
  assert.equal(r.buffer, MAX_ACCURACY_BUFFER, "bufer cheklangan bo'lishi shart");
});

test("SOXTALASHTIRISHGA QARSHI: yomon aniqlik bilan 'inside' bo'lib bo'lmaydi", () => {
  const r = resolveLocation({ ...OFFICE, accuracy: 3000 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.EDGE);
  assert.equal(r.trusted, false);
});

test("yaroqsiz koordinata 'ofisda' emas, 'invalid' bo'ladi", () => {
  const r = resolveLocation({ lat: "abc", lng: "xyz", accuracy: 10 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.INVALID);
  assert.equal(r.outOfOffice, false);
  assert.equal(r.locationWarning, true);
  assert.equal(r.snapshot, null);
});

test("joylashuv kelmasa — missing (ilgari 'ofisda' bilan bir xil ko'rinardi)", () => {
  const r = resolveLocation({}, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.MISSING);
  assert.equal(r.locationWarning, true);
  assert.equal(r.distance, null);
});

test("ofis sozlanmagan → unconfigured, koordinata baribir saqlanadi", () => {
  const r = resolveLocation({ ...OFFICE, accuracy: 10 }, null, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.UNCONFIGURED);
  assert.equal(r.snapshot.lat, OFFICE.lat);
  assert.equal(r.distance, null);
});

test("ofis {lat: null} bo'lsa ham unconfigured deb qaraladi", () => {
  const r = resolveLocation({ ...OFFICE, accuracy: 10 }, { lat: null, lng: null }, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.UNCONFIGURED);
});

test("radius yaroqsiz bo'lsa 100 m ga qaytadi", () => {
  const r = resolveLocation({ ...north(500), accuracy: 5 }, OFFICE, "salom");
  assert.equal(r.status, LOCATION_STATUS.OUTSIDE);
});

test("manfiy accuracy bufer bermaydi", () => {
  const r = resolveLocation({ ...north(150), accuracy: -9999 }, OFFICE, RADIUS);
  assert.equal(r.status, LOCATION_STATUS.OUTSIDE);
  assert.equal(r.buffer, 0);
});

test("snapshot bazaga yoziladigan to'liq faktni saqlaydi", () => {
  const r = resolveLocation({ ...north(300), accuracy: 20 }, OFFICE, RADIUS);
  assert.deepEqual(Object.keys(r.snapshot).sort(), [
    "accuracy",
    "distance",
    "lat",
    "lng",
    "status",
  ]);
  assert.equal(r.snapshot.status, LOCATION_STATUS.OUTSIDE);
});
