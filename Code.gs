/**
 * ambiltiketnya.online - backend Google Apps Script (login email + password, tanpa Google Sign-In)
 * Project Settings > Script properties:
 *   DATABASE_URL     connection string Neon (postgresql://user:pass@ep-xxx-pooler.../db?sslmode=require)
 *   SCAN_URL         URL scan.html di GitHub Pages
 *   APP_URL          URL deployment web app ini (berakhiran /exec), tautan cadangan di pesan WhatsApp
 *   SITE_URL         (opsional) alamat situs di akhir pesan WhatsApp, default https://www.ambiltiketnya.online
 *   BREVO_API_KEY       (opsional) API key Brevo - dipakai otomatis bila kuota email harian Gmail/Apps Script habis
 *   BREVO_SENDER_EMAIL  (wajib jika Brevo dipakai) email pengirim yang sudah diverifikasi di Brevo
 *   BREVO_SENDER_NAME   (opsional) nama pengirim, default AmbilTiketnya
 *   ORG_NAME         (opsional) nama pengelola di halaman syarat/privasi/cookie
 *   CONTACT_EMAIL    (opsional) email kontak di halaman syarat/privasi/cookie
 *   TICKET_FOLDER_ID (otomatis) id folder Google Drive berisi gambar e-tiket
 *   SUPERADMIN_EMAIL email yang menjadi super admin saat DAFTAR (hanya jika belum ada super admin)
 * Apps Script tidak bisa JDBC ke PostgreSQL, jadi memakai Neon SQL-over-HTTP (UrlFetchApp).
 */
const P = PropertiesService.getScriptProperties();
const RANK = { attendee: 0, gate_staff: 1, admin: 2, super_admin: 3 };

