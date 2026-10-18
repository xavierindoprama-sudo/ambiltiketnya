-- Jalankan di Neon SQL Editor jika ingin migrasi manual (Code.gs juga menjalankan auto-migration saat dipanggil).
-- Menambah kolom untuk kuota walk-in terpisah dan data peserta walk-in di tempat.

ALTER TABLE events ADD COLUMN IF NOT EXISTS walkin_quota int DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_phone text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_email text;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('order','invitation','walk_in'));
