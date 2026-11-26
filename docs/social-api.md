# Istoriyalar va Chat — API, socket va push shartnomasi (mobil jamoa uchun)

Server: `study-track-server`. Uch prefiks:

| Prefiks | Nima | Kim ishlatadi |
|---|---|---|
| `/api/social/*` | istoriyalar, media yuklash, shikoyatlar | **faqat xodimlar** (`mbsi_school`, `mbsi_staff`) |
| `/api/chat/*` | suhbatlar va xabarlar | xodimlar + o'quvchi (o'quvchi faqat SINF guruhini) |
| `/api/profile/avatar` | profil rasmi | faqat xodimlar |
| Socket.IO | real vaqt | ikkalasi |

Ma'lumot `platform` schema'sida — ya'ni **butun tarmoq uchun bitta**: xodim
qaysi filialga kirgan bo'lsa ham o'sha lentani va o'sha suhbatlarni ko'radi.

> ⚠️ **Socket — tezlatgich, haqiqat manbai EMAS.** Hodisa yo'qolishi mumkin
> (fon rejimi, tarmoq). Shuning uchun ilova har qayta ulanishda
> `GET /api/chat/sync?since=...` ni **majburiy** chaqiradi. Bu shartnomaning
> eng muhim bandi: usiz suhbatda bo'shliq qoladi.

---

## 1. Sarlavhalar va umumiy javob shakli