/* ---------- Web app entry ---------- */
function doGet(e) {
  if (e && e.parameter && e.parameter.ping) return jsonOut({ ok: true, ping: 'pong' });   // uji cepat: buka alamat /exec?ping=1
  const tk = e && e.parameter && e.parameter.tiket;
  if (e && e.parameter && e.parameter.hal) return legalPage(String(e.parameter.hal));   // halaman syarat / privasi / cookie
  if (tk) return ticketPage(String(tk));            // halaman publik tiket (tautan di pesan WhatsApp)
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('ambiltiketnya.online')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
/* ---------- API JSON untuk tampilan yang dihosting di luar Apps Script (mis. GitHub Pages) ----------
 * Klien memanggil POST ke alamat /exec dengan isi {"fn":"nama","args":[...]} (Content-Type: text/plain agar tanpa preflight CORS).
 * Hanya fungsi pada daftar putih di bawah yang bisa dipanggil; semuanya sama dengan yang dipakai google.script.run. */
const API_FNS = { init: init, register: register, loginPw: loginPw, loginGoogle: loginGoogle, forgotRequest: forgotRequest, forgotReset: forgotReset, legalPublic: legalPublic, ticketPublic: ticketPublic, eventsPublic: eventsPublic, api: api, migrateOauth: migrateOauth };
function jsonOut(o) { return ContentService.createTextOutput(JSON.stringify(o === undefined ? null : o)).setMimeType(ContentService.MimeType.JSON); }
function doPost(e) {
  let out;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const f = Object.prototype.hasOwnProperty.call(API_FNS, req.fn) ? API_FNS[req.fn] : null;
    if (!f) throw new Error('NOT_FOUND');
    out = f.apply(null, Array.isArray(req.args) ? req.args : []);
  } catch (err) { Logger.log(err.stack || err); out = { __error: /^[A-Z_]+$/.test(String(err && err.message)) ? err.message : 'E_GENERIC' }; }
  return jsonOut(out);
}
// Halaman tiket sederhana (tanpa JavaScript): hanya info acara + QR + kode. Tidak menampilkan nama/email/telepon pemilik.
function ticketInfo(raw) {                       // dipakai halaman tiket (/exec?tiket=) dan API ticketPublic
  const code = String(raw || '').trim().toUpperCase();
  let o = null;
  if (/^TKT-[A-Z]{1,4}-[A-Z0-9]{6}$/.test(code)) {
    try { o = q(`SELECT o.ticket_code,o.qty,o.status,o.checked_in,o.kind,e.name,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location
      FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code])[0]; } catch (err) { Logger.log(err); }
  }
  const st = !o ? 'NOT_FOUND' : o.status === 'cancelled' ? 'CANCELLED' : o.status === 'pending_payment' ? 'UNPAID' : o.checked_in >= o.qty ? 'USED' : 'OK';
  return { code: code, o: o, st: st };
}
// untuk halaman GitHub: kembalikan hanya info acara + status + kode (tanpa nama/email/telepon pemilik)
function ticketPublic(p) { return pubRun(ticketPublicImpl, p); }
function ticketPublicImpl(p) {
  const ti = ticketInfo(p && p.code), o = ti.o;
  return o ? { found: true, kind: o.kind, status: ti.st, code: o.ticket_code, name: o.name, edate: o.edate, stime: o.stime, location: o.location, qty: o.qty } : { found: false };
}
function ticketPage(raw) {
  const ti = ticketInfo(raw), o = ti.o, st = ti.st;
  const msg = { NOT_FOUND: 'Tiket tidak ditemukan.', CANCELLED: 'Pesanan ini sudah dibatalkan.', UNPAID: 'Menunggu konfirmasi pembayaran.', USED: 'Tiket ini sudah digunakan untuk check-in.' }[st];
  const f = (l, v) => '<div class="r"><small>' + l + '</small><b>' + esc(v) + '</b></div>';
  const body = !o ? '<div class="m">' + msg + '</div>'
    : (st === 'OK' || st === 'USED' ? '<div class="q"><img alt="QR" width="230" height="230" src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=' + encodeURIComponent(o.ticket_code) + '"><div class="k">' + esc(o.ticket_code) + '</div><div class="s">Pindai di gerbang masuk</div></div>' : '')
      + (msg ? '<div class="m">' + msg + '</div>' : '')
      + '<div class="d">' + f('Hari & Tanggal', idDate(o.edate)) + f('Waktu', o.stime + ' WIB') + f('Lokasi', o.location) + f('Jumlah Tiket', o.qty + ' orang') + '</div>';
  const html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + ':root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4fb;font-family:Arial,sans-serif;color:#0f1222}'
    + '.c{width:min(380px,92vw);background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.15);margin:16px 0}.h{background:#0f1222;color:#fff;padding:20px}.h small{letter-spacing:3px;color:#9a8cff;font-size:10px}.h h1{margin:6px 0 0;font-size:20px}'
    + '.q{text-align:center;padding:18px 16px 6px}.q img{width:230px;height:230px}.k{font:700 18px monospace;margin-top:10px}.s{color:#778;font-size:12px;margin-top:2px}.m{margin:12px 18px;padding:12px;border-radius:10px;background:#fff4e5;color:#8a5200;font-size:14px;text-align:center}'
    + '.d{padding:10px 20px 20px}.r{margin-top:12px}.r small{display:block;color:#778;font-size:10px;letter-spacing:1px;text-transform:uppercase}.r b{font-size:15px}'
    + '@media(prefers-color-scheme:dark){body{background:#090c16}.c{background:#111627;color:#eef0fa}.q{background:#fff;margin:14px 20px 0;border-radius:14px;padding:14px}.q .k,.q .s{color:#0f1222}.s{color:#667!important}}'
    + '</style></head><body><div class="c"><div class="h"><small>E-TIKET - AMBILTIKETNYA</small><h1>' + esc(o ? o.name : 'E-Tiket') + '</h1></div>' + body + '</div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(o ? 'E-Tiket ' + o.name : 'E-Tiket')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
/* ---------- Halaman hukum publik: ?hal=syarat | privasi | cookie ----------
 * Teks di bawah adalah TEMPLATE awal yang disesuaikan dengan cara kerja aplikasi. Mohon dibaca dan disesuaikan
 * (nama pengelola, kontak, masa simpan data) bersama pengurus/penasihat hukum sebelum dipakai secara resmi. */
const LEGAL_UPDATED = 'Oktober 2026';   // tanggal untuk teks bawaan; teks yang diedit memakai tanggal penyimpanan
const LEGAL = {
  syarat: { title: 'Syarat dan Ketentuan', s: [
    ['1. Tentang Layanan', ['ambiltiketnya.online adalah layanan pemesanan tiket acara gereja dan komunitas yang dikelola oleh {ORG}.', 'Dengan membuat akun, memesan tiket, atau menggunakan layanan ini, Anda menyatakan telah membaca, memahami, dan menyetujui Syarat dan Ketentuan ini.']],
    ['2. Akun Pengguna', ['- Anda wajib memberikan data yang benar dan terbaru: nama, email, nomor WhatsApp, usia, dan gereja/komunitas.', '- Jaga kerahasiaan password Anda. Aktivitas yang dilakukan melalui akun Anda menjadi tanggung jawab Anda.', '- Satu orang sebaiknya memiliki satu akun. Akun yang disalahgunakan dapat ditangguhkan atau dihapus.']],
    ['3. Pemesanan dan Tiket', ['- Kuota tiket terbatas. Batas jumlah tiket per transaksi dan per akun ditetapkan penyelenggara untuk setiap acara.', '- Setiap pesanan mendapat satu kode QR yang berlaku untuk seluruh jumlah tiket dalam pesanan tersebut dan hanya dapat digunakan untuk check-in satu kali.', '- Jaga kerahasiaan QR code dan tautan e-tiket Anda. Siapa pun yang memegangnya dapat menggunakannya di gerbang masuk. Jangan membagikannya kepada pihak yang tidak berhak.', '- Penyelenggara berhak membatalkan pesanan yang melanggar ketentuan atau dibuat dengan data yang tidak benar.']],
    ['4. Acara Berbayar', ['Untuk acara berbayar, pembayaran dikonfirmasi secara manual oleh admin. Pesanan baru aktif dan tiket diterbitkan setelah pembayaran dikonfirmasi. Kebijakan pengembalian dana (jika ada) mengikuti syarat dan ketentuan masing-masing acara.']],
    ['5. Syarat dan Ketentuan Acara', ['Setiap acara dapat memiliki syarat dan ketentuan sendiri yang ditampilkan pada halaman detail acara. Ketentuan tersebut berlaku bersama dengan Syarat dan Ketentuan ini. Jika terdapat perbedaan, syarat dan ketentuan acara yang berlaku untuk acara yang bersangkutan.']],
    ['6. Larangan', ['Anda dilarang: mengakses sistem atau data tanpa izin; memalsukan, menggandakan, atau memperjualbelikan tiket dan QR code; memakai program otomatis untuk memesan tiket; serta mengganggu keamanan atau kinerja layanan.']],
    ['7. Email dan WhatsApp', ['E-tiket dikirim melalui email ke alamat yang Anda daftarkan. Tautan e-tiket dapat dikirim melalui WhatsApp atas tindakan Anda sendiri. Kami tidak bertanggung jawab atas kegagalan pengiriman akibat alamat email atau nomor yang salah, atau gangguan pada layanan pihak ketiga seperti Google dan WhatsApp.']],
    ['8. Ketersediaan dan Batas Tanggung Jawab', ['Layanan disediakan sebagaimana adanya dan kami tidak menjamin layanan selalu bebas dari gangguan. Sejauh diizinkan hukum, kami tidak bertanggung jawab atas kerugian tidak langsung yang timbul dari penggunaan layanan. Pelaksanaan acara menjadi tanggung jawab penyelenggara acara masing-masing.']],
    ['9. Perubahan Ketentuan', ['Ketentuan ini dapat diperbarui sewaktu-waktu. Versi terbaru ditampilkan pada halaman ini. Dengan tetap menggunakan layanan setelah perubahan, Anda dianggap menyetujui ketentuan yang diperbarui.']],
    ['10. Hukum dan Kontak', ['Ketentuan ini tunduk pada hukum Republik Indonesia. Pertanyaan dapat disampaikan {KONTAK}.']]] },
  privasi: { title: 'Kebijakan Privasi', s: [
    ['1. Data yang Kami Kumpulkan', ['- Data akun: nama, email, nomor WhatsApp, usia, gereja/komunitas, dan password (disimpan hanya dalam bentuk hash, bukan password asli).', '- Data pemesanan: acara, jumlah tiket, status pesanan, kode tiket, dan waktu pemesanan.', '- Data check-in: waktu check-in dan petugas yang melakukannya.', '- Data teknis terbatas: token sesi agar Anda tetap masuk.']],
    ['2. Tujuan Penggunaan', ['Data digunakan untuk membuat dan mengelola akun, memproses pesanan, mengirim e-tiket melalui email dan tautan e-tiket melalui WhatsApp, memvalidasi tiket di gerbang masuk, menghubungi Anda terkait acara, menyusun statistik kehadiran, serta menjaga keamanan layanan.']],
    ['3. Persetujuan', ['Dengan mendaftar, Anda menyetujui pengumpulan dan penggunaan data sebagaimana dijelaskan dalam kebijakan ini.']],
    ['4. Penyimpanan dan Penyedia Layanan', ['Data disimpan dan diproses menggunakan layanan pihak ketiga berikut, yang dapat berlokasi di luar Indonesia:', '- Neon (basis data PostgreSQL) untuk menyimpan data akun dan pesanan.', '- Google (Apps Script, Gmail, Google Drive) untuk menjalankan aplikasi, mengirim email e-tiket, dan menyimpan gambar e-tiket.', '- api.qrserver.com untuk membuat gambar QR pada PDF dan halaman tiket (hanya menerima kode tiket).', '- Google Fonts dan penyedia pustaka (CDN) saat halaman dimuat, yang dapat mencatat alamat IP Anda.']],
    ['5. Pembagian Data', ['Kami tidak menjual data pribadi. Data pemesan dan peserta hanya dapat dilihat oleh admin, penyelenggara, dan petugas gerbang sesuai peran masing-masing, serta oleh penyedia layanan teknologi di atas sebatas diperlukan untuk menjalankan layanan, atau bila diwajibkan hukum.']],
    ['6. Gambar dan Tautan E-Tiket', ['Gambar e-tiket yang disimpan di Google Drive dapat dibuka oleh siapa pun yang memiliki tautannya dan memuat nama pemesan, informasi acara, dan QR code. Jangan membagikan tautan tersebut kepada pihak yang tidak berhak. Gambar dihapus ketika pesanan dibatalkan.']],
    ['7. Masa Penyimpanan', ['Data disimpan selama akun Anda aktif dan selama diperlukan untuk penyelenggaraan serta pencatatan acara. Anda dapat meminta penghapusan data kepada kami.']],
    ['8. Hak Anda', ['Sesuai Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi, Anda berhak mengakses, memperbaiki, dan meminta penghapusan data pribadi Anda, serta menarik persetujuan. Hubungi kami {KONTAK}.']],
    ['9. Keamanan', ['Kami menjaga data dengan penyimpanan password berbentuk hash, pembatasan akses berdasarkan peran, dan pembatasan percobaan masuk. Tidak ada sistem yang sepenuhnya bebas risiko, sehingga kami tidak dapat menjamin keamanan mutlak.']],
    ['10. Pengguna di Bawah Umur', ['Pengguna yang belum dewasa sebaiknya mendaftar dan memesan tiket dengan sepengetahuan orang tua atau wali.']],
    ['11. Perubahan Kebijakan', ['Kebijakan ini dapat diperbarui sewaktu-waktu. Versi terbaru ditampilkan pada halaman ini.']]] },
  cookie: { title: 'Kebijakan Cookie', s: [
    ['1. Penggunaan Cookie dan Penyimpanan Lokal', ['Kami tidak memakai cookie iklan atau pelacak perilaku. Aplikasi menyimpan beberapa data kecil yang diperlukan agar layanan berfungsi pada penyimpanan lokal (localStorage) peramban Anda:', '- Token sesi, agar Anda tetap masuk (berlaku hingga 7 hari atau sampai Anda menekan Keluar).', '- Pilihan bahasa dan tema tampilan.', '- Pilihan tampilan menu samping dan mode dashboard.']],
    ['2. Layanan Pihak Ketiga', ['Layanan Google (Apps Script dan Google Fonts) serta penyedia pustaka (CDN) yang dimuat oleh halaman ini dapat menetapkan cookie atau mencatat alamat IP sesuai kebijakan masing-masing penyedia.']],
    ['3. Mengelola Data', ['Anda dapat menghapus data situs melalui pengaturan peramban atau menekan Keluar di aplikasi. Setelah itu Anda perlu masuk kembali dan mengatur ulang bahasa serta tema.']],
    ['4. Perubahan dan Kontak', ['Kebijakan ini dapat diperbarui sewaktu-waktu. Pertanyaan dapat disampaikan {KONTAK}.']]] }
};
const LEGAL_KEYS = ['syarat', 'privasi', 'cookie'];
// teks bawaan -> format sederhana: "## Judul bagian", "- butir daftar", paragraf dipisah baris kosong
function legalDefault(key) {
  const d = LEGAL[key]; if (!d) return '';
  const out = [];
  d.s.forEach(sec => {
    out.push('## ' + sec[0]);
    let prevBullet = false;
    sec[1].forEach((t, i) => {
      const bullet = t.indexOf('- ') === 0;
      if (i > 0 && !(bullet && prevBullet)) out.push('');
      out.push(t); prevBullet = bullet;
    });
    out.push('');
  });
  return out.join('\n').trim();
}
const fmtLegalDate = d => idDate(d).split(', ')[1];
function legalDoc(key) {                          // teks yang diedit (jika ada) atau teks bawaan; di-cache 5 menit
  const cache = CacheService.getScriptCache(), ck = 'legal:' + key, hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  let doc = { text: legalDefault(key), custom: false, updated: LEGAL_UPDATED };
  try {
    const r = q(`SELECT value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS d FROM settings WHERE key=$1`, ['legal_' + key])[0];
    if (r) doc = { text: r.value, custom: true, updated: fmtLegalDate(r.d) };
  } catch (e) { Logger.log(e); }
  try { cache.put(ck, JSON.stringify(doc), 300); } catch (e) { /* abaikan */ }
  return doc;
}
function legalGetAll() {                          // untuk editor di dashboard (tanpa cache)
  const rows = q(`SELECT key, value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS d FROM settings WHERE key IN ('legal_syarat','legal_privasi','legal_cookie')`);
  return LEGAL_KEYS.map(k => {
    const r = rows.filter(x => x.key === 'legal_' + k)[0];
    return { key: k, title: LEGAL[k].title, text: r ? r.value : legalDefault(k), custom: !!r, updated: r ? fmtLegalDate(r.d) : LEGAL_UPDATED, def: legalDefault(k) };
  });
}
function legalSave(u, p) {
  const key = String(p.key || '');
  if (LEGAL_KEYS.indexOf(key) < 0) throw new Error('NOT_FOUND');
  if (p.reset) q(`DELETE FROM settings WHERE key=$1 RETURNING key`, ['legal_' + key]);
  else {
    const text = String(p.text || '').replace(/\r\n/g, '\n').trim();
    if (text.length < 20 || text.length > 30000) throw new Error('BAD_LEGAL');
    q(`INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now() RETURNING key`, ['legal_' + key, text]);
  }
  CacheService.getScriptCache().remove('legal:' + key);
  return true;
}
function renderLegalText(text, fill) {
  let html = '', list = false, para = [];
  const flush = () => { if (para.length) { html += '<p>' + para.map(fill).join('<br>') + '</p>'; para = []; } };
  const close = () => { if (list) { html += '</ul>'; list = false; } };
  String(text).split(/\r?\n/).forEach(raw => {
    const l = raw.trim();
    if (!l) { flush(); close(); return; }
    if (l.indexOf('## ') === 0) { flush(); close(); html += '<h2>' + fill(l.slice(3)) + '</h2>'; return; }
    if (l.indexOf('- ') === 0) { flush(); if (!list) { html += '<ul>'; list = true; } html += '<li>' + fill(l.slice(2)) + '</li>'; return; }
    close(); para.push(l);
  });
  flush(); close();
  return html;
}
function legalFiller() {                          // escape HTML + isi {ORG} dan {KONTAK}
  const org = P.getProperty('ORG_NAME') || 'pengelola ambiltiketnya.online', mail = P.getProperty('CONTACT_EMAIL');
  return x => esc(x).replace(/\{ORG\}/g, esc(org)).replace(/\{KONTAK\}/g, mail ? 'melalui email ' + esc(mail) : 'kepada panitia atau penyelenggara acara');
}
// untuk pop-up di dalam aplikasi (tanpa login): halaman login memanggil fungsi ini lewat google.script.run
function legalPublic(p) { return pubRun(legalPublicImpl, p); }
function legalPublicImpl(p) {
  const key = String((p && p.key) || '');
  if (!LEGAL[key]) throw new Error('NOT_FOUND');
  const doc = legalDoc(key);
  return { title: LEGAL[key].title, updated: doc.updated, html: renderLegalText(doc.text, legalFiller()) };
}
function legalPreview(p) {                        // pratinjau draf di editor dashboard (belum disimpan)
  const key = String((p && p.key) || '');
  if (!LEGAL[key]) throw new Error('NOT_FOUND');
  return { title: LEGAL[key].title, html: renderLegalText(String(p.text || '').slice(0, 30000), legalFiller()) };
}
function legalPage(key) {
  const d = LEGAL[key], base = P.getProperty('APP_URL') || '';
  const fill = legalFiller();
  const doc = d ? legalDoc(key) : null;
  const body = d ? renderLegalText(doc.text, fill) : '<p>Halaman tidak ditemukan.</p>';
  const nav = base ? '<div class="n">' + [['syarat', 'Syarat dan Ketentuan'], ['privasi', 'Kebijakan Privasi'], ['cookie', 'Kebijakan Cookie']].map(x => '<a target="_top" href="' + esc(base) + '?hal=' + x[0] + '">' + x[1] + '</a>').join(' | ') + '</div>' : '';
  const html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + ':root{color-scheme:light dark}body{margin:0;background:#f3f4fb;color:#0f1222;font:15px/1.65 Arial,sans-serif}.w{max-width:760px;margin:0 auto;padding:20px 18px 40px}'
    + '.h{background:#0f1222;color:#fff;padding:22px 20px;border-radius:16px;margin-bottom:18px}.h small{letter-spacing:3px;color:#9a8cff;font-size:10px}.h h1{margin:6px 0 2px;font-size:24px}.h span{color:#b9bfe0;font-size:12px}'
    + 'h2{font-size:17px;margin:24px 0 6px}p,li{margin:6px 0}ul{padding-left:20px}.n{margin:12px 0 4px;font-size:13px}.n a{color:#5b4ef0;font-weight:bold;text-decoration:none}.f{margin-top:30px;color:#778;font-size:12px}'
    + '@media(prefers-color-scheme:dark){body{background:#090c16;color:#eef0fa}.n a{color:#9a8cff}}</style></head><body><div class="w"><div class="h"><small>AMBILTIKETNYA.ONLINE</small><h1>' + esc(d ? d.title : 'Halaman') + '</h1><span>Terakhir diperbarui: ' + esc(doc ? doc.updated : '') + '</span></div>'
    + nav + body + '<div class="f">&copy; ambiltiketnya.online</div></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle(d ? d.title + ' - ambiltiketnya.online' : 'ambiltiketnya.online')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1').setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function config() { return { scanUrl: P.getProperty('SCAN_URL') || '', appUrl: P.getProperty('APP_URL') || '', siteUrl: P.getProperty('SITE_URL') || 'https://www.ambiltiketnya.online' }; }

/* ---------- Neon SQL over HTTP ---------- */
function neon(list) {
  const url = P.getProperty('DATABASE_URL');
  const host = url.match(/@([^\/?]+)/)[1];
  const body = list.length === 1 ? list[0] : { queries: list };   // batch = satu transaksi
  const r = UrlFetchApp.fetch('https://' + host + '/sql', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'Neon-Connection-String': url }, payload: JSON.stringify(body)
  });
  const txt = r.getContentText();
  let j; try { j = JSON.parse(txt); } catch (e) { j = { message: txt.slice(0, 200) }; }
  if (r.getResponseCode() !== 200) throw new Error('DB: ' + (j.message || r.getResponseCode()));
  return list.length === 1 ? [j] : j.results;
}
const wrap = sql => `WITH t AS (${sql}) SELECT coalesce(json_agg(t),'[]'::json) AS j FROM t`;
const rowsOf = res => { const j = res.rows[0].j; return typeof j === 'string' ? JSON.parse(j) : j; };
function q(sql, params) { return rowsOf(neon([{ query: wrap(sql), params: params || [] }])[0]); }

/* ---------- Cek koneksi: pilih fungsi "cekKoneksi" di editor lalu klik Run, hasil di Execution log ---------- */
function cekKoneksi() {
  const out = [], ok = m => out.push('OK     ' + m), bad = m => out.push('GAGAL  ' + m);
  ['DATABASE_URL', 'SCAN_URL', 'APP_URL', 'SUPERADMIN_EMAIL'].forEach(k => P.getProperty(k) ? ok('Property ' + k + ' terisi') : bad('Property ' + k + ' KOSONG'));
  const au = P.getProperty('APP_URL') || '';
  if (au) { /^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec$/.test(au) ? ok('APP_URL berupa alamat /exec Apps Script') : bad('APP_URL bukan alamat /exec Apps Script (' + au + '). Tautan tiket cadangan (?tiket=) hanya bekerja jika alamat itu meneruskan parameter ke aplikasi.'); }
  const url = P.getProperty('DATABASE_URL') || '';
  if (url) {
    if (!/^postgres(ql)?:\/\/[^:]+:[^@]+@[^\/?]+\/[^?]+/.test(url)) bad('Format DATABASE_URL salah. Harus: postgresql://user:password@host/dbname?sslmode=require');
    else {
      ok('Host Neon: ' + url.match(/@([^\/?]+)/)[1]);
      try {
        const t0 = Date.now(), r = q('SELECT current_database() AS db, now() AS waktu')[0];
        ok('Koneksi Neon berhasil (' + (Date.now() - t0) + ' ms), database = ' + r.db);
        const ts = []; for (let i = 0; i < 3; i++) { const t2 = Date.now(); q('SELECT 1 AS x'); ts.push(Date.now() - t2); }
        ok('Waktu per query setelah hangat: ' + ts.join(' / ') + ' ms (makin kecil makin cepat; >600 ms berarti jarak server jauh)');
        const have = q("SELECT table_name FROM information_schema.tables WHERE table_schema='public'").map(x => x.table_name);
        const miss = ['users', 'sessions', 'password_resets', 'events', 'orders', 'settings'].filter(t => have.indexOf(t) < 0);
        if (miss.length) bad('Tabel belum ada: ' + miss.join(', ') + ' -> jalankan schema.sql di Neon SQL Editor');
        else {
          const n = q('SELECT (SELECT count(*) FROM users)::int AS u,(SELECT count(*) FROM events)::int AS e,(SELECT count(*) FROM orders)::int AS o')[0];
          ok('Semua tabel ada. users=' + n.u + ', events=' + n.e + ', orders=' + n.o);
        }
      } catch (e) { bad('Koneksi Neon: ' + e.message); }
    }
  }
  try { const t1 = Date.now(); hashPw('contoh', 'garam', ITER); ok('Hash password (' + ITER + ' iterasi): ' + (Date.now() - t1) + ' ms'); } catch (e) { bad('Hash password: ' + e.message); }
  try { ok('Kuota email Gmail harian tersisa: ' + MailApp.getRemainingDailyQuota()); } catch (e) { bad('MailApp (izin kirim email belum diberikan): ' + e.message); }
  const bk = P.getProperty('BREVO_API_KEY'), bf = P.getProperty('BREVO_SENDER_EMAIL');
  if (!bk && !bf) ok('Brevo belum diatur (opsional: dipakai otomatis saat kuota Gmail habis)');
  else if (!bk || !bf) bad('Brevo: isi BREVO_API_KEY dan BREVO_SENDER_EMAIL keduanya');
  else {
    try {
      const r = UrlFetchApp.fetch('https://api.brevo.com/v3/account', { muteHttpExceptions: true, headers: { 'api-key': bk, accept: 'application/json' } });
      r.getResponseCode() === 200 ? ok('Brevo terhubung (akun: ' + (JSON.parse(r.getContentText()).email || '?') + '), pengirim: ' + bf + ' - jalankan ujiBrevo untuk mencoba kirim') : bad('Brevo HTTP ' + r.getResponseCode() + ': ' + brevoMessage(r.getContentText()) + ' | ' + brevoHint(r.getResponseCode(), r.getContentText()));
    } catch (e) { bad('Brevo: ' + e.message); }
  }
  try { if (!q("SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='kind'").length) bad('Kolom orders.kind belum ada -> jalankan migrate-invitations.sql di Neon'); else ok('Kolom orders.kind ada (fitur undangan)'); } catch (e) { bad('Cek kolom kind: ' + e.message); }
  try { if (!q("SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='terms'").length) bad('Kolom events.terms belum ada -> jalankan migrate-terms.sql di Neon'); else ok('Kolom events.terms ada'); } catch (e) { bad('Cek kolom terms: ' + e.message); }
  try {
    const fl = ticketFolder(); ok('Folder Drive e-tiket: "' + fl.getName() + '"');
    const tf = fl.createFile('uji-izin.txt', 'x');
    try { tf.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); ok('Berbagi tautan publik di Drive diizinkan'); }
    catch (e2) { bad('Berbagi tautan publik DIBLOKIR (' + e2.message + '). Tombol WhatsApp akan memakai halaman tiket sebagai cadangan.'); }
    tf.setTrashed(true);
  } catch (e) { bad('Google Drive: ' + e.message + ' (izin Drive belum diberikan? jalankan cekKoneksi lalu setujui izin baru)'); }
  const res = out.join('\n'); Logger.log(res); return res;
}

/* ---------- Auth: email + password ---------- */
const sha = s => Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s).map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
const ITER = 1500, EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function hashPw(pw, salt, iter) { let h = salt + pw; for (let i = 0; i < iter; i++) h = sha(h + salt); return iter + '$' + salt + '$' + h; }
function checkPw(pw, stored) {
  const it = parseInt(stored.split('$')[0], 10), calc = hashPw(pw, stored.split('$')[1], it);
  let d = calc.length ^ stored.length; for (let i = 0; i < calc.length && i < stored.length; i++) d |= calc.charCodeAt(i) ^ stored.charCodeAt(i);
  return d === 0;
}
function newSession(uid) {
  const token = Utilities.getUuid() + Utilities.getUuid();
  if (Math.random() < 0.1) q(`DELETE FROM sessions WHERE expires_at < now() RETURNING token_hash`);
  q(`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2::uuid, now() + interval '7 days') RETURNING token_hash`, [sha(token), uid]);
  return token;
}
// fungsi publik (tanpa token) - dibungkus agar selalu mengembalikan {ok,data|error}
function pubRun(fn, p) {
  try { return { ok: true, data: fn(p || {}) }; }
  catch (e) { Logger.log(e.stack || e); return { ok: false, error: /^[A-Z_]+$/.test(e.message) ? e.message : 'E_GENERIC' }; }
}
function checkNewPw(pw, confirm) { if (String(pw || '').length < 8) throw new Error('WEAK_PW'); if (pw !== confirm) throw new Error('PW_MISMATCH'); }
function register(p) { return pubRun(registerImpl, p); }
function loginPw(p) { return pubRun(loginImpl, p); }
function loginGoogle(p) { return pubRun(loginGoogleImpl, p); }
function forgotRequest(p) { return pubRun(forgotRequestImpl, p); }
function forgotReset(p) { return pubRun(forgotResetImpl, p); }

function registerImpl(p) {
  const name = String(p.name || '').trim(), email = String(p.email || '').trim().toLowerCase(), wa = normPhone(p.whatsapp),
    age = parseInt(p.age, 10), church = String(p.church || '').trim(), pw = String(p.password || '');
  if (name.length < 2) throw new Error('BAD_NAME');
  if (!EMAIL_RE.test(email)) throw new Error('BAD_EMAIL');
  if (!wa) throw new Error('BAD_PHONE');
  if (!(age >= 1 && age <= 120)) throw new Error('BAD_AGE');
  if (church.length < 2) throw new Error('BAD_CHURCH');
  checkNewPw(pw, String(p.confirm || ''));
  const sa = (P.getProperty('SUPERADMIN_EMAIL') || '').trim().toLowerCase();
  const r = q(`INSERT INTO users(name,email,whatsapp,age,church,password_hash,role)
    VALUES($1,$2::text,$3,$4::int,$5,$6, CASE WHEN $2::text=$7::text AND NOT EXISTS(SELECT 1 FROM users WHERE role='super_admin') THEN 'super_admin' ELSE 'attendee' END)
    ON CONFLICT DO NOTHING RETURNING id`, [name, email, wa, age, church, hashPw(pw, Utilities.getUuid(), ITER), sa]);
  if (!r.length) throw new Error('EMAIL_TAKEN');
  return { session: newSession(r[0].id) };
}
function loginImpl(p) {
  const email = String(p.email || '').trim().toLowerCase(), pw = String(p.password || '');
  const u = q(`SELECT id,password_hash,failed_attempts,(locked_until IS NOT NULL AND locked_until>now()) AS locked,(locked_until IS NOT NULL) AS had_lock FROM users WHERE lower(email)=$1`, [email])[0];
  if (u && u.locked) throw new Error('LOCKED');
  const ok = u ? checkPw(pw, u.password_hash) : (hashPw(pw, 'x', ITER), false);   // waktu respons relatif sama
  if (!ok) {
    if (u) q(`UPDATE users SET failed_attempts=CASE WHEN failed_attempts+1>=5 THEN 0 ELSE failed_attempts+1 END,
      locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '10 minutes' ELSE locked_until END WHERE id=$1::uuid RETURNING id`, [u.id]);
    throw new Error('BAD_LOGIN');
  }
  if (u.failed_attempts > 0 || u.had_lock) q(`UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=$1::uuid RETURNING id`, [u.id]);
  return { session: newSession(u.id) };
}
function loginGoogleImpl(p) {
  const cred = String(p && p.credential || '').trim();
  if (!cred) throw new Error('BAD_GOOGLE_TOKEN');
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(cred), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    Logger.log('Google tokeninfo status: ' + res.getResponseCode() + ' ' + res.getContentText());
    throw new Error('BAD_GOOGLE_TOKEN');
  }
  const payload = JSON.parse(res.getContentText());
  const configuredAud = (P.getProperty('GOOGLE_CLIENT_ID') || '866753632616-opg57movh0h0th1av7b927d7fvrg3n6e.apps.googleusercontent.com').trim();
  if (payload.aud !== configuredAud) {
    Logger.log('Google aud mismatch: got ' + payload.aud + ', expected ' + configuredAud);
    throw new Error('BAD_GOOGLE_AUD');
  }
  if (!payload.email || (payload.email_verified !== 'true' && payload.email_verified !== true)) {
    throw new Error('BAD_GOOGLE_EMAIL');
  }
  const email = String(payload.email).trim().toLowerCase();
  const name = String(payload.name || payload.given_name || email.split('@')[0]).trim();
  const sub = String(payload.sub || '');
  const picture = String(payload.picture || '');

  // Cek apakah email sudah ada di database
  let u = q(`SELECT id,whatsapp,age,church,role,locked_until FROM users WHERE lower(email)=$1`, [email])[0];
  if (u) {
    if (u.locked_until && new Date(u.locked_until) > new Date()) throw new Error('LOCKED');
    try {
      q(`UPDATE users SET failed_attempts=0,locked_until=NULL,google_sub=coalesce(google_sub,$1),picture=coalesce(picture,$2) WHERE id=$3::uuid RETURNING id`, [sub || null, picture || null, u.id]);
    } catch (e) {
      q(`UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=$1::uuid RETURNING id`, [u.id]);
    }
    return { session: newSession(u.id), isNewUser: !u.whatsapp };
  }

  // Pengguna baru mendaftar lewat Google
  const sa = (P.getProperty('SUPERADMIN_EMAIL') || '').trim().toLowerCase();
  const dummyPw = hashPw(Utilities.getUuid(), Utilities.getUuid(), ITER);
  let r;
  try {
    r = q(`INSERT INTO users(name,email,password_hash,role,google_sub,picture)
      VALUES($1,$2::text,$3,CASE WHEN $2::text=$4::text AND NOT EXISTS(SELECT 1 FROM users WHERE role='super_admin') THEN 'super_admin' ELSE 'attendee' END,$5,$6)
      RETURNING id,whatsapp`, [name, email, dummyPw, sa, sub || null, picture || null]);
  } catch (e) {
    r = q(`INSERT INTO users(name,email,password_hash,role)
      VALUES($1,$2::text,$3,CASE WHEN $2::text=$4::text AND NOT EXISTS(SELECT 1 FROM users WHERE role='super_admin') THEN 'super_admin' ELSE 'attendee' END)
      RETURNING id,whatsapp`, [name, email, dummyPw, sa]);
  }
  if (!r || !r.length) throw new Error('E_GENERIC');
  return { session: newSession(r[0].id), isNewUser: true };
}
function forgotRequestImpl(p) {
  const email = String(p.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error('BAD_EMAIL');
  const cache = CacheService.getScriptCache(), cnt = parseInt(cache.get('otp_hr') || '0', 10);
  if (cnt >= 40) throw new Error('RATE_LIMIT');            // batas global per jam: melindungi kuota email dari penyalahgunaan
  cache.put('otp_hr', String(cnt + 1), 3600);
  const u = q(`SELECT u.id,u.name,(SELECT r.created_at > now() - interval '60 seconds' FROM password_resets r WHERE r.user_id=u.id) AS recent FROM users u WHERE lower(u.email)=$1`, [email])[0];
  if (u && !u.recent) {
    const otp = ('00000' + Math.floor(Math.random() * 1000000)).slice(-6);
    q(`INSERT INTO password_resets(user_id,otp_hash,expires_at,attempts,created_at) VALUES($1::uuid,$2,now()+interval '10 minutes',0,now())
      ON CONFLICT (user_id) DO UPDATE SET otp_hash=EXCLUDED.otp_hash,expires_at=EXCLUDED.expires_at,attempts=0,created_at=now() RETURNING user_id`, [u.id, sha(email + ':' + otp)]);
    sendMail({ to: email, name: 'AmbilTiketnya', subject: 'Kode OTP reset password: ' + otp,
      htmlBody: '<div style="font-family:Arial,sans-serif;max-width:420px"><p>Halo ' + esc(u.name) + ',</p><p>Kode OTP untuk mengatur ulang password Anda:</p><p style="font-size:30px;font-weight:bold;letter-spacing:6px">' + otp + '</p><p>Berlaku 10 menit. Abaikan email ini jika Anda tidak memintanya.</p></div>' });
  }
  return true;   // jawaban sama baik email terdaftar maupun tidak
}
function forgotResetImpl(p) {
  const email = String(p.email || '').trim().toLowerCase(), otp = String(p.otp || '').replace(/\D/g, '');
  checkNewPw(String(p.password || ''), String(p.confirm || ''));
  const r = q(`SELECT u.id,r.otp_hash,r.attempts,(r.expires_at>now()) AS valid FROM users u JOIN password_resets r ON r.user_id=u.id WHERE lower(u.email)=$1`, [email])[0];
  if (!r || !r.valid || r.attempts >= 5) throw new Error('BAD_OTP');
  if (sha(email + ':' + otp) !== r.otp_hash) { q(`UPDATE password_resets SET attempts=attempts+1 WHERE user_id=$1::uuid RETURNING user_id`, [r.id]); throw new Error('BAD_OTP'); }
  setPassword(r.id, String(p.password));
  return true;
}
function setPassword(uid, pw) {   // ganti password + keluarkan semua sesi + hapus OTP, dalam satu transaksi
  neon([
    { query: wrap(`UPDATE users SET password_hash=$1,failed_attempts=0,locked_until=NULL WHERE id=$2::uuid RETURNING id`), params: [hashPw(pw, Utilities.getUuid(), ITER), uid] },
    { query: wrap(`DELETE FROM sessions WHERE user_id=$1::uuid RETURNING token_hash`), params: [uid] },
    { query: wrap(`DELETE FROM password_resets WHERE user_id=$1::uuid RETURNING user_id`), params: [uid] }
  ]);
}
const AUTH_SQL = `SELECT u.id,u.email,u.name,u.whatsapp,u.age,u.church,u.role,coalesce(u.picture,'') AS picture FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`;
function auth(token) {
  if (!token) throw new Error('AUTH');
  const key = 's' + sha(token).slice(0, 40), cache = CacheService.getScriptCache(), hit = cache.get(key);
  if (hit) return JSON.parse(hit);                       // hemat 1 query database per panggilan (berlaku 2 menit)
  const u = q(AUTH_SQL, [sha(token)])[0];
  if (!u) throw new Error('AUTH');
  cache.put(key, JSON.stringify(u), 120);
  return u;
}
function publicEventsList() {
  return q(`SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled'),0))::int AS remaining,
    false AS has_order, null AS my_order, null AS my_status
    FROM events e WHERE e.is_active ORDER BY e.event_date, e.start_time`);
}
function eventsPublic() { return pubRun(publicEventsList); }
// satu panggilan untuk membuka aplikasi: konfigurasi + pengguna + katalog (cache miss = 1 permintaan HTTP ke Neon berisi 2 query)
function init(token) {
  const out = { cfg: { scanUrl: P.getProperty('SCAN_URL') || '', appUrl: P.getProperty('APP_URL') || '', siteUrl: P.getProperty('SITE_URL') || 'https://www.ambiltiketnya.online', googleClientId: (P.getProperty('GOOGLE_CLIENT_ID') || '866753632616-opg57movh0h0th1av7b927d7fvrg3n6e.apps.googleusercontent.com').trim() } };
  if (!token) {
    try { out.events = publicEventsList(); } catch (e) { out.events = []; }
    return out;
  }
  try {
    const h = sha(token), key = 's' + h.slice(0, 40), cache = CacheService.getScriptCache(), hit = cache.get(key);
    if (hit) { const u = JSON.parse(hit); out.user = Object.assign({}, u, { needProfile: !u.whatsapp }); out.events = userEvents(u); return out; }
    const res = neon([{ query: wrap(AUTH_SQL), params: [h] }, { query: wrap(eventsSql(UID_SESSION)), params: [h] }]);
    const u = rowsOf(res[0])[0];
    if (!u) { out.authError = 'AUTH'; try { out.events = publicEventsList(); } catch (x) {} return out; }
    cache.put(key, JSON.stringify(u), 120);
    out.user = Object.assign({}, u, { needProfile: !u.whatsapp });
    out.events = rowsOf(res[1]);
  } catch (e) { Logger.log(e.stack || e); out.authError = 'E_GENERIC'; }
  return out;
}
// opsional: pasang sebagai trigger tiap 5 menit pada hari acara agar Neon tidak "tidur"
function keepWarm() { q('SELECT 1 AS ok'); }

/* ---------- Dispatcher: min = peran minimum, prof = profil harus lengkap ---------- */
const ACTIONS = {
  me:          { min: 0, fn: u => Object.assign({}, u, { needProfile: !u.whatsapp }) },
  saveProfile: { min: 0, fn: saveProfile },
  logout:      { min: 0, fn: (u, p, tk) => { CacheService.getScriptCache().remove('s' + sha(tk).slice(0, 40)); q(`DELETE FROM sessions WHERE token_hash=$1 RETURNING token_hash`, [sha(tk)]); return true; } },
  events:      { min: 0, prof: 1, fn: userEvents },
  myTickets:   { min: 0, prof: 1, fn: myTickets },
  book:        { min: 0, prof: 1, fn: book },
  ticketPdf:   { min: 0, prof: 1, fn: ticketPdf },
  ticketLink:  { min: 0, prof: 1, fn: ticketLink },
  ticketUpload:{ min: 0, prof: 1, fn: ticketUpload },
  stats:       { min: 1, fn: stats },
  validate:    { min: 1, fn: validate },
  adminEvents: { min: 2, fn: () => q(`SELECT e.*, coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled'),0)::int AS sold FROM events e ORDER BY e.event_date DESC, e.start_time`) },
  orders:      { min: 2, fn: adminOrders },
  users:       { min: 3, fn: () => q(`SELECT id,name,email,whatsapp,age,church,role,coalesce(picture,'') AS picture,created_at FROM users ORDER BY created_at DESC LIMIT 1000`) },
  migrateOauth:{ min: 3, fn: () => migrateOauth() },
  saveEvent:   { min: 3, fn: saveEvent },
  toggleEvent: { min: 3, fn: (u, p) => q(`UPDATE events SET is_active=$2::bool WHERE id=$1::uuid RETURNING id`, [p.id, !!p.active]) && true },
  cancelOrder: { min: 3, fn: (u, p) => { const r = q(`UPDATE orders SET status='cancelled',cancelled_at=now() WHERE id=$1::uuid AND status<>'cancelled' RETURNING id,order_code`, [p.id]); if (!r.length) throw new Error('NOT_FOUND'); trashTicketFiles(r[0].order_code); return true; } },
  confirmPay:  { min: 3, fn: confirmPay },
  resend:      { min: 3, fn: (u, p) => { const o = orderFull(p.id); if (!o || o.status !== 'confirmed' || o.kind === 'invitation') throw new Error('NOT_CONFIRMED'); sendTicketEmail(o); return true; } },
  ordersAll:   { min: 2, fn: ordersAll },
  invitations: { min: 3, fn: () => invitations() },
  invitationCreate: { min: 3, fn: invitationCreate },
  checkinOrder:{ min: 2, fn: checkinOrder },
  legalGet:    { min: 2, fn: () => legalGetAll() },
  legalSave:   { min: 3, fn: legalSave },
  legalPreview:{ min: 2, fn: (u, p) => legalPreview(p) },
  resetPw:     { min: 3, fn: (u, p) => { if (p.id === u.id) throw new Error('SELF'); const temp = rnd(10); setPassword(p.id, temp); return { temp: temp }; } },
  setRole:     { min: 3, fn: (u, p) => {
    if (!(p.role in RANK)) throw new Error('BAD_ROLE'); if (p.id === u.id) throw new Error('SELF');
    q(`UPDATE users SET role=$2 WHERE id=$1::uuid RETURNING id`, [p.id, p.role]); return true; } }
};
function api(token, action, p) {
  try {
    const u = auth(token), h = ACTIONS[action];
    if (!h) throw new Error('NOT_FOUND');
    if (RANK[u.role] < h.min) throw new Error('FORBIDDEN');
    if (h.prof && !u.whatsapp) throw new Error('PROFILE');
    return { ok: true, data: h.fn(u, p || {}, token) };
  } catch (e) {
    Logger.log(e.stack || e);
    return { ok: false, error: /^[A-Z_]+$/.test(e.message) ? e.message : 'E_GENERIC' };
  }
}

/* ---------- User ---------- */
function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1); else if (d.startsWith('8')) d = '62' + d;
  return /^628\d{7,11}$/.test(d) ? d : null;
}
function saveProfile(u, p) {
  const wa = normPhone(p.whatsapp), age = parseInt(p.age, 10), church = String(p.church || '').trim();
  if (!wa) throw new Error('BAD_PHONE');
  if (!(age >= 1 && age <= 120)) throw new Error('BAD_AGE');
  if (church.length < 2) throw new Error('BAD_CHURCH');
  q(`UPDATE users SET whatsapp=$1,age=$2::int,church=$3 WHERE id=$4::uuid RETURNING id`, [wa, age, church, u.id]);
  return { whatsapp: wa };
}
const UID_SESSION = "(SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now())";
function eventsSql(uid) {   // uid = ekspresi SQL untuk id pengguna
  const mine = `FROM orders o WHERE o.event_id=e.id AND o.user_id=${uid} AND o.status<>'cancelled' AND o.kind='order'`;
  return `SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled'),0))::int AS remaining,
    EXISTS(SELECT 1 ${mine}) AS has_order,
    (SELECT o.id ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_order,
    (SELECT o.status ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_status
    FROM events e WHERE e.is_active ORDER BY e.event_date, e.start_time`;
}
function userEvents(u) { return q(eventsSql('$1::uuid'), [u.id]); }
function myTickets(u) {
  return q(`SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,
    e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions
    FROM orders o JOIN events e ON e.id=o.event_id WHERE o.user_id=$1::uuid AND o.kind='order' ORDER BY o.created_at DESC`, [u.id]);
}
const rnd = n => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };

