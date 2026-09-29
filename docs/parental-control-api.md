# Ota-ona nazorati — API va push shartnomasi (mobil jamoa uchun)

Server: `study-track-server`, prefiks `/api/parental`. Ikki ilova, **bitta
o'quvchi hisobi**:

| Ilova | `X-Client` | Yo'llar |
|---|---|---|
| Ota-ona ilovasi | `parent` | `/api/parental/*` |
| O'quvchi ilovasi (bolaning telefoni) | `student` | `/api/parental/device/*` |

Blokni **o'quvchi ilovasi** qo'llaydi. Server qoidani (policy) saqlaydi,
versiyalaydi, bolaning telefoniga jim push yuboradi va statistikani qabul
qiladi.

---

## 1. Sarlavhalar

| Sarlavha | Kim | Majburiy |
|---|---|---|
| `Authorization: Bearer <access token>` | ikkalasi | ha (odatdagi login) |
| `X-Client: parent` / `X-Client: student` | ikkalasi | **ha — LOGIN so'rovida ham** |
| `X-Device-Id` | ikkalasi | `/device/*` da majburiy; 16–64 belgi `[A-Za-z0-9_-]`, o'rnatishda bir marta yaratiladi va saqlanadi |
| `X-Parental-Token` | ota-ona | [T] belgili amallarda |

⚠️ **Kanal login paytida seansga yoziladi.** `X-Client: parent` login
so'rovida yuborilmasa, seans `admin` kanalida ochiladi va ota-ona amallari
`403 parent_channel_required` qaytaradi — qayta login kerak bo'ladi.
Push ham kanal bo'yicha yo'naltiriladi (§6).

⚠️ Push tokenini (`POST /api/push/devices`) har login va token yangilanishidan
keyin yuboring — push shu seans kanaliga bog'lanadi. Ota-ona ilovasiga faqat
unga atalgan push'lar (§6) boradi; boshqa o'quvchi bildirishnomalari
(maktab xabarlari) unga tushmaydi. Ikkala ilova ham `data.type = "ping"`
(ovozsiz tekshiruv) ni jimgina e'tiborsiz qoldirishi SHART.

⚠️ Filial almashtirishda (`/auth/switch-branch`) kanal eski seansdan
olinadi — `X-Client` sarlavhasi uni o'zgartirmaydi.

## 2. Javob va xato shakli

```json
{ "success": true, "data": { ... } }
{ "success": true, "data": [ ... ], "pagination": { "page", "limit", "total", "totalPages", "hasNextPage", "hasPrevPage" } }
{ "success": false, "message": "PIN noto'g'ri", "details": { "reason": "wrong_pin", "attemptsLeft": 2 } }
```

Xatoni **`details.reason`** bo'yicha ajrating (matn o'zgarishi mumkin):

| HTTP | `reason` | Ma'nosi / ilova nima qiladi |
|---|---|---|
| 401 | `wrong_pin` | PIN noto'g'ri, `details.attemptsLeft`. ⚠️ Bu 401 — **logout QILMANG** |
| 401 | `session_ended` yoki `reason` yo'q | seans tugagan → login |
| 429 | `pin_locked` | ko'p xato, `details.retryAfterSec` |
| 429 | `pin_busy` | shu hisobda PIN hozir tekshirilmoqda — `retryAfterSec` (1) dan keyin qayta |
| 429 | `pin_reset_rate_limited` | 15 daqiqada 5 tadan ko'p tiklash urinishi |
| 429 | `unlock_rate_limited` | 10 daqiqada 3 tadan ko'p ruxsat so'rovi |
| 403 | `parental_token_required` | PIN oynasini oching → `pin/verify` |
| 403 | `parental_token_invalid` | token eskirgan/boshqa seansniki → PIN'ni qayta so'rang |
| 403 | `parent_channel_required` | amal faqat ota-ona ilovasidan (`X-Client: parent` bilan login) |
| 403 | `child_channel_required` | `/device/*` ota-ona ilovasidan chaqirilgan |
| 403 | `student_account_required` | hisob o'quvchiniki emas |
| 403 | `wrong_password` | PIN tiklashda parol noto'g'ri |
| 409 | `pin_not_set` | PIN hali o'rnatilmagan |
| 409 | `device_not_registered` | avval `POST /device/register` |
| 409 | `device_limit` | hisobda 20 ta qurilma (eski jim qurilmalar avtomat bo'shatiladi) |
| 409 | `already_decided` / `expired` | ruxsat so'rovi allaqachon hal bo'lgan / muddati o'tgan |
| 400 | `device_id_required` | `X-Device-Id` yo'q yoki shakli noto'g'ri |

Barcha `*Label` maydonlari tayyor o'zbekcha matn (`21-may, 2026 14:30`).
Vaqtlar — ISO 8601 UTC (`2026-09-28T09:15:00.000Z`), kunlar — `YYYY-MM-DD`
(Toshkent kuni).

## 3. PIN va parental token

### 3.1. Hash (Android / iOS internetsiz takrorlaydi)

```
hash = PBKDF2-HMAC-SHA256(pin utf8, salt (hex → bytes), iterations, 32 bayt) → kichik hex
```

Policy'da keladi: `pin: { algo: "pbkdf2-sha256", hash, salt, iterations }`.
`iterations` ni **policy'dan oling** (qat'iy yozmang). Taqqoslash — doimiy vaqtli.

