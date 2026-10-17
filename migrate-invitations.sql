-- Jalankan di Neon SQL Editor SEBELUM memasang Code.gs versi baru.
-- Menambah kolom untuk fitur Undangan (aman: data lama otomatis berjenis 'order').
ALTER TABLE orders ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'order';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_name text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_org  text;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check;
ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('order','invitation'));