function book(u, p) {
  const qty = parseInt(p.qty, 10) || 1;
  const ev = q(`SELECT name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
  const ins = `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status)
    SELECT $1,$2,$3::uuid,e.id,$4::int,e.price*$4::int, CASE WHEN e.is_paid THEN 'pending_payment' ELSE 'confirmed' END
    FROM events e WHERE e.id=$5::uuid AND e.is_active AND $4::int>=1 AND $4::int<=e.max_per_order
     AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled') + $4::int <= e.quota
     AND (NOT e.one_order_per_account OR NOT EXISTS(SELECT 1 FROM orders WHERE event_id=e.id AND user_id=$3::uuid AND status<>'cancelled' AND kind='order'))
    RETURNING id,status,ticket_code`;
  // lock per acara + insert dalam satu transaksi → kuota tidak bisa oversell
  const res = neon([
    { query: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [p.eventId] },
    { query: wrap(ins), params: [rnd(8), 'TKT-' + prefix + '-' + rnd(6), u.id, qty, p.eventId] }
  ]);
  const row = rowsOf(res[1])[0];
  if (!row) {
    const d = q(`SELECT e.is_active,e.max_per_order,
      (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled'),0))::int AS rem,
      (e.one_order_per_account AND EXISTS(SELECT 1 FROM orders o WHERE o.event_id=e.id AND o.user_id=$2::uuid AND o.status<>'cancelled' AND o.kind='order')) AS dup
      FROM events e WHERE e.id=$1::uuid`, [p.eventId, u.id])[0];
    throw new Error(!d.is_active ? 'INACTIVE' : d.dup ? 'ALREADY' : qty > d.max_per_order ? 'MAX' : 'SOLDOUT');
  }
  const o = orderFull(row.id);
  let emailed = false;
  if (o.status === 'confirmed') { try { sendTicketEmail(o); emailed = true; } catch (e) { Logger.log(e); } }
  return { id: row.id, status: row.status, ticket_code: row.ticket_code, emailed: emailed };
}

/* ---------- Admin ---------- */
function stats() {
  return q(`SELECT e.id,e.name,e.quota,e.is_active,
    coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed'),0)::int AS booked,
    coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed'),0)::int AS checked,
    coalesce(sum(o.qty) FILTER (WHERE o.status='pending_payment'),0)::int AS pending,
    coalesce(sum(o.total) FILTER (WHERE o.status='confirmed'),0)::int AS revenue
    FROM events e LEFT JOIN orders o ON o.event_id=e.id GROUP BY e.id ORDER BY e.event_date`);
}
const ORDERS_SQL = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,o.kind,
    CASE WHEN o.kind='invitation' THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind='invitation' THEN 'Undangan' ELSE u.email END AS email,
    CASE WHEN o.kind='invitation' THEN '' ELSE u.whatsapp END AS whatsapp,
    CASE WHEN o.kind='invitation' THEN NULL ELSE u.age END AS age,
    CASE WHEN o.kind='invitation' THEN o.guest_org ELSE u.church END AS church,
    e.id AS event_id,e.name AS event_name
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    WHERE ($1::uuid IS NULL OR o.event_id=$1::uuid) AND ($2::text IS NULL OR o.status=$2::text)
    ORDER BY o.created_at DESC`;
function adminOrders(u, p) { return q(ORDERS_SQL + ' LIMIT 1000', [p.eventId || null, p.status || null]); }      // dipakai tampilan lama
function ordersAll(u, p) {                       // tampilan baru: semua data (maks 5000), pagination dilakukan di klien
  const rows = q(ORDERS_SQL + ' LIMIT 5001', [p.eventId || null, p.status || null]);
  const trunc = rows.length > 5000; if (trunc) rows.length = 5000;
  return { rows: rows, truncated: trunc };
}
function saveEvent(u, p) {
  const cols = ['name', 'category', 'banner_url', 'description', 'announcement', 'event_date', 'start_time', 'end_time', 'location', 'quota', 'is_paid', 'price', 'max_per_order', 'one_order_per_account', 'is_active', 'payment_instructions', 'terms'];
  const types = ['text', 'text', 'text', 'text', 'text', 'date', 'time', 'time', 'text', 'int', 'bool', 'int', 'int', 'bool', 'bool', 'text', 'text'];
  const paid = !!p.is_paid, quota = parseInt(p.quota, 10), maxp = parseInt(p.max_per_order, 10);
  if (!String(p.name || '').trim() || !String(p.location || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.event_date || '') || !/^\d{2}:\d{2}/.test(p.start_time || '')) throw new Error('BAD_EVENT');
  if (!(quota > 0) || !(maxp > 0)) throw new Error('BAD_EVENT');
  const v = [p.name.trim(), p.category || '', p.banner_url || '', p.description || '', p.announcement || '', p.event_date, p.start_time, p.end_time || null, p.location.trim(),
    quota, paid, paid ? Math.max(0, parseInt(p.price, 10) || 0) : 0, maxp, !!p.one_order_per_account, p.is_active !== false, p.payment_instructions || '', String(p.terms || '').slice(0, 8000)];
  const ph = cols.map((c, i) => `$${i + 1}::${types[i]}`).join(',');
  const upd = cols.map(c => `${c}=EXCLUDED.${c}`).join(',');
  return q(`INSERT INTO events(${cols.join(',')},id) VALUES(${ph},$${cols.length + 1}::uuid) ON CONFLICT(id) DO UPDATE SET ${upd} RETURNING id`, v.concat([p.id || Utilities.getUuid()]))[0];
}
function confirmPay(u, p) {
  if (!q(`UPDATE orders SET status='confirmed' WHERE id=$1::uuid AND status='pending_payment' RETURNING id`, [p.id]).length) throw new Error('NOT_FOUND');
  try { sendTicketEmail(orderFull(p.id)); } catch (e) { Logger.log(e); }
  return true;
}
function validate(u, p) {
  const code = String(p.code || '').trim().toUpperCase().replace(/\s/g, '');
  const o = q(`SELECT o.id,o.qty,o.status,o.checked_in,o.checked_in_at,o.kind,
    CASE WHEN o.kind='invitation' THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind='invitation' THEN o.guest_org ELSE u.church END AS church,
    CASE WHEN o.kind='invitation' THEN NULL ELSE u.age END AS age,
    CASE WHEN o.kind='invitation' THEN '' ELSE u.whatsapp END AS whatsapp,e.name AS event_name
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code])[0];
  if (!o) return { result: 'NOT_FOUND', code: code };
  const base = { code: code, kind: o.kind, name: o.name, church: o.church, age: o.age, whatsapp: o.whatsapp, event: o.event_name, qty: o.qty, at: o.checked_in_at };
  if (o.status === 'cancelled') return Object.assign(base, { result: 'CANCELLED' });
  if (o.status === 'pending_payment') return Object.assign(base, { result: 'UNPAID' });
  if (o.checked_in >= o.qty) return Object.assign(base, { result: 'USED', checked: o.checked_in });
  const r = q(`UPDATE orders SET checked_in=qty,checked_in_at=now(),checked_in_by=$2::uuid WHERE id=$1::uuid AND checked_in<qty RETURNING qty`, [o.id, u.id]);
  if (!r.length) return Object.assign(base, { result: 'USED', checked: o.qty });
  return Object.assign(base, { result: 'VALID', entered: o.qty - o.checked_in, checked: o.qty, at: new Date().toISOString() });
}

/* ---------- Pengiriman email: Gmail (MailApp) dulu, Brevo jika kuota harian habis ---------- */
function gmailQuotaLeft() { try { return MailApp.getRemainingDailyQuota(); } catch (e) { return 1; } }
function sendMail(m) {                           // m: {to, subject, htmlBody, name, attachments[]}
  if (gmailQuotaLeft() > 0) {
    try {
      const o = { to: m.to, subject: m.subject, htmlBody: m.htmlBody, name: m.name || 'AmbilTiketnya' };
      if (m.attachments && m.attachments.length) o.attachments = m.attachments;
      MailApp.sendEmail(o);
      return 'gmail';
    } catch (e) {
      if (!/quota|too many times|limit/i.test(String(e && e.message))) throw e;   // error lain (mis. alamat salah) tidak dialihkan
      Logger.log('Kuota Gmail habis, beralih ke Brevo: ' + e.message);
    }
  }
  return brevoSend(m);
}
function brevoRaw(m) {                           // panggilan mentah ke Brevo -> {code, text}
  const key = P.getProperty('BREVO_API_KEY'), from = P.getProperty('BREVO_SENDER_EMAIL');
  const body = { sender: { name: P.getProperty('BREVO_SENDER_NAME') || m.name || 'AmbilTiketnya', email: from }, to: [{ email: m.to }], subject: m.subject, htmlContent: m.htmlBody };
  if (m.attachments && m.attachments.length) body.attachment = m.attachments.map(b => ({ name: b.getName(), content: Utilities.base64Encode(b.getBytes()) }));
  const r = UrlFetchApp.fetch('https://api.brevo.com/v3/smtp/email', { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'api-key': key, accept: 'application/json' }, payload: JSON.stringify(body) });
  return { code: r.getResponseCode(), text: String(r.getContentText()) };
}
function brevoSend(m) {
  if (!P.getProperty('BREVO_API_KEY') || !P.getProperty('BREVO_SENDER_EMAIL')) throw new Error('EMAIL_QUOTA');   // kuota habis dan Brevo belum diatur
  const r = brevoRaw(m);
  if (r.code < 200 || r.code >= 300) { Logger.log('Brevo ' + r.code + ': ' + r.text.slice(0, 300) + ' | ' + brevoHint(r.code, r.text)); throw new Error('EMAIL_FAIL'); }
  return 'brevo';
}
function brevoHint(code, text) {                 // penjelasan singkat untuk galat Brevo yang umum
  if (/unrecognised IP|authorised_ips/i.test(text)) return 'Brevo memblokir alamat IP server Google. Buka Brevo > Security > Authorised IPs (https://app.brevo.com/security/authorised_ips) lalu NONAKTIFKAN pemblokiran. Alamat IP Apps Script berubah-ubah sehingga tidak bisa didaftarkan satu per satu.';
  if (code === 401) return 'API key salah, dicabut, atau tidak punya izin. Buat API key baru di Brevo dan perbarui BREVO_API_KEY.';
  if (/sender/i.test(text)) return 'Alamat pengirim belum diverifikasi di Brevo (Senders, Domains & Dedicated IPs). Pastikan BREVO_SENDER_EMAIL sama persis dengan yang terverifikasi.';
  if (code === 402 || code === 403) return 'Akun Brevo belum aktif atau kuota/izin tidak mencukupi.';
  return '';
}
function brevoMessage(text) { try { return JSON.parse(text).message || text; } catch (e) { return String(text).slice(0, 200); } }
// Uji manual dari editor: kirim email percobaan lewat Brevo ke SUPERADMIN_EMAIL (tanpa menunggu kuota habis)
function ujiBrevo() {
  const to = P.getProperty('SUPERADMIN_EMAIL');
  if (!to) { Logger.log('GAGAL: SUPERADMIN_EMAIL belum diisi'); return; }
  if (!P.getProperty('BREVO_API_KEY') || !P.getProperty('BREVO_SENDER_EMAIL')) { Logger.log('GAGAL: isi BREVO_API_KEY dan BREVO_SENDER_EMAIL di Script Properties'); return; }
  const r = brevoRaw({ to: to, subject: 'Uji Brevo - ambiltiketnya.online', htmlBody: '<p>Jika email ini diterima, cadangan Brevo berfungsi.</p>' });
  if (r.code >= 200 && r.code < 300) Logger.log('OK - email percobaan terkirim via Brevo ke ' + to + ' (periksa kotak masuk/spam)');
  else Logger.log('GAGAL (HTTP ' + r.code + '): ' + brevoMessage(r.text) + '\nSARAN: ' + (brevoHint(r.code, r.text) || 'lihat pesan di atas'));
}

/* ---------- E-ticket PDF + email ---------- */
function orderFull(id) {
  return q(`SELECT o.id,o.user_id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.created_at,o.kind,o.guest_name,o.guest_org,
    CASE WHEN o.kind='invitation' THEN o.guest_name ELSE u.name END AS uname,u.email,CASE WHEN o.kind='invitation' THEN o.guest_org ELSE u.church END AS church,
    e.name AS ename,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location,e.announcement
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.id=$1::uuid`, [id])[0];
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function idDate(s) {
  const D = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'], M = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const [y, m, d] = s.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  return D[dt.getUTCDay()] + ', ' + d + ' ' + M[m - 1] + ' ' + y;
}
function invitationPdfHtml(o, img) {             // desain undangan: navy + emas
  const G = '#d4af37', N = '#0b1026';
  const f = (l, v) => `<div style="font-size:9px;color:#8a7a3a;letter-spacing:1px;text-transform:uppercase;margin-top:12px">${l}</div><div style="font-size:15px;font-weight:bold">${esc(v)}</div>`;
  return `<html><body style="margin:0;font-family:Arial,sans-serif;color:${N}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${N};border-bottom:6px solid ${G}"><tr><td style="padding:26px 36px">
  <div style="font-size:12px;letter-spacing:7px;color:${G};font-weight:bold">UNDANGAN</div>
  <div style="font-size:26px;font-weight:bold;color:#fff;margin-top:8px">${esc(o.ename)}</div>
  <div style="font-size:9px;letter-spacing:3px;color:#c9b873;margin-top:8px">E-TIKET UNDANGAN - AMBILTIKETNYA</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:22px 36px 0"><div style="font-size:10px;color:#8a7a3a;letter-spacing:3px">KEPADA YTH.</div>
  <div style="font-size:24px;font-weight:bold;margin-top:4px">${esc(o.uname)}</div><div style="font-size:14px;color:#555;margin-top:2px">${esc(o.church)}</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>
  <td width="210" valign="top" style="padding:0 20px 0 36px"><div style="border:2px solid ${G};padding:8px;width:170px"><img src="${img}" width="170" height="170"/></div>
   <div style="font-family:monospace;font-size:13px;font-weight:bold;margin-top:10px">${o.ticket_code}</div><div style="font-size:9px;color:#778">Pindai di gerbang masuk</div></td>
  <td valign="top" style="padding-right:36px">${f('Hari & Tanggal', idDate(o.edate))}${f('Waktu', o.stime + ' WIB')}${f('Lokasi', o.location)}${f('Jumlah Tiket', o.qty + ' orang')}${f('Nomor Undangan', o.order_code)}</td></tr></table>
  <div style="margin:26px 36px 0;padding:12px 16px;border:1px solid ${G};border-radius:6px;font-size:11px;color:#333">${esc(o.announcement || 'Tunjukkan QR ini di gerbang masuk. Satu QR berlaku untuk seluruh tamu pada undangan ini.')}</div>
  </body></html>`;
}
function ticketBlob(o) {
  const png = UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=' + encodeURIComponent(o.ticket_code)).getBlob();
  const img = 'data:image/png;base64,' + Utilities.base64Encode(png.getBytes());
  const f = (l, v) => `<div style="font-size:9px;color:#778;letter-spacing:1px;text-transform:uppercase;margin-top:13px">${l}</div><div style="font-size:15px;font-weight:bold">${esc(v)}</div>`;
  const html = o.kind === 'invitation' ? invitationPdfHtml(o, img) : `<html><body style="margin:0;font-family:Arial,sans-serif;color:#0f1222">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1222"><tr><td style="padding:28px 36px">
  <div style="font-size:10px;letter-spacing:3px;color:#9a8cff">E-TIKET RESMI · AMBILTIKETNYA</div>
  <div style="font-size:26px;font-weight:bold;color:#fff;margin-top:8px">${esc(o.ename)}</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:26px"><tr>
  <td width="210" valign="top" style="padding:0 20px 0 36px"><img src="${img}" width="170" height="170"/>
   <div style="font-family:monospace;font-size:13px;font-weight:bold;margin-top:10px">${o.ticket_code}</div>
   <div style="font-size:9px;color:#778">Pindai di gerbang masuk</div></td>
  <td valign="top" style="padding-right:36px">${f('Hari & Tanggal', idDate(o.edate))}${f('Waktu', o.stime + ' WIB')}${f('Lokasi', o.location)}
   ${f('Nama', o.uname)}${f('Gereja / Komunitas', o.church || '-')}${f('Jumlah Tiket', o.qty + ' orang')}${f('Nomor Pesanan', o.order_code)}</td></tr></table>
  <div style="margin:30px 36px 0;padding:12px 16px;background:#f1f0ff;border-radius:6px;font-size:11px;color:#333">${esc(o.announcement || 'Satu QR berlaku untuk seluruh rombongan. Tunjukkan di gerbang masuk.')}</div>
  </body></html>`;
  return HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf').setName('E-Tiket-' + o.ticket_code + '.pdf');
}
function sendTicketEmail(o) {
  const row = (l, v) => `<tr><td style="padding:6px 0;color:#667">${l}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${esc(v)}</td></tr>`;
  sendMail({
    to: o.email, name: 'AmbilTiketnya', attachments: [ticketBlob(o)],
    subject: `[KONFIRMASI TIKET] ${o.ename} - Kode: ${o.ticket_code}`,
    htmlBody: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto"><div style="background:#0f1222;color:#fff;padding:22px;border-radius:10px 10px 0 0">
      <div style="font-size:11px;letter-spacing:3px;color:#9a8cff">AMBILTIKETNYA</div><div style="font-size:20px;font-weight:bold;margin-top:6px">${esc(o.ename)}</div></div>
      <div style="border:1px solid #e4e6f2;border-top:0;padding:22px;border-radius:0 0 10px 10px"><p>Halo <b>${esc(o.uname)}</b>, pemesanan tiket Anda berhasil. E-tiket (PDF) terlampir pada email ini.</p>
      <table width="100%" style="border-collapse:collapse;font-size:14px">${row('Nomor Pesanan', o.order_code)}${row('Kode Tiket', o.ticket_code)}${row('Jumlah', o.qty + ' tiket')}${row('Waktu', idDate(o.edate) + ' · ' + o.stime + ' WIB')}${row('Lokasi', o.location)}</table>
      ${o.announcement ? `<p style="background:#f1f0ff;padding:12px;border-radius:6px;font-size:13px">${esc(o.announcement)}</p>` : ''}</div></div>`
  });
}
/* ---------- Undangan (super admin) dan cek in manual oleh admin ---------- */
const INV_SQL = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,o.kind,o.guest_name,o.guest_org,
    e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions
    FROM orders o JOIN events e ON e.id=o.event_id`;
function invitations() { return q(INV_SQL + " WHERE o.kind='invitation' ORDER BY o.created_at DESC LIMIT 500"); }
function invitationCreate(u, p) {                // undangan memakai kuota yang sama dengan pesanan biasa
  const name = String(p.name || '').trim().slice(0, 120), org = String(p.org || '').trim().slice(0, 120), qty = parseInt(p.qty, 10) || 1;
  if (name.length < 2) throw new Error('BAD_NAME');
  if (org.length < 2) throw new Error('BAD_ORG');
  if (!(qty >= 1 && qty <= 50)) throw new Error('BAD_QTY');
  const ev = q(`SELECT name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
  const ins = `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org)
    SELECT $1,$2,$3::uuid,e.id,$4::int,0,'confirmed','invitation',$6::text,$7::text FROM events e WHERE e.id=$5::uuid
     AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled') + $4::int <= e.quota
    RETURNING id`;
  const res = neon([
    { query: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [p.eventId] },
    { query: wrap(ins), params: [rnd(8), 'TKT-' + prefix + '-' + rnd(6), u.id, qty, p.eventId, name, org] }
  ]);
  const row = rowsOf(res[1])[0];
  if (!row) throw new Error('SOLDOUT');
  return q(INV_SQL + ' WHERE o.id=$1::uuid', [row.id])[0];
}
function verifySuperPassword(u, pw) {            // password SUPER ADMIN mana pun; 5 kali salah -> terkunci 10 menit
  const cache = CacheService.getScriptCache(), key = 'ci:' + u.id, n = parseInt(cache.get(key) || '0', 10);
  if (n >= 5) throw new Error('LOCKED');
  const rows = q(`SELECT password_hash FROM users WHERE role='super_admin'`);
  let ok = false;
  for (let i = 0; i < rows.length && !ok; i++) ok = checkPw(String(pw || ''), rows[i].password_hash);
  if (!ok) { cache.put(key, String(n + 1), 600); throw new Error('BAD_PASSWORD'); }
  cache.remove(key);
}
function checkinOrder(u, p) {                    // cek in manual = sama seperti scan QR, tetapi wajib password super admin
  verifySuperPassword(u, p.password);
  const o = q(`SELECT ticket_code FROM orders WHERE id=$1::uuid`, [p.id])[0];
  if (!o) throw new Error('NOT_FOUND');
  return validate(u, { code: o.ticket_code });
}

