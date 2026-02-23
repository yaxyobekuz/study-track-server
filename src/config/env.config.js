/**
 * Environment Variables Validation
 *
 * Server ishga tushishidan oldin barcha kerakli environment variables'lar
 * mavjudligini tekshiradi va default qiymatlarni belgilaydi.
 */

const requiredEnvVars = ["MONGODB_URI", "JWT_SECRET"];

const optionalEnvVars = {
  PORT: 5000,
  NODE_ENV: "development",
  JWT_EXPIRES_IN: "30d",
  LOG_LEVEL: "info",
  DO_REGION: "fra1",
  MAX_UPLOAD_FILE_SIZE_MB: 20,
};

/**
 * Environment variables'larni tekshiradi
 * @throws {Error} Agar majburiy environment variable yo'q bo'lsa
 */
const validateEnv = () => {
  const missingVars = [];

  // Majburiy variables'larni tekshirish
  requiredEnvVars.forEach((varName) => {
    if (!process.env[varName]) {
      missingVars.push(varName);
    }
  });

  if (missingVars.length > 0) {
    throw new Error(
      `Quyidagi environment variables kiritilmagan: ${missingVars.join(", ")}\n` +
        `Iltimos, .env faylida ushbu qiymatlarni to'ldiring.`,
    );
  }

  // Optional variables uchun default qiymatlarni belgilash
  Object.entries(optionalEnvVars).forEach(([key, defaultValue]) => {
    if (!process.env[key]) {
      process.env[key] = String(defaultValue);
      console.log(
        `⚠️  ${key} environment variable kiritilmagan. Default qiymat ishlatilmoqda: ${defaultValue}`,
      );
    }
  });

  // Environment info
  console.log("✅ Environment variables tekshirildi");
  console.log(`📌 NODE_ENV: ${process.env.NODE_ENV}`);
  console.log(`📌 PORT: ${process.env.PORT}`);
};

module.exports = validateEnv;
