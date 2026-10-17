-- Jalankan di Neon SQL Editor SEBELUM memasang Code.gs / Index.html versi baru.
ALTER TABLE events ADD COLUMN IF NOT EXISTS terms text NOT NULL DEFAULT '';

-- OPSIONAL: isi syarat & ketentuan standar untuk acara yang sudah ada (hapus tanda -- di bawah untuk menjalankan).
-- UPDATE events SET terms =
-- '1. Tiket berlaku untuk satu kali masuk dan sesuai jumlah tiket pada pesanan.
-- 2. Tunjukkan QR code e-tiket di gerbang masuk. Satu QR berlaku untuk seluruh rombongan dalam satu pesanan.
-- 3. Peserta diharapkan hadir sebelum acara dimulai. Pintu dibuka sesuai pengumuman panitia.
-- 4. Tiket tidak dapat dipindahtangankan atau diperjualbelikan.
-- 5. Panitia berhak menolak peserta yang tidak membawa tiket yang sah atau mengganggu jalannya acara.
-- 6. Jadwal dan susunan acara dapat berubah sewaktu-waktu sesuai kebijakan panitia.
-- 7. Dengan memesan tiket, peserta menyetujui syarat dan ketentuan ini.'
-- WHERE terms = '';
