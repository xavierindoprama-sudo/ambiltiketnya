-- Jalankan di Neon SQL Editor SEBELUM memasang Code.gs / Index.html versi baru.
CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