**Test vektori (majburiy):**

```
pin = "1234", salt(hex) = "000102030405060708090a0b0c0d0e0f", iterations = 100000
kutilgan = 869e6c8350c5beb0acc399fbaac3b60d220433896b26a647734d0d8f1586e1fa
```

### 3.2. Hayot sikli

| Holat | So'rov |
|---|---|
| PIN yo'q | `POST /parental/pin { pin }` — tokensiz |
| Almashtirish | `POST /parental/pin { pin }` + `X-Parental-Token` |
| Unutilgan | `POST /parental/pin/reset { password, pin }` — hisob paroli |
| Tasdiqlash | `POST /parental/pin/verify { pin }` → `{ parentalToken, expiresAt }` |

- PIN — faqat 4 raqam (`^\d{4}$`).
- 5 ketma-ket xato → 1 daqiqa blok; blokdan keyingi har xato — 5, 15, 60 daqiqa.
  To'g'ri PIN hisoblagichni 0 qiladi. 3-xatodan boshlab ota-onaga push.
- `parentalToken` — 15 daqiqa, **faqat shu seansda** (boshqa telefon yoki
  qayta login bilan ishlamaydi). Xotirada saqlang; 403
  `parental_token_*` kelsa PIN'ni qayta so'rang.
- ⚠️ Token **PIN versiyasiga bog'langan**: PIN o'rnatilsa, almashtirilsa yoki
  tiklansa eski tokenlar darhol yaroqsiz. Shuning uchun `/pin` va `/pin/reset`
  javobida YANGI `parentalToken` + `expiresAt` keladi — eskisini shu bilan
  almashtiring.
- Har PIN o'zgarishida `policyVersion` oshadi va bolaning telefoniga jim push ketadi.
- ⚠️ PIN parol bilan tiklanganda ota-onaga ko'rinadigan push (`pin_reset`) boradi.

## 4. Ota-ona ilovasi — `/api/parental`

[T] — `X-Parental-Token` majburiy. Hammasi `X-Client: parent` seansidan.
O'qish yo'llari (status, usage, apps, events, unlock-requests GET) tokensiz.

### `GET /status`

```json
{
  "pinSet": true, "pinUpdatedAt": "…", "pinUpdatedAtLabel": "28-sentabr, 2026 14:15",
  "lockAll": false, "lockAllUntil": null, "lockAllUntilLabel": null,
  "unlockMinutes": 30, "policyVersion": 17, "pendingRequests": 1,
  "devices": [{
    "deviceId": "…", "platform": "android", "model": "SM-A546E", "osVersion": "14", "appVersion": "2.3.0",
    "protected": true, "health": { "usageAccess": true, "accessibility": true, "deviceAdmin": true,
      "overlay": true, "batteryOk": false, "familyControls": false, "reportedAt": "…" },
    "lastSeenAt": "…", "lastSeenLabel": "28-sentabr, 2026 14:10", "online": true
  }]
}
```

`online` — oxirgi 30 daqiqada ko'ringan.

### `POST /pin`, `POST /pin/verify`, `POST /pin/reset` — §3

`/pin` va `/pin/reset` javobi: `{ pinSet, pinUpdatedAt, pinUpdatedAtLabel, policyVersion, parentalToken, expiresAt }`.

### `GET /usage?date=YYYY-MM-DD` | `?from&to` (≤ 31 kun) | `&deviceId`

Sukut — bugun. Bir nechta telefon bo'lsa daqiqalar qo'shiladi.

