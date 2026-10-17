# Icons untuk PWA AmbilTiketnya

Tempatkan file ikon di folder ini agar PWA (Progressive Web App) berfungsi penuh.

| File | Ukuran | Keterangan |
|------|--------|------------|
| `icon-192.png` | 192×192 px | Ikon app utama (wajib untuk install prompt) |
| `icon-512.png` | 512×512 px | Ikon splash screen (wajib) |
| `screenshot-mobile.png` | 390×844 px | Screenshot untuk install prompt (opsional) |

## Cara membuat ikon

### Opsi 1 — Generator online (termudah)
1. Buka https://realfavicongenerator.net
2. Upload logo / gambar sumber
3. Download hasilnya dan ambil file `android-chrome-192x192.png` dan `android-chrome-512x512.png`
4. Rename menjadi `icon-192.png` dan `icon-512.png`

### Opsi 2 — Figma / desain sendiri
- Warna utama: `#5b4ef0` (ungu)
- Warna sekunder: `#8b5cf6`
- Desain: ikon tiket (sesuai logo AmbilTiketnya)
- Background: rounded square, bukan transparan (agar maskable icon bekerja)
- Export sebagai PNG

## Catatan
Tanpa ikon, app tetap bisa dipakai, tapi tombol "Install App" di browser tidak akan muncul.
