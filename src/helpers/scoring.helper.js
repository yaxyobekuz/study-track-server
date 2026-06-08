/**
 * Test ball berish tizimi yordamchilari.
 *
 * Savollar endi qo'lda ball bilan emas, qiyinlik darajasi bilan belgilanadi.
 * Tizimda belgilangan maksimal ball test savollariga ularning qiyinlik
 * vaznlariga qarab avtomatik taqsimlanadi (Oson < O'rta < Qiyin).
 */

// Qiyinlik vaznlari - bitta manba (Oson 1 : O'rta 2 : Qiyin 3)
const DIFFICULTY_WEIGHTS = { easy: 1, medium: 2, hard: 3 };
const DIFFICULTY_VALUES = ["easy", "medium", "hard"];

/**
 * Qiyilik darajasining vaznini qaytaradi (noma'lum bo'lsa - "medium").
 * @param {string} difficulty
 * @returns {number}
 */
function weightOf(difficulty) {
  return DIFFICULTY_WEIGHTS[difficulty] ?? DIFFICULTY_WEIGHTS.medium;
}

/**
 * Maksimal ballni savollarga qiyinlik vaznlariga qarab taqsimlaydi.
 * Har bir savolning `points` qiymatini o'rnatadi; yig'indisi globalMax ga teng bo'ladi.
 * Float qiymatlar saqlanadi (yaxlitlash faqat ko'rsatishda).
 *
 * @param {Array<{difficulty:string, points:number}>} questions - muzlatilgan savollar
 * @param {number} globalMax - tizimdagi maksimal ball
 * @returns {Array} o'zgartirilgan savollar (mutatsiya qilingan)
 */
function distributePoints(questions, globalMax) {
  const totalWeight = questions.reduce((sum, q) => sum + weightOf(q.difficulty), 0);
  if (totalWeight === 0) {
    questions.forEach((q) => {
      q.points = 0;
    });
    return questions;
  }
  questions.forEach((q) => {
    q.points = (weightOf(q.difficulty) / totalWeight) * globalMax;
  });
  return questions;
}

module.exports = {
  DIFFICULTY_WEIGHTS,
  DIFFICULTY_VALUES,
  weightOf,
  distributePoints,
};