```json
{
  "from": "2026-09-22", "to": "2026-09-28", "totalMinutes": 845,
  "days": [{ "date": "2026-09-22", "dateLabel": "22-sentabr, 2026", "totalMinutes": 120 }],
  "apps": [{ "appId": "9f2c…", "appName": "YouTube", "iconUrl": "https://…", "platform": "android",
             "minutes": 310, "minMinutes": false, "openCount": 41, "blocked": false }]
}
```

`days` — oraliqdagi HAR kun (bo'sh kun `0`). `apps` — `minutes` kamayish
tartibida. `minMinutes: true` — iOS "kamida N daqiqa".

### `GET /apps?page&limit&search&blocked=true|false`

Sahifalangan (`limit` ≤ 100). Element:

```json
{ "appId": "9f2c…", "appKey": "com.instagram.android", "appName": "Instagram", "iconUrl": "…",
  "platform": "android", "blocked": true, "dailyLimitMin": null, "installed": true,
  "alwaysAllowed": false, "todayMinutes": 12, "firstSeenAt": "…" }
```

`alwaysAllowed: true` — raqam terish, SMS, favqulodda: **bloklab ham, limit
qo'yib ham bo'lmaydi** (400). UI'da tugmani o'chiring.

### `PUT /apps/:appId` [T] — `{ blocked?, dailyLimitMin? }`

`dailyLimitMin`: `null` (limitsiz) yoki 5..1440. Javob — ilova + `policyVersion`.
O'zgarish bo'lmasa versiya oshmaydi.

### `PUT /apps` [T] — `{ appIds: [...], blocked }`

≤ 500 ta, bitta versiya. Javob: `{ updated, skipped: [appId] (doim ochiq), notFound: [appId], policyVersion }`.

### `PUT /lock-all` [T] — `{ enabled, until? }`

`until` — ISO, **mintaqa bilan** (`Z` yoki `+05:00`), kelajakda, ≤ 7 kun.
Berilmasa — muddatsiz. Muddat o'tgach server o'zi yechadi (versiya +1, jim push).
Javob: `{ lockAll, lockAllUntil, lockAllUntilLabel, unlockMinutes, policyVersion }`.

### `PUT /settings` [T] — `{ unlockMinutes }` (5..240)

Telefonda PIN kiritilgach blok shuncha daqiqaga ochiladi.

### `GET /events?page&limit&type`

```json
{ "id": "…", "type": "permission_revoked", "typeLabel": "Himoya o'chirildi", "deviceId": "…",
  "deviceModel": "SM-A546E", "occurredAt": "…", "occurredAtLabel": "…", "payload": {}, "alerted": true }
```

Turlar: `permission_revoked`, `protection_restored`, `uninstall_attempt`,
`wrong_pin`, `unlocked`, `offline`, `unlock_request`, `pin_set`,
`pin_changed`, `pin_reset`. Tartib — `occurredAt` (qurilmadagi vaqt) kamayishi.

### `GET /unlock-requests?status=pending|approved|denied|expired&page&limit`

```json
{ "id": "…", "requestId": "…", "status": "pending", "statusLabel": "Kutilmoqda",
  "appId": "…" | null, "appKey": "…", "appName": "TikTok", "iconUrl": "…",
  "minutes": 30, "approvedMinutes": null, "unlockUntil": null, "unlockUntilLabel": null,
  "deviceId": "…", "deviceModel": "…", "expiresAt": "…", "createdAt": "…", "createdAtLabel": "…", "decidedAt": null }
```

`appId: null` — butun telefon ("hammasini bloklash" ostida).

### `POST /unlock-requests/:id` [T] — `{ approve, minutes? }`

`minutes` (5..240) — faqat tasdiqlashda, berilmasa bola so'ragani. Faqat
`pending` va muddati o'tmagan. Tasdiqlansa bolaga `parental_unlock` push va
ruxsat policy'ning `unlocks` ga tushadi; rad etilsa — `parental_unlock_denied` push.

## 5. Bolaning telefoni — `/api/parental/device`

`X-Client: student` seansi, `X-Device-Id` majburiy, parental token **kerak emas**.
Har so'rov qurilmani "tirik" deb belgilaydi (24 soat jimlik → ota-onaga `offline`).

### `POST /register` — `{ platform: "android"|"ios", model, osVersion, appVersion }`

Birinchi ishga tushishda va ilova yangilanganda. Javob — to'liq policy (§7).

### `PUT /health` — `{ usageAccess, accessibility, deviceAdmin, overlay, batteryOk, familyControls }`

Boolean; yo'g'i `false`. Ruxsat o'zgarganda va har sinxronizatsiyada yuboring.
`protected` quyidagilar BIRGA `true` bo'lsa:

| Platforma | Majburiy |
|---|---|
| android | `usageAccess`, `accessibility`, `deviceAdmin`, `overlay` |
| ios | `familyControls` |

`batteryOk` — maslahat, `protected` ga ta'sir qilmaydi. Javob:
`{ protected, missing: [...], health }`. `true → false` bo'lsa ota-onaga push.

### `POST /apps` — `{ platform, apps: [{ appKey, appName, icon? }], full }`

≤ 500 ta. `appKey` — Android paket nomi yoki iOS tokeni (≤ 2048).
`icon` — base64 PNG, dekodlangan ≤ 20 KB (`data:image/png;base64,` prefiksi
mumkin); server 128 px gacha qayta kodlaydi. **Ikonka faqat yangi ilova yoki
ikonkasi hali yo'q ilova uchun olinadi** — birinchi sinxronizatsiyada ikonkali
ro'yxatni 150–200 talik bo'laklarda (`full: false`) yuboring, oxirida to'liq
ro'yxatni ikonkasiz `full: true` bilan. So'rov tanasi ≤ 10 MB (boshqa `/device/*`
yo'llarida ≤ 3 MB; oshsa 413).
`full: true` — ro'yxatda yo'q ilovalar `installed: false` (shu platformada
boshqa faol qurilma bo'lsa qo'llanmaydi, `fullApplied: false`).
⚠️ Faqat **foydalanuvchi ilovalari** (launcher'da ko'rinadigan) yuborilsin,
tizim paketlari emas: to'liq ro'yxat bitta so'rovga (≤ 500) sig'ishi kerak.

Javob: `{ received, created, updated, uninstalled, fullApplied, iconsUploaded, iconsRejected, skippedByLimit }`.

### `POST /usage` — `{ items: [{ date, appKey, appName?, minutes, openCount, minMinutes? }] }`

≤ 1000 qator, `date` — Toshkent kuni `YYYY-MM-DD`, bugun yoki undan oldingi 7 kun ichida;
`minutes` 0..1440. **Idempotent**: `(qurilma, kun, ilova)` bo'yicha USTIGA
YOZILADI — kun davomida jami (kumulyativ) qiymatni istalgancha qayta
yuborish mumkin, ikki baravar oshmaydi. Noma'lum ilova avtomat qo'shiladi.
Yaroqsiz qator paketni rad ettirmaydi: `{ accepted, skippedCount, skipped: [{ index, reason }] }`
(`reason`: `invalid`, `appKey`, `date`, `date_range`, `minutes`, `openCount`, `minMinutes`, `app_limit`).

### `GET /policy?version=N`

Versiya teng bo'lsa: `{ changed: false, policyVersion, serverTime }`. Aks holda to'liq policy.
Push kelganda va har 15–30 daqiqada, ilova ochilganda chaqiring.

### `POST /events` — `{ events: [{ eventId?, type, payload, occurredAt }] }`

≤ 100 ta. `eventId` — qurilma yaratadigan yagona identifikator (1–64 belgi
`[A-Za-z0-9_-]`, masalan UUID): **tavsiya etiladi** — paket qayta yuborilsa
(javob yo'lda yo'qolgan) hodisa ikki marta yozilmaydi va push qayta ketmaydi. `type`: `permission_revoked`, `uninstall_attempt`, `wrong_pin`
(har xato alohida), `unlocked`. `occurredAt` — qurilmadagi ISO vaqt (oflayn
navbat keyin yuboriladi); 30 kundan eski yoki kelajakdagisi server vaqti
bilan almashtiriladi (asli `payload.deviceTime`). `payload` — kichik obyekt
(≤ 2 KB), **mazmun yubormang** (xabar, kontakt, tarix). Noma'lum tur
o'tkazib yuboriladi, bitta hodisaning xatosi qolganlarini to'xtatmaydi.
Javob: `{ accepted, alerted, duplicates, skipped: [{ index, reason }] }`
(`reason`: `type`, `eventId`, `occurredAt`, `error`). `skipped` dagi `error`
dan boshqa sabablar — qayta yubormang (navbatdan o'chiring).

### `POST /unlock-request` — `{ appKey?, appName?, minutes: 15|30|60 }`

`appKey` yo'q — butun telefon. Bir vaqtda bitta `pending` (yangisi eskisini
yopadi), 15 daqiqa amal qiladi, 10 daqiqada ≤ 3 ta. Javob (201):
`{ requestId, status: "pending", appId, minutes, expiresAt }`.

### `GET /unlock-request/:id`

So'rov holati — push kelmasa ham javobni shu bilan oling:
`{ requestId, status, appId, minutes, approvedMinutes, unlockUntil, expiresAt, decidedAt, serverTime }`.

## 6. Push shartnomasi (FCM)

Barcha `data` qiymatlari **string**. Noma'lum `type` ni jimgina e'tiborsiz
qoldiring (eski `ping` bilan bir xil qoida). Android kanali: `parental`.

| `data.type` | Kimga (seans kanali) | Turi | `data` |
|---|---|---|---|
| `parental_policy` | student | **jim** (data-only; Android `high`, iOS `content-available`) | `version`, `branchId` |
| `parental_unlock` | student | ko'rinadi | `requestId`, `appId`?, `appKey`?, `minutes`, `until` (ISO), `branchId` |
| `parental_unlock_denied` | student | ko'rinadi | `requestId`, `appId`?, `appKey`?, `branchId` |
| `parental_alert` | parent | ko'rinadi | `event`, `deviceId`?, `appKey`?, `branchId` |
| `parental_request` | parent | ko'rinadi | `requestId`, `appId`?, `appKey`?, `appName`?, `minutes`, `branchId` |

`parental_alert.event`: `permission_revoked`, `uninstall_attempt`,
`wrong_pin`, `offline`, `protection_restored`, `pin_reset`.

⚠️ Push — **tezlatgich, kafolat emas**. `parental_policy` kelganda
`GET /device/policy?version=<joriy>` ni chaqiring; push kelmasa ham davriy
sinxronizatsiya qiling. Tasdiqlangan ruxsat policy'ning `unlocks` ida ham bor.

## 7. Policy

```json
{
  "changed": true,
  "policyVersion": 17,
  "serverTime": "2026-09-28T09:15:00.000Z",
  "lockAll": false,
  "lockAllUntil": null,
  "unlockMinutes": 30,
  "blocked": [{ "appId": "9f2c…", "appKey": "com.instagram.android", "platform": "android" }],
  "limits": [{ "appId": "c7d0…", "appKey": "com.zhiliaoapp.musically", "platform": "android", "dailyLimitMin": 60 }],
  "unlocks": [{ "requestId": "…", "appId": "9f2c…", "appKey": "com.instagram.android", "until": "2026-09-28T09:45:00.000Z" }],
  "pin": { "algo": "pbkdf2-sha256", "hash": "…64 hex…", "salt": "…32 hex…", "iterations": 100000 },
  "alwaysAllowed": ["com.android.dialer", "com.google.android.dialer", "com.android.mms",
                    "com.google.android.apps.messaging", "com.android.emergency"]
}
```

- `blocked` / `limits` — faqat qurilma platformasiniki.
- `pin: null` — PIN o'rnatilmagan: **blok qo'ymang**, faqat statistika yig'ing.
- `alwaysAllowed` + o'quvchi ilovasining o'z paketi — hech qachon bloklanmaydi.
- `unlocks` — ota-ona tasdiqlagan, muddati o'tmagan ruxsatlar (`appId: null` — butun telefon).
- `serverTime` — telefon soati surilganini aniqlash uchun: vaqtli qarorlarni
  (`lockAllUntil`, `unlocks[].until`, PIN bilan ochish muddati)
  `serverTime` va monotonik soatdan hisoblang, qurilma soatiga ishonmang.
- `lockAllUntil` o'tgan bo'lsa server `lockAll: false` qaytaradi.

## 8. Tavsiya etiladigan tartib (bolaning telefoni)

1. Login (`X-Client: student`) → `POST /api/push/devices` → `POST /parental/device/register`.
2. Ruxsatlar so'raladi → `PUT /device/health`.
3. `POST /device/apps` (bo'laklarda, ikonkalar bilan), oxirida `full: true`.
4. Davriy (15–30 daq) va `parental_policy` push kelganda: `GET /device/policy?version=N`,
   `POST /device/usage` (bugun + yuborilmagan kunlar), navbatdagi `POST /device/events`.
5. Ruxsat o'zgarsa darhol `PUT /device/health`.
