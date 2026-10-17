-- Migrasi dari skema lama (Google Sign-In) ke login email + password.
-- AMAN dijalankan karena data lama hanya akun uji (events/orders masih kosong).
-- PERHATIAN: baris TRUNCATE menghapus semua akun lama beserta sesi & pesanannya.
BEGIN;
DROP TABLE IF EXISTS login_nonces;
TRUNCATE users CASCADE;
ALTER TABLE users DROP COLUMN IF EXISTS google_sub;
ALTER TABLE users DROP COLUMN IF EXISTS picture;
ALTER TABLE users ADD COLUMN password_hash text NOT NULL;
ALTER TABLE users ADD COLUMN failed_attempts int NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until timestamptz;
ALTER TABLE users ALTER COLUMN whatsapp SET NOT NULL;
ALTER TABLE users ALTER COLUMN age SET NOT NULL;
ALTER TABLE users ALTER COLUMN church SET NOT NULL;
CREATE TABLE password_resets (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  otp_hash   text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