/* ---------- Gambar e-tiket di Google Drive (tautan untuk pesan WhatsApp) ---------- */
function ticketFolder() {
  const id = P.getProperty('TICKET_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder terhapus: buat ulang */ } }
  const it = DriveApp.getFoldersByName('E-Tiket ambiltiketnya'), f = it.hasNext() ? it.next() : DriveApp.createFolder('E-Tiket ambiltiketnya');
  P.setProperty('TICKET_FOLDER_ID', f.getId());
  return f;
}
// nama file memuat sidik jari data acara: jika admin mengubah tanggal/jam/lokasi, gambar baru dibuat otomatis
function ticketFileName(o) { return 'E-Tiket_' + o.order_code + '_' + sha(o.ename + '|' + o.edate + '|' + o.stime + '|' + o.location).slice(0, 6) + '.jpg'; }
const driveUrl = f => 'https://drive.google.com/file/d/' + f.getId() + '/view?usp=sharing';
function ownOrder(u, id) {                       // pemilik pesanan; undangan juga boleh diakses super admin mana pun
  const o = orderFull(id);
  if (!o || o.status !== 'confirmed' || (o.user_id !== u.id && !(o.kind === 'invitation' && RANK[u.role] >= 3))) throw new Error('NOT_FOUND');
  return o;
}
function ticketLink(u, p) {                       // sudah ada? kembalikan tautan; belum? minta klien mengunggah gambar
  const o = ownOrder(u, p.id), it = ticketFolder().getFilesByName(ticketFileName(o));
  return it.hasNext() ? { url: driveUrl(it.next()) } : { need: true };
}
function ticketUpload(u, p) {
  const o = ownOrder(u, p.id), b64 = String(p.b64 || '');
  if (b64.length < 1000 || b64.length > 700000) throw new Error('BAD_IMAGE');
  const bytes = Utilities.base64Decode(b64);
  if (!(bytes[0] === -1 && bytes[1] === -40 && bytes[2] === -1)) throw new Error('BAD_IMAGE');   // tanda tangan JPEG FF D8 FF
  const folder = ticketFolder(), name = ticketFileName(o), it = folder.getFilesByName(name);
  if (it.hasNext()) return { url: driveUrl(it.next()) };                                      // satu gambar per pesanan
  const f = folder.createFile(Utilities.newBlob(bytes, 'image/jpeg', name));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: driveUrl(f) };
}
function trashTicketFiles(orderCode) {            // pesanan dibatalkan -> tautan gambar tidak berlaku lagi
  try { const it = ticketFolder().searchFiles("title contains 'E-Tiket_" + String(orderCode).replace(/[^A-Za-z0-9]/g, '') + "_'"); while (it.hasNext()) it.next().setTrashed(true); }
  catch (e) { Logger.log(e); }
}
function ticketPdf(u, p) {
  const o = orderFull(p.id);
  if (!o || (o.user_id !== u.id && RANK[u.role] < 2)) throw new Error('NOT_FOUND');
  if (o.status !== 'confirmed') throw new Error('NOT_CONFIRMED');
  const b = ticketBlob(o);
  return { name: b.getName(), b64: Utilities.base64Encode(b.getBytes()) };
}
/* ---------- Migrasi Database untuk Google OAuth 2.0 ---------- */
function migrateOauth() {
  const statements = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS picture text",
    "CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uq ON users (google_sub) WHERE google_sub IS NOT NULL",
    "ALTER TABLE users ALTER COLUMN whatsapp DROP NOT NULL",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_whatsapp_check",
    "ALTER TABLE users ADD CONSTRAINT users_whatsapp_check CHECK (whatsapp IS NULL OR whatsapp ~ '^628[0-9]{7,11}$')",
    "ALTER TABLE users ALTER COLUMN age DROP NOT NULL",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS users_age_check",
    "ALTER TABLE users ADD CONSTRAINT users_age_check CHECK (age IS NULL OR (age BETWEEN 1 AND 120))",
    "ALTER TABLE users ALTER COLUMN church DROP NOT NULL",
    "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL"
  ];
  const results = [];
  statements.forEach(sql => {
    try {
      neon([{ query: sql }]);
      results.push({ sql: sql, ok: true });
    } catch (e) {
      Logger.log('migrateOauth: ' + sql + ' -> ' + e);
      results.push({ sql: sql, ok: false, error: String(e) });
    }
  });
  return results;
}
