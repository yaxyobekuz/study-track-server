-- Testning savollar taqsimoti (reja): [{ subjectId, grade, easy, medium, hard }]
-- ⚠️ Qo'shimcha ustun, nullable — mavjud testlarga tegmaydi.
ALTER TABLE "diagnostic_tests" ADD COLUMN "blueprint" JSONB;
