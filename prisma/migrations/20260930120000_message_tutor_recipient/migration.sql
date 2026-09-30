-- Tyutor o'zi biriktirilgan (guruhidagi) o'quvchilarga xabar yuborishi uchun
-- yangi qabul qiluvchi turi. Bitta xabarda tyutorning barcha o'quvchilari.
ALTER TYPE "MessageRecipientType" ADD VALUE IF NOT EXISTS 'tutor';