| Sarlavha | Majburiy |
|---|---|
| `Authorization: Bearer <access token>` | ha |
| `X-Client: teacher` / `worker` / `student` | ha (login so'rovida ham — kanal seansga yoziladi) |
| `X-Device-Id` | tavsiya etiladi (seans ro'yxati uchun) |

```json
{ "success": true, "data": { } }
{ "success": true, "items": [ ], "pagination": { "nextCursor": "…", "hasMore": true } }
{ "success": true, "data": [ ], "pagination": { "page": 1, "limit": 30, "total": 90, "totalPages": 3, "hasNextPage": true, "hasPrevPage": false } }
{ "success": false, "message": "Siz bu suhbatning a'zosi emassiz", "details": { "code": "NOT_MEMBER" } }
```

⚠️ **Ikki xil sahifalash bor va ular aralashmaydi:**
`items` + `pagination.nextCursor` — **kursor** (xabarlar, izohlar, ko'rganlar,
suhbatlar); `data` + `pagination.page` — **sahifa** (xodim qidiruvi,
shikoyatlar). Kursor aynan shu joylarda ishlatiladi, chunki ro'yxat tepasiga
yangi qator qo'shiladi: `page` bilan ikkinchi sahifada xabar takrorlanar yoki
tushib qolardi.

### Xato kodlari (`details.code`)

| Kod | HTTP | Ma'nosi |
|---|---|---|
| `STORY_DAILY_LIMIT` | 429 | bugungi 3 ta istoriya tugadi, `details.resetsAt` da tiklanish vaqti |
| `NOT_MEMBER` | 403 | suhbat a'zosi emassiz |
| `POST_BANNED` | 403 | o'quvchi vaqtincha ovozsiz (`details.until`, `details.reason`) |
| `CONVERSATION_CLOSED` | 403 | suhbat yopilgan (sinf bitirdi) — faqat o'qish |
| `ONLY_STAFF_POST` | 403 | e'lon rejimi: faqat ustozlar yozadi |
| `SLOW_MODE` | 429 | sekin rejim (`details.waitSec`) |
| `RATE_LIMITED` | 429 | daqiqadagi xabar chegarasi (`details.limit`) |
| `CLASS_GROUP_IMMUTABLE` | 403 | sinf guruhidan chiqib bo'lmaydi / a'zolik avtomatik |

⚠️ `details.code` **bo'lmasligi ham mumkin** (oddiy validatsiya xatolari) —
ilova `message` ni ko'rsatadi, `code` ni esa faqat maxsus oyna uchun o'qiydi.

### Odam kartochkasi — javobning HAR joyida AYNI

```json
{
  "id": "6730…", "firstName": "Ali", "lastName": "Valiyev",
  "fullName": "Ali Valiyev", "role": "teacher",
  "branchId": "6512…", "branchName": "Chilonzor filiali",
  "isArchived": false,
  "avatar": { "url": "https://…/sm.webp", "preset": null, "initials": "AV", "color": 6 }
}
```

`avatar` uchun **bitta vidjet** yoziladi (`SocialAvatar`): `url` bo'lsa rasm,
bo'lmasa `preset` (paketdagi `assets/avatars/a07.webp`), u ham bo'lmasa
`initials` + `color` (0..7, brend palitrasidan). ⚠️ Noma'lum `preset` kelsa
bosh harflarni ko'rsating — server ro'yxatini kengaytirish eski ilovani
sindirmasligi kerak. ⚠️ Telefon va `username` bu kartochkada **yo'q** va
qo'shilmaydi: u sinf guruhida o'quvchiga ham ko'rinadi.

---

## 2. Media yuklash — 3 qadam

Katta fayl **server orqali o'tmaydi**: ilova to'g'ridan-to'g'ri Spaces'ga
yuklaydi, server faqat ruxsat beradi va keyin tekshiradi.

```
1) POST /api/social/uploads                 → uploadId + imzolangan PUT havolasi
2) PUT <putUrl>  (Spaces'ga, foiz bilan)    → serverni ko'rmaydi
3) POST /api/social/uploads/:id/complete    → server tekshiradi va qayta ishlaydi
4) POST /api/social/stories { uploadId }    → yoki xabar yuborishda
```

### 2.1 `POST /api/social/uploads`

```json
// so'rov
{ "kind": "image", "mime": "image/jpeg", "size": 842113,
  "width": 1080, "height": 1920, "durationMs": null, "purpose": "story" }

// javob (201)
{ "success": true, "data": {
  "uploadId": "6730…",
  "mode": "presigned",
  "putUrl": "https://…?X-Amz-Signature=…",
  "headers": { "Content-Type": "image/jpeg", "x-amz-acl": "private" },
  "thumbPutUrl": null, "thumbHeaders": null,
  "multipartUrl": null,
  "expiresIn": 600
} }
```

⚠️ **`headers` AYNAN qaytganidek yuborilsin** — ular imzo ichida. Boshqa
`Content-Type` bilan yuborilsa Spaces 403 beradi.

⚠️ **`mode` ni ilova TAXMIN QILMAYDI, server aytadi.**
`"presigned"` → `putUrl` ga `PUT`. `"multipart"` → lokal dev muhiti, fayl
`multipartUrl` ga `POST` (multipart, maydon nomi `file`) yuboriladi. Javob
shakli ikkalasida bir xil, ya'ni oqim bitta.

⚠️ **VIDEO uchun `thumbPutUrl` ham keladi** — ilova kadr-rasmni (WebP) o'sha
havolaga yuklaydi. Server videoni **siqmaydi va kadr olmaydi** (ffmpeg yo'q):
siqish ilovada (720p, ~2 Mbit/s), kadr ham ilovada. Kadr yuborilmasa video
baribir qabul qilinadi, faqat xira oldindan ko'rinish (blurhash) bo'lmaydi.

### 2.2 Chegaralar

| `kind` | MIME | Maksimal hajm | Boshqa | `purpose` |
|---|---|---|---|---|
| `image` | `image/jpeg`, `image/png`, `image/webp` | 10 MB | serverda WebP 1080 px + 320 px thumb + blurhash | `story`, `chat`, `avatar` |
| `video` | `video/mp4` (H.264 + AAC) | 25 MB | ≤ 60 s, 720p, kadr-rasm ilovadan | `story`, `chat` |
| `voice` | `audio/m4a`, `audio/aac`, `audio/ogg` | 5 MB | ≤ 5 daqiqa | `chat` |
| `file` | pdf, doc(x), xls(x), ppt(x), zip | 20 MB | faqat chat, faqat XODIM | `chat` |

⚠️ **HEIC QABUL QILINMAYDI.** Serverdagi `sharp` prebuilt libvips bilan
keladi va unda HEVC yo'q — iPhone rasmi 10 MB yuklangandan keyin qayta
ishlashda yiqilardi. Ilova baribir siqadi (`flutter_image_compress`,
1080 px / 80%) va natijasi JPEG/WebP bo'ladi, shuning uchun bu hech narsani
cheklamaydi; faqat xato **yuklashdan oldin** beriladi.

⚠️ **Video va fayl — faqat xodim.** O'quvchi sinf guruhiga matn, rasm va
ovozli xabar yuboradi.

⚠️ Bir odamda bir vaqtda ko'pi bilan **10 ta tugallanmagan** yuklash
(`409`), 24 soatdan eski biriktirilmaganlar cron bilan o'chiriladi.

### 2.3 `POST /api/social/uploads/:id/complete`

Server `HeadObject` qiladi (hajm + `Content-Type` e'lon qilingan bilan mos
kelishini tekshiradi), rasmni qayta ishlaydi (EXIF/GPS **olib tashlanadi**,
WebP 1080 px, 320 px thumb, blurhash) va media blokini qaytaradi:

```json
{ "success": true, "data": {
  "id": "6730…", "kind": "image", "mime": "image/webp",
  "size": 184221, "width": 1080, "height": 1920, "durationMs": null,
  "blurhash": "LKO2?U%2Tw=w]~RBVZRi};RPxuwH",
  "url": "https://…?X-Amz-Signature=…",
  "thumbUrl": "https://…?X-Amz-Signature=…",
  "expiresIn": 3600
} }
```

⚠️ **IDEMPOTENT**: allaqachon `ready` bo'lsa xato bermaydi, o'sha javobni
qaytaradi. Biriktirilgan (`attached`) fayl esa `409`.

### 2.4 Media havolasi — kesh KALITI `id`, URL EMAS

`url` **imzolangan va muddatli** (`expiresIn`, sukut 1 soat). Ilova
`cached_network_image` da `cacheKey = mediaId` qo'yadi. URL ni kesh kaliti
qilib olsa, bir xil rasm har soatda qaytadan yuklab olinardi.

Havola muddati o'tgan bo'lsa: shu media qaytgan endpointni qayta chaqiring
(lenta, xabarlar tarixi, `sync`) — yangi imzo keladi. Zaxira yo'l:
`GET /api/social/media/:id` (`?thumb=1`) — server orqali, egalik
tekshiruvi bilan (faqat egasi, istoriya uchun xodim, xabar uchun a'zo).

---

## 3. Istoriyalar

### 3.1 `GET /api/social/stories/feed?scope=all|branch`

Muallif bo'yicha **guruhlangan** aktiv (24 soat ichidagi) istoriyalar.
Tartib serverda hal qilinadi: **o'zim birinchi** → ko'rilmaganlar (eng
yangisi tepada) → ko'rilganlar; muallif ichida **eskidan yangiga** (o'qish
tartibi). Ilova tartibni **o'zgartirmaydi**.

```json
{ "success": true, "data": [
  { "author": { /* odam kartochkasi */ },
    "hasUnseen": true,
    "latestAt": "2026-11-26T09:12:04.000Z",
    "stories": [
      { "id": "6730…", "media": { /* §2.3 */ }, "caption": "Bugungi ochiq dars",
        "createdAt": "2026-11-26T08:40:00.000Z",
        "expiresAt": "2026-11-27T08:40:00.000Z",
        "inFeed": true, "seen": false, "liked": false,
        "commentsCount": 3,
        "viewsCount": 24, "likesCount": 8 }
    ] }
] }
```

⚠️ `viewsCount` va `likesCount` **faqat muallifga** keladi (va moderatorga).
Boshqalarda bu maydonlar **umuman yo'q** — `null` emas, **mavjud emas**.
`commentsCount` hammaga keladi. Kichik jamoada "1 layk" kim bosganini
oshkor qilardi, shuning uchun son ham yashirilgan.

⚠️ `inFeed: false` — istoriya 24 soatdan o'tgan va **profilda** turadi
(Telegramdagidek). U o'chirilmaydi; faqat muallif o'chirganda yo'qoladi.

⚠️ Arxivlangan yoki faolsizlantirilgan muallif lentadan **chiqadi**.

### 3.2 Kvota — kamera ochilishidan OLDIN

`GET /api/social/stories/quota` →
`{ "limit": 3, "used": 2, "remaining": 1, "resetsAt": "2026-11-26T19:00:00.000Z" }`

⚠️ `remaining = 0` bo'lsa kamerani **ochmang**: oyna ko'rsatiladi —
«Bugun 3 ta istoriya qo'ydingiz. Ertaga 00:00 dan yana qo'yasiz».
`resetsAt` — **Toshkent yarim tuni** (UTC instant sifatida keladi).

⚠️ **O'CHIRILGAN ISTORIYA HAM HISOBLANADI.** "Qo'y → o'chir → qo'y" bilan
limitni aylanib o'tib bo'lmaydi; o'chirish oynasida shu haqda ogohlantiring.

### 3.3 Yaratish / o'chirish

```
POST   /api/social/stories            { uploadId, caption? }   → 201 { data: story }
DELETE /api/social/stories/:id                                  → { data: { id, deleted } }
GET    /api/social/stories/:id                                  → { data: { …story, author } }
```

429 javobi:
```json
{ "success": false, "message": "Bugun 3 ta istoriya qo'ydingiz — ertaga yana qo'yasiz",
  "details": { "code": "STORY_DAILY_LIMIT", "limit": 3, "used": 3,
               "resetsAt": "2026-11-26T19:00:00.000Z" } }
```
⚠️ Bu javob **boshqa telefondan** qo'yilgan bo'lsa ham keladi — qoralamani
saqlab, aniq xabar ko'rsating.

### 3.4 Ko'rish, layk, izoh

```
POST   /api/social/stories/views          { storyIds: [ … ] }  → 204   (≤ 50 ta)
POST   /api/social/stories/:id/like                            → { liked, likesCount }
DELETE /api/social/stories/:id/like                            → { liked, likesCount }
GET    /api/social/stories/:id/comments?cursor=&limit=         → items (eskidan yangiga)
POST   /api/social/stories/:id/comments   { text }             → 201 { data: comment }
DELETE /api/social/stories/:id/comments/:commentId             → { id, deleted }
GET    /api/social/stories/:id/viewers?cursor=                 → faqat muallif
GET    /api/social/stories/:id/likes?cursor=                   → faqat muallif
```

⚠️ **Ko'rishlar PAKET bilan**: istoriya ≥ 1 sekund ekranda tursa ko'rilgan
deb hisoblanadi, lokal bazaga darhol yoziladi, serverga **2–3 sekundda bir
marta** yoki viewer yopilganda yuboriladi — har kadrda EMAS. Amal
idempotent: qayta yuborilgan paket sanoqchini oshirmaydi.

⚠️ **Muallifning o'z ko'rishi hisoblanmaydi** (server o'zi chiqarib tashlaydi).

⚠️ Tezlik chegaralari: izoh **20/daq**, layk **60/daq**, ko'rish paketi
**30/daq**, yuklash **30/daq** (bir odamga).

### 3.5 Profil istoriyalari

`GET /api/social/users/:userId/stories?cursor=&limit=` →
```json
{ "success": true,
  "author": { /* kartochka */ },
  "storiesCount": 41,
  "items": [ /* story, eng yangisi tepada */ ],
  "pagination": { "nextCursor": "6730…", "hasMore": true } }
```
3 ustunli setka, bosilganda viewer shu istoriyadan ochiladi. Ko'rish bu
yerda ham yoziladi. Statistika (`viewsCount`/`likesCount`) faqat o'z
profilida keladi.

### 3.6 Shikoyat

```
POST /api/social/reports  { targetType: "story"|"story_comment"|"message", targetId, reason }
```
⚠️ Bir odam bir nishonga bir marta; takror yuborish **xato bermaydi**
(`created: false`) — foydalanuvchi uchun natija bir xil.

---

## 4. Chat

### 4.1 Suhbatlar ro'yxati

`GET /api/chat/conversations?cursor=&limit=&archived=false`

```json
{ "success": true,
  "pinned": [ /* to'liq ro'yxat, ≤ 50 */ ],
  "items":  [ /* qolganlari, lastMessageAt bo'yicha */ ],
  "pagination": { "nextCursor": "6730…", "hasMore": true } }
```

⚠️ **Pinlanganlar ALOHIDA blokda** va ular kursorga **kirmaydi**: pinlangan
suhbat eski bo'lishi mumkin, aralashtirilsa ikkinchi sahifada qator
takrorlanar yoki tushib qolardi. Ilova `pinned` ni tepaga, `items` ni
ketidan chizadi.

Suhbat obyekti:
```json
{ "id": "6730…", "type": "direct"|"group"|"class",
  "title": "Matematika 5-A", "partner": { /* 1:1 da kartochka, aks holda null */ },
  "classId": null, "branchId": null, "memberCount": 27,
  "lastSeq": 418, "lastMessageAt": "2026-11-26T09:12:04.000Z",
  "lastPreview": "Ali: bugun uyga vazifa yo'q",
  "unreadCount": 3,
  "onlyStaffPost": false, "slowModeSec": 0, "closedAt": null,
  "myRole": "member"|"admin"|"owner",
  "pinned": false, "archived": false,
  "mutedUntil": null, "postBannedUntil": null }
```
⚠️ `unreadCount = lastSeq − lastReadSeq` (server hisoblaydi) — ilova
xabarlarni sanamaydi.

### 4.2 Suhbat ochish va boshqarish

```
POST   /api/chat/direct                       { userId }            → suhbat (mavjudi yoki yangisi)
POST   /api/chat/groups                       { title, memberIds }  → 201  (ruxsat: chat.groupCreate)
PATCH  /api/chat/conversations/:id            { title?, onlyStaffPost?, slowModeSec? }
GET    /api/chat/conversations/:id/members
POST   /api/chat/conversations/:id/members    { userIds }           → faqat xodimlar guruhi
DELETE /api/chat/conversations/:id/members/:userId
POST   /api/chat/conversations/:id/leave
PATCH  /api/chat/conversations/:id/me         { mutedUntil?, pinned?, archived?, clearHistory? }
POST   /api/chat/conversations/:id/ban        { userId, minutes, reason }  → sinf guruhi, o'quvchini ovozsiz qilish
GET    /api/chat/users?q=&page=&limit=        → yozish uchun xodim qidirish
```
⚠️ `POST /direct`, `POST /groups`, `GET /users` — **o'quvchiga 403**.
⚠️ Sinf guruhida: a'zolik qo'lda o'zgarmaydi (`CLASS_GROUP_IMMUTABLE`),
nom o'zgarmaydi (sinf nomidan keladi), chiqib bo'lmaydi — faqat ovozsiz
qilish (`PATCH …/me { mutedUntil }`).

### 4.3 Xabarlar

```
GET  /api/chat/conversations/:id/messages?beforeSeq=&afterSeq=&limit=50
POST /api/chat/conversations/:id/messages
POST /api/chat/conversations/:id/read      { seq }
GET  /api/chat/messages/:id/readers
PATCH  /api/chat/messages/:id              { text }        → faqat muallif, 48 soat, faqat matn
DELETE /api/chat/messages/:id
```

Yuborish:
```json
// so'rov
{ "clientId": "f2c1…-uuid-v4", "type": "text", "text": "Salom",
  "uploadId": null, "replyToId": null, "storyId": null }

// javob: 201 (yangi) yoki 200 (allaqachon yozilgan — `created: false`)
{ "success": true, "created": true, "data": {
  "id": "6730…", "conversationId": "6731…", "seq": 419,
  "clientId": "f2c1…", "type": "text", "text": "Salom",
  "media": null, "replyToId": null, "storyId": null, "forwardedFromId": null,
  "flagged": false, "sender": { /* kartochka */ },
  "createdAt": "2026-11-26T09:12:04.000Z", "editedAt": null, "deletedAt": null
} }
```

⚠️ **`clientId` MAJBURIY va u idempotentlik kaliti** (UUID v4, ilova
yaratadi). Tarmoq uzilib qayta yuborilsa, server **ikkinchi xabar
yozmaydi** — o'sha xabarni `created: false` bilan qaytaradi. Shu sababli
outbox navbatida `clientId` **saqlanadi va o'zgartirilmaydi**.

⚠️ **`seq` — suhbatdagi o'rin.** Ilova xabarlarni `seq` bo'yicha tartiblaydi.
Bo'shliq ko'rsa (…5, 7) `GET …/messages?afterSeq=5` bilan to'ldiradi.
Tahrirlash va o'chirish `seq` ni **o'zgartirmaydi**.

⚠️ `type`: `text` | `image` | `video` | `voice` | `file` | `story_reply` |
`system`. Media turlarida `uploadId` majburiy. `system` — server yozadi
("Ali guruhga qo'shildi"), ilova uni markazda kulrang matn qilib chizadi.

⚠️ **O'chirilgan xabarda `text` va `media` — `null`**, `deletedAt` to'ldirilgan.
Ilova "Xabar o'chirildi" deb chizadi. (Moderator javobida matn ko'rinadi.)

⚠️ O'chirish muddati: o'quvchi **10 daqiqa**, xodim **48 soat**, guruh
admini va moderator — har doim.

⚠️ `flagged: true` — so'kinish filtri belgisi. **Bloklamaydi**: xabar
yoziladi; belgi faqat sinf rahbari/moderator ekranida ma'noga ega.

### 4.4 "O'qildi" belgisi

`POST /api/chat/conversations/:id/read { seq }` → `{ lastReadSeq }`.
Server `GREATEST` bilan yozadi, ya'ni **orqaga ketmaydi**.

Belgilar: soat (navbatda) → ✓ (serverda, `seq` bor) → ✓✓ (suhbatdosh
o'qidi: `conversation:read` hodisasidagi `seq ≥ xabar.seq`).
Guruhda ✓✓ — kamida bitta a'zo o'qisa; «Kim o'qidi» —
`GET /api/chat/messages/:id/readers`.

⚠️ Xabar ekranda **ko'ringanda** (`visibility_detector`) eng katta ko'ringan
`seq` 1 sekund debounce bilan yuboriladi. Ilova **fonda bo'lsa yuborilmaydi**.

### 4.5 `GET /api/chat/sync?since=<ISO>` — qayta ulanishda MAJBURIY

```json
{ "success": true, "data": {
  "now": "2026-11-26T09:15:00.000Z",
  "conversations": [
    { "conversation": { /* §4.1 obyekti */ },
      "messages": [ /* yangi, tahrirlangan va o'chirilgan xabarlar, seq asc */ ] }
  ] } }
```
⚠️ `since` berilmasa — hamma suhbat va oxirgi 200 xabar (sovuq start).
Keyingi chaqiruv uchun `data.now` ni saqlang (server soatidan, telefon
soatidan EMAS — telefonda vaqt noto'g'ri bo'lishi mumkin).

### 4.6 Sinf guruhlari

Har sinfga bitta `type: "class"` suhbat. A'zolar **avtomatik**:
o'quvchilar (`member`), dars beradigan o'qituvchilar + sinf rahbari + tyutor
(`admin`). O'rinbosar o'qituvchi qo'shilmaydi (u vaqtincha).

⚠️ O'quvchi **faqat o'z sinf guruhini** ko'radi va boshqa hech narsani:
istoriya yo'q, 1:1 yo'q, xodim qidiruvi yo'q.
⚠️ O'quvchi yuboradi: matn, rasm, ovozli xabar. Video/fayl — yo'q.
Tahrirlash — yo'q. O'chirish — 10 daqiqa. Yo'naltirish — yo'q.
⚠️ Ota-ona ilovasi (seans kanali `parent`) bu bo'limni **umuman ko'rmaydi**:
API 403 qaytaradi va push ham bormaydi (`parent` seanslari aniq
so'ralmaganda push'dan chiqarib tashlanadi — mavjud qoida).
⚠️ Sinf bitirsa `closedAt` qo'yiladi: tarix o'qiladi, kiritish paneli
o'rnida «Bu suhbat yopilgan» chiqadi.
⚠️ `onlyStaffPost: true` → kiritish paneli o'rnida «Bu guruhda faqat
ustozlar yozadi». `postBannedUntil` → «Siz 18:00 gacha yoza olmaysiz».

Admin uchun: `POST /api/chat/class-groups/resync` (ruxsat
`chat.classGroupsManage`) — joriy filialning hamma sinf guruhini qayta
sinxronlaydi.

---

## 5. Socket.IO

```dart
io(url, OptionBuilder()
    .setTransports(['websocket'])          // ⚠️ faqat websocket
    .setAuth({'token': accessToken})
    .build());
```

⚠️ **Bitta socket butun ilova uchun** (`SocialScope` ichida), ekranlar o'z
ulanishini ochmaydi. Ilova oldinga chiqqanda ulanadi, fonda 30 sekunddan
keyin uziladi (batareya), qaytganda **avval `GET /chat/sync`, keyin** qayta
ulanadi. Eksponensial kutish: 1–2–4…30 s.

Handshake xatolari (`connect_error` dagi `message`): `unauthorized`,
`session_ended`, `account_disabled`, `parent_channel_not_supported`,
`aggregate_token_not_supported` (umumiy ko'rinish tokeni — oddiy tokenga
o'tib qayta ulanish kerak), `too_many_connections`, `branch_not_found`.

### Ilova → server (hammasi `ack` bilan)

| Hodisa | Tana | `ack` |
|---|---|---|
| `message:send` | REST tanasi + `conversationId` | `{ ok, data: { message, created } }` |
| `conversation:read` | `{ conversationId, seq }` | `{ ok, data: { lastReadSeq } }` |
| `typing` | `{ conversationId, isTyping }` | `{ ok, data: { sent } }` |
| `messages:after` | `{ conversationId, afterSeq, limit }` | `{ ok, data: { items, pagination } }` |

`ack` xato shakli: `{ ok: false, error: { message, status, code, details } }`
— `code` REST bilan **aynan bir xil** (§1).

⚠️ `ack` **10 sekundda kelmasa** ilova REST yo'liga o'tadi: ikkalasi ham
bitta funksiyani chaqiradi, ya'ni natija bir xil (`clientId` takrorni
to'sadi).

### Server → ilova

| Hodisa | Ma'lumot |
|---|---|
| `message:new` | `{ conversationId, message }` |
| `message:updated` | `{ conversationId, message }` — tahrir yoki o'chirish |
| `conversation:read` | `{ conversationId, userId, seq }` |
| `conversation:updated` | `{ conversationId }` — nom, a'zolar, sozlama o'zgardi → suhbatni qayta o'qing |
| `typing` | `{ conversationId, userId, isTyping, ttlSec: 5 }` |
| `presence` | `{ userId, online, lastSeenAt }` — faqat 1:1 sheriklarga |
| `story:new` | `{ story, author }` |
| `story:deleted` | `{ storyId }` |
| `story:viewed` / `story:liked` / `story:unliked` | `{ storyId, viewerId|userId }` — muallifga |
| `story:commented` | `{ storyId, comment }` — muallifga |

⚠️ `typing` **saqlanmaydi**: `ttlSec` — "shu vaqtdan keyin o'zi o'chir"
degan maslahat, server taymer yuritmaydi.

⚠️ `conversation:updated` **ma'lumot olib kelmaydi**, faqat signal: ilova
`GET /chat/conversations` yoki `/sync` bilan yangilaydi.

---

## 6. Push (FCM)

`data` kalitlari — shartnoma. Push tokenini har logindan keyin
`POST /api/push/devices { token, platform }` bilan yuboring.

| Hodisa | Kimga | `data` | Eslatma |
|---|---|---|---|
| Yangi xabar | ovozsiz qilmagan, **socket'da onlayn bo'lmagan** a'zolar | `{ type: "chat", event: "message", conversationId, messageId, seq }` | Android `tag` = `conversationId`, iOS `thread-id` = `conversationId` |
| Boshqa qurilmada o'qildi | o'sha odamning boshqa telefonlari | `{ type: "chat", event: "read", conversationId, seq }` + **silent** | telefondagi bildirishnoma o'zi yo'qoladi |
| Istoriyaga izoh | muallif | `{ type: "story", event: "comment", storyId }` | har izohga |
| Istoriyaga layk | muallif | `{ type: "story", event: "like", storyId }` | **10 daqiqada bir paket** ("Ali va yana 4 kishi") |
| Istoriya o'chirildi (moderator) | muallif | `{ type: "story", event: "removed", storyId }` | |
| Profil rasmi olib tashlandi | egasi | `{ type: "story", event: "avatar_removed" }` | |
| Shikoyat | moderatorlar | `{ type: "report", event: "new", targetType, targetId }` | |

⚠️ **Yangi istoriya uchun push YO'Q** (ongli qaror: 60 xodim × 3 = kuniga
180 bildirishnoma bo'lardi). Lentadagi halqa `story:new` socket hodisasi
bilan yonadi.

⚠️ **Ochiq suhbatga push kelsa bildirishnoma KO'RSATILMAYDI** — xabar
allaqachon ekranda.

⚠️ **Tungi sukunat**: 22:00–07:00 (Toshkent) oralig'ida **o'quvchi**
xabari uchun push `silent` bo'lib ketadi — xabar yo'qolmaydi, faqat
jiringlamaydi. Xodim xabarlari odatdagidek.

⚠️ `data.type = "ping"` — ovozsiz tekshiruv, ilova uni **jimgina
e'tiborsiz qoldiradi** (mavjud qoida, `docs/parental-control-api.md` §6).

---

## 7. Profil rasmi (avatar)

```
PUT    /api/profile/avatar          multipart, maydon nomi: image   (≤ 5 MB, jpeg/png/webp)
PUT    /api/profile/avatar/preset   { "preset": "a07" }             (a01 … a24)
DELETE /api/profile/avatar
DELETE /api/social/users/:userId/avatar    — moderator (stories.moderate)
```
Javob: `{ "success": true, "data": { "avatar": { url, preset, initials, color } } }`

⚠️ Server rasmni **kvadrat 512 px WebP** ga aylantiradi va EXIF/GPS ni
olib tashlaydi. Rasm va tayyor avatar **bir-birini almashtiradi**: rasm
yuklansa `preset` tozalanadi va aksincha.
⚠️ Tayyor avatarlar **serverda rasm sifatida yotmaydi** — faqat kod
saqlanadi, rasm `mbsi_social` paketi ichida (tarmoqsiz ham chiziladi).
⚠️ Chegara: soatda 10 marta almashtirish.
⚠️ Yuklash **optimistik** bo'lishi kerak: yangi rasm darhol ko'rinadi,
xato bo'lsa eskisiga qaytadi.

---

## 8. Mobil tomon uchun qisqa ro'yxat (tayyorlik mezonlari)

- [ ] Hamma model `fromJson` da **null-xavfsiz** — server yangi maydon
      qo'shsa ilova sinmaydi (`viewsCount` yo'qligi NORMAL hol).
- [ ] Chat ekranlari **faqat lokal bazadan** (drift) chiziladi, tarmoq
      bazani yangilaydi (`watch()`).
- [ ] Outbox: `clientId` saqlanadi, 3 urinishdan keyin qizil «!».
- [ ] Qayta ulanishda **`GET /chat/sync`**, keyin socket.
- [ ] Media keshi kaliti — **`mediaId`**, URL emas.
- [ ] Logout va filial almashtirishda **lokal chat bazasi tozalanadi**
      (ota-ona multi-akkaunt holati).
- [ ] Kvota tekshirilmaguncha kamera ochilmaydi.
- [ ] Ko'rishlar paketi 2–3 sekundda bir, har kadrda emas.
- [ ] Istoriya viewer'ida bir vaqtda ko'pi bilan 3 ta
      `VideoPlayerController` (xotira oqishi yo'q).
- [ ] `features: { stories: false, staffChat: false }` bilan o'quvchi
      ilovasida faqat sinf guruhi ko'rinadi.

---

## 9. Server tomonidagi qaror joylari (nosozlik izlashda kerak bo'ladi)

| Nima | Fayl |
|---|---|
| Kim nima qila oladi (xodim/o'quvchi/ota-ona) | `services/socialAccess.service.js` |
| Chatdagi to'siqlar (a'zolik, e'lon rejimi, sekin rejim) | `services/chatAccess.service.js` |
| Istoriya qoidalari, kunlik limit | `services/story.service.js` |
| Xabar, `seq`, idempotentlik, sinxron | `services/chat.service.js` |
| Sinf guruhi a'zoligi | `services/classChat.service.js` |
| Media yuklash va qayta ishlash | `services/mediaUpload.service.js` |
| Avatar | `services/avatar.service.js` |
| Socket va handshake | `realtime/socket.js`, `realtime/chat.handlers.js` |
| Push matni va `data` | `helpers/socialPush.helpers.js` |
| Chegaralar (MIME, hajm, davomiylik) | `helpers/socialMedia.helpers.js` |
