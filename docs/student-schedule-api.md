# O'quvchi dars jadvali — ilova shartnomasi

`GET /api/schedules/my-class` — o'quvchining O'Z sinfi haftalik jadvali va
"sheet'dagi jadval bazadagidan farq qiladimi" belgisi (`sheetDiffers`).

- **Kim:** faqat o'quvchi tokeni (ota-ona ilovasi ham — u o'quvchi hisobi
  bilan kiradi). Boshqa rol → 403.
- **Parametr yo'q.** Sinf tokendan aniqlanadi; `classId` yuborilmaydi.
- **Sahifalanmaydi:** javob har doim 6 kun × o'quvchining sinflari.

## Javob

```json
{
  "success": true,
  "data": {
    "today": "seshanba",
    "sheetDiffers": true,
    "sheet": {
      "mode": "sheet",
      "schoolPending": true,
      "diffAvailable": true,
      "revisionId": "6ad5…",
      "detectedAt": "2026-11-17T07:40:00.000Z",
      "detectedAtLabel": "17-noyabr, 2026 12:40"
    },
    "classes": [
      {
        "classId": "6a9b…",
        "className": "7-A",
        "sheetDiffers": true,
        "schedules": [
          {
            "id": "6ad5…",
            "class": "6a9b…",
            "day": "dushanba",
            "dayLabel": "Dushanba",
            "sheetDiffers": true,
            "subjects": [
              {
                "id": "6ad5…",
                "order": 1,
                "subject": { "id": "…", "name": "Fizika" },
                "teacher": { "id": "…", "firstName": "Ali", "lastName": "Aliyev" },
                "startTime": "08:30",
                "endTime": "09:15",
                "sheetDiffers": true
              }
            ],
            "sheetChanges": [
              {
                "day": "dushanba",
                "dayLabel": "Dushanba",
                "order": 1,
                "type": "changed",
                "field": "teacher",
                "before": { "subjectId": "…", "subject": "Fizika", "teacherId": "…", "teacher": "Aliyev A.", "startTime": "08:30", "endTime": "09:15" },
                "after":  { "subjectId": "…", "subject": "Fizika", "teacherId": "…", "teacher": "Valiyev V.", "startTime": "08:30", "endTime": "09:15" }
              }
            ],
            "updatedAt": "2026-11-10T05:00:00.000Z"
          }
        ]
      }
    ]
  }
}
```

## Maydonlar

| Maydon | Ma'nosi |
|---|---|
| `today` | Bugungi hafta kuni (Toshkent). Yakshanba bo'lsa `"yakshanba"` — jadvalda yo'q, birinchi kunni oching |
| `sheetDiffers` (ildizda) | O'quvchining birorta sinfi farq qiladimi |
| `classes[].sheetDiffers` | Shu sinfning jadvali Google Sheets'dagidan farq qiladi |
| `schedules[]` | Haftaning HAMMA kuni (`dushanba` … `shanba`), darsi yo'q kun ham: `id: null`, `subjects: []` |
| `schedules[].sheetDiffers` | Shu kunda kamida bitta o'zgarish (QO'SHILGAN dars ham) |
| `schedules[].sheetChanges` | Shu kunning kutilayotgan o'zgarishlari |
| `subjects[].sheetDiffers` | Shu dars sheet'da boshqacha yoki olib tashlanadi |
| `sheetChanges[].type` | `added` (qo'shiladi, `before: null`) / `removed` (olib tashlanadi, `after: null`) / `changed` |
| `sheetChanges[].field` | `changed` da: `teacher` / `subject` / `time`, bir nechtasi o'zgarsa `null` |
| `sheet.mode` | `platform` — jadval paneldan tahrirlanadi, `sheetDiffers` doim `false`; `sheet` — Google Sheets'dan |
| `sheet.diffAvailable` | `false` — sheet'da xato bor, qaysi dars o'zgarishi noma'lum (pastga qarang) |
| `sheet.schoolPending` | Butun maktab bo'yicha tasdiqlanmagan tahrir bor (shu sinfga tegmasligi mumkin) |

## Ilova uchun qoidalar

- **Ko'rsatiladigan jadval — `subjects`**, ya'ni AMALDAGI jadval.
  `sheetChanges` — faqat "nima o'zgaradi" degan ma'lumot, hali kuchga
  kirmagan.
- **Dars kun + tartib (`order`) bo'yicha belgilanadi**, `id` bo'yicha emas:
  `id` jadval qayta saqlanganda o'zgaradi.
- **Qo'shiladigan dars `subjects` da yo'q** — u faqat kunning
  `sheetDiffers` / `sheetChanges` ida ko'rinadi.
- **`diffAvailable: false`** bo'lsa: sinf `sheetDiffers: true`, lekin kun va
  dars belgilari `false` va `sheetChanges` bo'sh. "Jadval yangilanmoqda"
  deb aytiladi, qaysi dars ekani aytilmaydi.
- **Farq = tasdiqlanmagan tahrir.** Admin o'zgarishni rad etsa yoki
  qo'llasa belgi darhol yo'qoladi; sheet har ~10 daqiqada tekshiriladi.
- Sana matni (`detectedAtLabel`) tayyor keladi — ilova o'zi formatlamaydi.
