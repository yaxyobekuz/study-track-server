-- STANDART TARIF: yangi o'quvchiga avtomat biriktiriladigan tarif ko'rsatkichi.
-- soft ref → platform.tariffs (FK yo'q: boshqa schema'da yotadi).
ALTER TABLE "finance_settings" ADD COLUMN "default_tariff_id" CHAR(24);
