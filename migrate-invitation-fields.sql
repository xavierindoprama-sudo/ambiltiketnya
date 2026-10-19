-- Migration: Tambah kolom guest_age di tabel orders untuk data usia tamu undangan & walk-in
ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_age int;
