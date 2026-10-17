-- Jalankan di Neon SQL Editor SEBELUM menguji Google Sign-In
-- Memperbarui tabel users agar mendukung autentikasi Google OAuth 2.0:
-- 1. Menambahkan kolom google_sub dan picture
-- 2. Mengizinkan kolom whatsapp, age, church, password_hash bernilai NULL untuk pendaftaran via Google
--    (Data whatsapp, age, dan church akan dilengkapi oleh pengguna baru saat pertama kali masuk)

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS picture text;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uq ON users (google_sub) WHERE google_sub IS NOT NULL;

-- Relaksasi constraint agar pengguna baru Google bisa dibuat terlebih dahulu
ALTER TABLE users ALTER COLUMN whatsapp DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_whatsapp_check;
ALTER TABLE users ADD CONSTRAINT users_whatsapp_check CHECK (whatsapp IS NULL OR whatsapp ~ '^628[0-9]{7,11}$');

ALTER TABLE users ALTER COLUMN age DROP NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check;
ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age IS NULL OR (age BETWEEN 1 AND 120));

ALTER TABLE users ALTER COLUMN church DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

COMMIT;
