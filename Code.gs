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
 *   RESEND_API_KEY      (opsional) API key Resend - dipakai otomatis bila kuota Gmail & Brevo habis
 *   RESEND_SENDER_EMAIL (opsional) email pengirim terverifikasi di Resend (default tiket@ambiltiketnya.online)
 *   RESEND_SENDER_NAME  (opsional) nama pengirim, default AmbilTiketnya
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
const API_FNS = { init: init, register: register, loginPw: loginPw, loginGoogle: loginGoogle, forgotRequest: forgotRequest, forgotReset: forgotReset, legalPublic: legalPublic, ticketPublic: ticketPublic, eventsPublic: eventsPublic, feedbackPublic: feedbackPublic, surveyInfo: surveyInfo, surveyStagePoll: surveyStagePoll, api: api, migrateOauth: migrateOauth, gateLogin: gateLogin, ticketFacilities: ticketFacilities, sessionSelfCheckin: sessionSelfCheckin, checkpointPublicInfo: checkpointPublicInfo, sessionStageLiveCount: sessionStageLiveCount, certificateVerify: certificateVerify, organizerPublic: organizerPublic, guestbookWall: guestbookWall, digitalInvitationInfo: digitalInvitationInfo, digitalInvitationRsvp: digitalInvitationRsvp };
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
    try { o = q(`SELECT o.ticket_code,o.qty,o.status,o.checked_in,o.kind,CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS guest_name,CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS guest_org,e.name,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location
      FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN users u ON u.id=o.user_id WHERE o.ticket_code=$1`, [code])[0]; } catch (err) { Logger.log(err); }
  }
  const st = !o ? 'NOT_FOUND' : o.status === 'cancelled' ? 'CANCELLED' : o.status === 'pending_payment' ? 'UNPAID' : o.checked_in >= o.qty ? 'USED' : 'OK';
  return { code: code, o: o, st: st };
}
// untuk halaman GitHub: kembalikan hanya info acara + status + kode (tanpa nama/email/telepon pemilik)
function ticketPublic(p) { return pubRun(ticketPublicImpl, p); }
function ticketPublicImpl(p) {
  const ti = ticketInfo(p && p.code), o = ti.o;
  return o ? { found: true, kind: o.kind, status: ti.st, code: o.ticket_code, name: o.name, edate: o.edate, stime: o.stime, location: o.location, qty: o.qty, guest_name: o.guest_name, guest_org: o.guest_org } : { found: false };
}
function ticketPage(raw) {
  const ti = ticketInfo(raw), o = ti.o, st = ti.st;
  const msg = { NOT_FOUND: 'Tiket tidak ditemukan.', CANCELLED: 'Pesanan ini sudah dibatalkan.', UNPAID: 'Menunggu konfirmasi pembayaran.', USED: 'Tiket ini sudah digunakan untuk check-in.' }[st];
  const f = (l, v) => '<div class="r"><small>' + l + '</small><b>' + esc(v) + '</b></div>';
  const body = !o ? '<div class="m">' + msg + '</div>'
    : (st === 'OK' || st === 'USED' ? '<div class="q">' + (o && o.guest_name ? '<div style="margin:4px auto 16px;padding:12px;background:linear-gradient(180deg,rgba(212,175,55,.12),rgba(212,175,55,.03));border:1.5px solid rgba(212,175,55,.3);border-radius:12px;text-align:center"><div style="font-size:11px;color:#b8921f;font-weight:bold;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">' + (o.kind === 'invitation' ? 'Kepada Yth.' : 'Pemegang Tiket') + '</div><div style="font-size:18px;font-weight:bold;color:#0b1026">' + esc(o.guest_name) + '</div>' + (o.guest_org ? '<div style="font-size:13px;color:#555;margin-top:4px">' + esc(o.guest_org) + '</div>' : '') + '</div>' : '') + '<img alt="QR" width="230" height="230" src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=' + encodeURIComponent(o.ticket_code) + '"><div class="k">' + esc(o.ticket_code) + '</div><div class="s">Pindai di gerbang masuk</div></div>' : '')
      + (msg ? '<div class="m">' + msg + '</div>' : '')
      + '<div class="d">' + f('Hari & Tanggal', idDate(o.edate)) + f('Waktu', o.stime + ' WIB') + f('Lokasi', o.location) + f('Jumlah Tiket', o.qty + ' orang') + '</div>';
  const html = '<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + ':root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f3f4fb;font-family:Arial,sans-serif;color:#0f1222}'
    + '.c{width:min(380px,92vw);background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.15);margin:16px 0}.h{background:#0f1222;color:#fff;padding:20px}.h small{letter-spacing:3px;color:#9a8cff;font-size:10px}.h h1{margin:6px 0 0;font-size:20px}'
    + '.q{text-align:center;padding:18px 16px 6px}.q img{width:230px;height:230px}.k{font:700 18px monospace;margin-top:10px}.s{color:#778;font-size:12px;margin-top:2px}.m{margin:12px 18px;padding:12px;border-radius:10px;background:#fff4e5;color:#8a5200;font-size:14px;text-align:center}'
    + '.d{padding:10px 20px 20px}.r{margin-top:12px}.r small{display:block;color:#778;font-size:10px;letter-spacing:1px;text-transform:uppercase}.r b{font-size:15px}'
    + '@media(prefers-color-scheme:dark){body{background:#090c16}.c{background:#111627;color:#eef0fa}.q{background:#fff;margin:14px 20px 0;border-radius:14px;padding:14px}.q .k,.q .s{color:#0f1222}.s{color:#667!important}}'
    + '</style></head><body><div class="c"><div class="h">' + (o && o.kind === 'invitation' ? '<div style="color:#d4af37;letter-spacing:6px;font-size:18px;font-weight:900;text-transform:uppercase;margin-bottom:6px">UNDANGAN</div>' : '<small style="letter-spacing:3px;font-size:11px;font-weight:700">E-TIKET RESMI</small>') + '<h1>' + esc(o ? o.name : 'E-Tiket') + '</h1></div>' + body + '</div></body></html>';
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
  const rk = P.getProperty('RESEND_API_KEY'), rf = P.getProperty('RESEND_SENDER_EMAIL');
  if (!rk) ok('Resend belum diatur (opsional: dipakai saat kuota Gmail & Brevo habis)');
  else {
    try {
      const r = UrlFetchApp.fetch('https://api.resend.com/api-keys', { muteHttpExceptions: true, headers: { 'Authorization': 'Bearer ' + rk } });
      const txt = r.getContentText();
      if (r.getResponseCode() === 200 || /restricted_api_key/i.test(txt)) {
        ok('Resend terhubung (API key aktif & siap kirim email, pengirim: ' + (rf || 'tiket@ambiltiketnya.online') + ') - jalankan ujiResendTiket untuk mencoba');
      } else {
        bad('Resend HTTP ' + r.getResponseCode() + ': ' + txt.slice(0, 200));
      }
    } catch (e) { bad('Resend: ' + e.message); }
  }
  const mk = P.getProperty('MAILERSEND_API_KEY'), mf = P.getProperty('MAILERSEND_SENDER_EMAIL');
  if (!mk) ok('MailerSend belum diatur (opsional: cadangan tambahan 3.000 email/bulan)');
  else {
    try {
      const r = UrlFetchApp.fetch('https://api.mailersend.com/v1/domains', { muteHttpExceptions: true, headers: { 'Authorization': 'Bearer ' + mk } });
      const txt = r.getContentText();
      if (r.getResponseCode() === 200 || r.getResponseCode() === 202) {
        ok('MailerSend terhubung (pengirim: ' + (mf || 'tiket@ambiltiketnya.online') + ') - jalankan ujiMailersendTiket untuk mencoba');
      } else {
        ok('MailerSend API key terpasang (HTTP ' + r.getResponseCode() + ') - jalankan ujiMailersendTiket untuk mencoba');
      }
    } catch (e) { bad('MailerSend: ' + e.message); }
  }
  try { if (!q("SELECT 1 FROM information_schema.columns WHERE table_name='orders' AND column_name='kind'").length) bad('Kolom orders.kind belum ada -> jalankan migrate-invitations.sql di Neon'); else ok('Kolom orders.kind ada (fitur undangan)'); } catch (e) { bad('Cek kolom kind: ' + e.message); }
  try { if (!q("SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='terms'").length) bad('Kolom events.terms belum ada -> jalankan migrate-terms.sql di Neon'); else ok('Kolom events.terms ada'); } catch (e) { bad('Cek kolom terms: ' + e.message); }
  try { if (!q("SELECT 1 FROM information_schema.columns WHERE table_name='events' AND column_name='walkin_quota'").length) bad('Kolom events.walkin_quota belum ada -> jalankan migrate-walkin.sql di Neon'); else ok('Kolom events.walkin_quota ada (fitur walk-in terpisah)'); } catch (e) { bad('Cek kolom walkin_quota: ' + e.message); }
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
  return q(`SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,coalesce(e.walkin_quota,0)::int AS walkin_quota,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining,
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
  saveProfile: { min: 0, fn: (u, p, tk) => {
    const res = saveProfile(u, p);
    try { CacheService.getScriptCache().remove('s' + sha(tk).slice(0, 40)); } catch (e) {}
    const updated = q(AUTH_SQL, [sha(tk)])[0];
    if (updated) {
      try { CacheService.getScriptCache().put('s' + sha(tk).slice(0, 40), JSON.stringify(updated), 120); } catch (e) {}
      return Object.assign({}, updated, { needProfile: !updated.whatsapp });
    }
    return Object.assign({}, u, res, { needProfile: false });
  } },
  logout:      { min: 0, fn: (u, p, tk) => { CacheService.getScriptCache().remove('s' + sha(tk).slice(0, 40)); q(`DELETE FROM sessions WHERE token_hash=$1 RETURNING token_hash`, [sha(tk)]); return true; } },
  events:      { min: 0, prof: 1, fn: userEvents },
  myTickets:   { min: 0, prof: 1, fn: myTickets },
  book:        { min: 0, prof: 1, fn: book },
  ticketPdf:   { min: 0, prof: 1, fn: ticketPdf },
  ticketLink:  { min: 0, prof: 1, fn: ticketLink },
  ticketUpload:{ min: 0, prof: 1, fn: ticketUpload },
  stats:       { min: 1, fn: stats },
  validate:    { min: 1, fn: validate },
  offlineManifest:   { min: 1, fn: offlineManifest },
  syncOfflineCheckins:{ min: 1, fn: syncOfflineCheckins },
  gateLink:          { min: 2, fn: gateLink },
  adminEvents: { min: 1, fn: () => {
    ensureWalkinSchema();
    return q(`SELECT e.*,
      coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0)::int AS sold,
      coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0)::int AS walkin_sold,
      (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining
    FROM events e ORDER BY e.event_date DESC, e.start_time`);
  } },
  walkinCreate:{ min: 1, fn: walkinCreate },
  orders:      { min: 2, fn: adminOrders },
  users:       { min: 3, fn: () => q(`SELECT u.id,u.name,u.email,u.whatsapp,u.age,u.church,u.role,coalesce(u.picture,'') AS picture,u.created_at, u.organizer_id, coalesce(org.name, '-') AS organizer_name FROM users u LEFT JOIN organizers org ON org.id=u.organizer_id ORDER BY u.created_at DESC LIMIT 5000`) },
  organizersList: { min: 2, fn: organizersList },
  organizerSave:  { min: 2, fn: organizerSave },
  userAssignOrganizer: { min: 3, fn: userAssignOrganizer },
  assignTable:         { min: 2, fn: assignTable },
  migrateOauth:{ min: 3, fn: () => migrateOauth() },
  saveEvent:   { min: 3, fn: saveEvent },
  toggleEvent: { min: 3, fn: (u, p) => q(`UPDATE events SET is_active=$2::bool WHERE id=$1::uuid RETURNING id`, [p.id, !!p.active]) && true },
  cancelOrder: { min: 3, fn: (u, p) => { const r = q(`UPDATE orders SET status='cancelled',cancelled_at=now() WHERE id=$1::uuid AND status<>'cancelled' RETURNING id,order_code`, [p.id]); if (!r.length) throw new Error('NOT_FOUND'); trashTicketFiles(r[0].order_code); return true; } },
  confirmPay:  { min: 3, fn: confirmPay },
  resend:      { min: 2, fn: (u, p) => resendTicketEmail(p.id) },
  batchResendEmails: { min: 2, fn: batchResendEmails },
  ordersAll:   { min: 2, fn: ordersAll },
  invitations: { min: 2, fn: () => invitations() },
  invitationCreate: { min: 2, fn: invitationCreate },
  waitingList: { min: 2, fn: waitingList },
  waitingCreate: { min: 2, fn: waitingCreate },
  waitingUpdate: { min: 2, fn: waitingUpdate },
  waitingDelete: { min: 2, fn: waitingDelete },
  waitingPromote: { min: 2, fn: waitingPromote },
  waitingPromoteAll: { min: 2, fn: waitingPromoteAll },
  getInvConfig: { min: 2, fn: getInvConfig },
  setInvMaxQty: { min: 3, fn: setInvMaxQty },
  checkinOrder:{ min: 2, fn: checkinOrder },
  getCheckinPin: { min: 3, fn: getCheckinPin },
  setCheckinPin: { min: 3, fn: setCheckinPin },
  legalGet:    { min: 2, fn: () => legalGetAll() },
  legalSave:   { min: 3, fn: legalSave },
  legalPreview:{ min: 2, fn: (u, p) => legalPreview(p) },
  resetPw:     { min: 3, fn: (u, p) => { if (p.id === u.id) throw new Error('SELF'); const temp = rnd(10); setPassword(p.id, temp); return { temp: temp }; } },
  setRole:     { min: 3, fn: (u, p) => {
    if (!(p.role in RANK)) throw new Error('BAD_ROLE'); if (p.id === u.id) throw new Error('SELF');
    q(`UPDATE users SET role=$2 WHERE id=$1::uuid RETURNING id`, [p.id, p.role]); return true; } },
  feedbackSubmit: { min: 0, fn: feedbackSubmit },
  feedbacksGet:    { min: 2, fn: feedbacksGet },
  feedbackDelete:  { min: 2, fn: feedbackDelete },
  checkpointsGet:     { min: 1, fn: checkpointsGet },
  checkpointSave:     { min: 2, fn: checkpointSave },
  checkpointDelete:   { min: 2, fn: checkpointDelete },
  checkpointsResetDefaults: { min: 2, fn: checkpointsResetDefaults },
  checkpointExportCsv:{ min: 1, fn: checkpointExportCsv },
  doorprizePool:   { min: 2, fn: doorprizePool },
  doorprizeSaveWinner: { min: 2, fn: doorprizeSaveWinner },
  doorprizeDeleteWinner: { min: 2, fn: doorprizeDeleteWinner },
  doorprizeResetAll: { min: 2, fn: doorprizeResetAll }
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
    return { ok: false, error: (e && e.message) ? e.message : 'E_GENERIC' };
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
  const name = String(p.name || '').trim();
  if (name && name.length < 2) throw new Error('BAD_NAME');
  if (!wa) throw new Error('BAD_PHONE');
  if (!(age >= 1 && age <= 120)) throw new Error('BAD_AGE');
  if (church.length < 2) throw new Error('BAD_CHURCH');
  if (name) {
    q(`UPDATE users SET name=$1,whatsapp=$2,age=$3::int,church=$4 WHERE id=$5::uuid RETURNING id`, [name, wa, age, church, u.id]);
  } else {
    q(`UPDATE users SET whatsapp=$1,age=$2::int,church=$3 WHERE id=$4::uuid RETURNING id`, [wa, age, church, u.id]);
  }
  return { whatsapp: wa, name: name || u.name };
}
const UID_SESSION = "(SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now())";
function eventsSql(uid) {   // uid = ekspresi SQL untuk id pengguna
  const mine = `FROM orders o WHERE o.event_id=e.id AND o.user_id=${uid} AND o.status<>'cancelled' AND o.kind='order'`;
  return `SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,coalesce(e.walkin_quota,0)::int AS walkin_quota,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining,
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
     AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled' AND kind<>'walk_in') + $4::int <= e.quota
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
      (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS rem,
      (e.one_order_per_account AND EXISTS(SELECT 1 FROM orders o WHERE o.event_id=e.id AND o.user_id=$2::uuid AND o.status<>'cancelled' AND o.kind='order')) AS dup
      FROM events e WHERE e.id=$1::uuid`, [p.eventId, u.id])[0];
    throw new Error(!d.is_active ? 'INACTIVE' : d.dup ? 'ALREADY' : qty > d.max_per_order ? 'MAX' : 'SOLDOUT');
  }
  const o = orderFull(row.id);
  let emailed = false;
  if (o.status === 'confirmed' && o.kind !== 'invitation') {
    try {
      const prov = sendTicketEmail(o);
      emailed = true;
      try { q(`UPDATE orders SET emailed=true, emailed_at=now(), email_error=$2 WHERE id=$1::uuid RETURNING id`, [row.id, 'Terkirim via ' + (prov || 'email')]); } catch (x) {}
    } catch (e) {
      const emMsg = e && e.message ? e.message : 'EMAIL_FAIL';
      try { q(`UPDATE orders SET emailed=false, email_error=$2 WHERE id=$1::uuid RETURNING id`, [row.id, emMsg]); } catch (x) {}
      Logger.log('Booking email err: ' + e);
    }
  }
  return { id: row.id, status: row.status, ticket_code: row.ticket_code, emailed: emailed };
}

/* ---------- Admin ---------- */
function stats() {
  ensureWalkinSchema();
  return q(`SELECT e.id,e.name,e.quota,coalesce(e.walkin_quota,0)::int AS walkin_quota,e.is_active,
    coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS booked,
    coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS checked,
    coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_booked,
    coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_checked,
    coalesce(sum(o.qty) FILTER (WHERE o.status='pending_payment'),0)::int AS pending,
    coalesce(sum(o.total) FILTER (WHERE o.status='confirmed'),0)::int AS revenue
    FROM events e LEFT JOIN orders o ON o.event_id=e.id GROUP BY e.id ORDER BY e.event_date`);
}

function ensureWalkinSchema() {
  const cache = CacheService.getScriptCache();
  if (cache.get('col_walkin_v3')) return;
  try {
    neon([
      { query: 'ALTER TABLE events ADD COLUMN IF NOT EXISTS walkin_quota int DEFAULT 0' },
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_phone text' },
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_email text' },
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_age int' },
      { query: 'ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_kind_check' },
      { query: "ALTER TABLE orders ADD CONSTRAINT orders_kind_check CHECK (kind IN ('order','invitation','walk_in'))" }
    ]);
    cache.put('col_walkin_v3', '1', 21600);
  } catch (e) {
    Logger.log('ensureWalkinSchema error: ' + (e.stack || e));
  }
}

function ensureEmailColumns() {
  const cache = CacheService.getScriptCache();
  if (cache.get('col_em_v2')) return;
  try {
    neon([
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS emailed boolean DEFAULT true' },
      { query: 'ALTER TABLE orders ALTER COLUMN emailed SET DEFAULT false' },
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_error text' },
      { query: 'ALTER TABLE orders ADD COLUMN IF NOT EXISTS emailed_at timestamptz' }
    ]);
    cache.put('col_em_v2', '1', 21600);
  } catch (e) {
    Logger.log('ensureEmailColumns error: ' + (e.stack || e));
  }
}

const ORDERS_SQL = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.checked_in_at,o.created_at,o.kind,
    coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
    coalesce(o.rsvp_status, 'attending') AS rsvp_status,
    coalesce(o.plus_one_count, 0)::int AS plus_one_count,
    coalesce(o.guestbook_message, '') AS guestbook_message,
    coalesce(o.table_assignment, '') AS table_assignment,
    coalesce(o.emailed, false) AS emailed, o.email_error, o.emailed_at,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind='invitation' THEN 'Undangan' WHEN o.kind='walk_in' THEN coalesce(nullif(o.guest_email,''), 'Walk-In') ELSE u.email END AS email,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
    e.id AS event_id,e.name AS event_name
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    WHERE ($1::uuid IS NULL OR o.event_id=$1::uuid) AND ($2::text IS NULL OR o.status=$2::text)
    ORDER BY o.created_at DESC`;

function adminOrders(u, p) { ensureEmailColumns(); ensureWalkinSchema(); return q(ORDERS_SQL + ' LIMIT 1000', [p.eventId || null, p.status || null]); }
function ordersAll(u, p) {
  ensureEmailColumns(); ensureWalkinSchema();
  const rows = q(ORDERS_SQL + ' LIMIT 5001', [p.eventId || null, p.status || null]);
  const trunc = rows.length > 5000; if (trunc) rows.length = 5000;
  return { rows: rows, truncated: trunc };
}

function saveEvent(u, p) {
  ensureWalkinSchema();
  ensureFeatureTables();
  const cols = ['name', 'category', 'banner_url', 'description', 'announcement', 'event_date', 'start_time', 'end_time', 'location', 'quota', 'walkin_quota', 'is_paid', 'price', 'max_per_order', 'one_order_per_account', 'is_active', 'payment_instructions', 'terms', 'custom_fields', 'enable_nametag', 'enable_certificate', 'certificate_config', 'active_modules', 'module_config'];
  const types = ['text', 'text', 'text', 'text', 'text', 'date', 'time', 'time', 'text', 'int', 'int', 'bool', 'int', 'int', 'bool', 'bool', 'text', 'text', 'jsonb', 'bool', 'bool', 'jsonb', 'jsonb', 'jsonb'];
  const paid = !!p.is_paid, quota = parseInt(p.quota, 10), maxp = parseInt(p.max_per_order, 10), walkinQuota = Math.max(0, parseInt(p.walkin_quota, 10) || 0);
  if (!String(p.name || '').trim() || !String(p.location || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.event_date || '') || !/^\d{2}:\d{2}/.test(p.start_time || '')) throw new Error('BAD_EVENT');
  if (!(quota > 0) || !(maxp > 0)) throw new Error('BAD_EVENT');

  const customFields = Array.isArray(p.custom_fields) ? JSON.stringify(p.custom_fields) : (p.custom_fields || '[]');
  const enableNametag = !!p.enable_nametag;
  const enableCertificate = !!p.enable_certificate;
  const certConfig = typeof p.certificate_config === 'object' ? JSON.stringify(p.certificate_config || {}) : (p.certificate_config || '{}');
  const activeModules = Array.isArray(p.active_modules) ? JSON.stringify(p.active_modules) : (p.active_modules || '["ticketing"]');
  const moduleConfig = typeof p.module_config === 'object' ? JSON.stringify(p.module_config || {}) : (p.module_config || '{}');

  const v = [p.name.trim(), p.category || '', p.banner_url || '', p.description || '', p.announcement || '', p.event_date, p.start_time, p.end_time || null, p.location.trim(),
    quota, walkinQuota, paid, paid ? Math.max(0, parseInt(p.price, 10) || 0) : 0, maxp, !!p.one_order_per_account, p.is_active !== false, p.payment_instructions || '', String(p.terms || '').slice(0, 8000),
    customFields, enableNametag, enableCertificate, certConfig, activeModules, moduleConfig];
  const ph = cols.map((c, i) => `$${i + 1}::${types[i]}`).join(',');
  const upd = cols.map(c => `${c}=EXCLUDED.${c}`).join(',');
  return q(`INSERT INTO events(${cols.join(',')},id) VALUES(${ph},$${cols.length + 1}::uuid) ON CONFLICT(id) DO UPDATE SET ${upd} RETURNING id`, v.concat([p.id || Utilities.getUuid()]))[0];
}

function confirmPay(u, p) {
  if (!q(`UPDATE orders SET status='confirmed' WHERE id=$1::uuid AND status='pending_payment' RETURNING id`, [p.id]).length) throw new Error('NOT_FOUND');
  const o = orderFull(p.id);
  if (o && o.kind !== 'invitation') {
    try {
      const prov = sendTicketEmail(o);
      q(`UPDATE orders SET emailed=true, emailed_at=now(), email_error=$2 WHERE id=$1::uuid RETURNING id`, [p.id, 'Terkirim via ' + (prov || 'email')]);
    } catch (e) {
      const emMsg = e && e.message ? e.message : 'EMAIL_FAIL';
      q(`UPDATE orders SET emailed=false, email_error=$2 WHERE id=$1::uuid RETURNING id`, [p.id, emMsg]);
      Logger.log('Confirm pay email err: ' + e);
    }
  }
  return true;
}

function resendTicketEmail(id) {
  const o = orderFull(id);
  if (!o || o.status !== 'confirmed' || o.kind === 'invitation') throw new Error('NOT_CONFIRMED');
  try {
    const prov = sendTicketEmail(o);
    q(`UPDATE orders SET emailed=true, emailed_at=now(), email_error=$2 WHERE id=$1::uuid RETURNING id`, [o.id, 'Terkirim via ' + (prov || 'email')]);
    return { ok: true, id: o.id };
  } catch (e) {
    const msg = e && e.message ? e.message : 'EMAIL_FAIL';
    q(`UPDATE orders SET emailed=false, email_error=$2 WHERE id=$1::uuid RETURNING id`, [o.id, msg]);
    throw e;
  }
}

function batchResendEmails(u, p) {
  ensureEmailColumns();
  const evId = p && p.eventId ? p.eventId : null;
  const limit = Math.min(Math.max(parseInt(p && p.limit, 10) || 5, 1), 25);
  const list = q(`SELECT o.id, o.order_code, o.ticket_code
    FROM orders o WHERE o.status='confirmed' AND o.kind='order' AND coalesce(o.emailed, false)=false
    AND ($1::uuid IS NULL OR o.event_id=$1::uuid)
    ORDER BY o.created_at ASC LIMIT $2`, [evId, limit]);
  
  const totalLeft = q(`SELECT count(*)::int AS cnt
    FROM orders o WHERE o.status='confirmed' AND o.kind='order' AND coalesce(o.emailed, false)=false
    AND ($1::uuid IS NULL OR o.event_id=$1::uuid)`, [evId])[0].cnt;

  if (!list.length) return { total: 0, sent: 0, failed: 0, remaining: 0, stopped: false, message: 'Semua pemesan sudah menerima email.' };
  
  let sent = 0, failed = 0, stopped = false, stopReason = '';
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    try {
      const o = orderFull(item.id);
      const prov = sendTicketEmail(o);
      q(`UPDATE orders SET emailed=true, emailed_at=now(), email_error=$2 WHERE id=$1::uuid RETURNING id`, [item.id, 'Terkirim via ' + (prov || 'email')]);
      sent++;
      Utilities.sleep(200);
    } catch (err) {
      failed++;
      const msg = err && err.message ? err.message : 'EMAIL_FAIL';
      q(`UPDATE orders SET emailed=false, email_error=$2 WHERE id=$1::uuid RETURNING id`, [item.id, msg.slice(0, 500)]);
      Logger.log('Batch resend err on ' + item.ticket_code + ': ' + err);
      if (/quota|limit|too many times/i.test(msg) || msg === 'EMAIL_QUOTA') {
        stopped = true;
        stopReason = 'EMAIL_QUOTA';
        break;
      }
      if (failed >= 2 && sent === 0) {
        stopped = true;
        stopReason = msg;
        break;
      }
    }
  }
  return { total: list.length, sent: sent, failed: failed, remaining: Math.max(0, totalLeft - sent), stopped: stopped, reason: stopReason };
}
function ensureDefaultCheckpointsGS(eventId) {
  const DEFAULT_CPS = [
    { key: 'main_gate', name: 'Pintu Masuk Utama', icon: '🎟️', type: 'gate', sort: 1 },
    { key: 'meal', name: 'Konsumsi (Lunch/Dinner/Snack)', icon: '🍱', type: 'meal', sort: 2 },
    { key: 'kit', name: 'Souvenir / Seminar Kit', icon: '🎁', type: 'kit', sort: 3 },
    { key: 'breakout', name: 'Breakout Session / Ruang Kelas', icon: '🚪', type: 'session', sort: 4 },
    { key: 'voucher', name: 'Voucher Diskon Bazaar', icon: '🏷️', type: 'voucher', sort: 5 }
  ];
  const cnt = q(`SELECT count(*)::int AS cnt FROM event_checkpoints WHERE event_id=$1::uuid`, [eventId])[0];
  if (!cnt || cnt.cnt === 0) {
    for (const cp of DEFAULT_CPS) {
      q(`INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, sort_order)
        VALUES($1::uuid, $2, $3, $4, $5, $6) ON CONFLICT (event_id, checkpoint_key) DO NOTHING`,
        [eventId, cp.key, cp.name, cp.icon, cp.type, cp.sort]);
    }
  }
}

function validate(u, p) {
  const code = String(p.code || '').trim().toUpperCase().replace(/\s/g, '');
  const cpKey = String(p.checkpoint || 'main_gate').trim();
  const o = q(`SELECT o.id,o.qty,o.status,o.checked_in,o.checked_in_at,o.kind,o.event_id,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,e.name AS event_name
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code])[0];
  if (!o) return { result: 'NOT_FOUND', code: code };
  ensureDefaultCheckpointsGS(o.event_id);

  const cpInfo = q(`SELECT checkpoint_key, name, icon, checkpoint_type FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2`, [o.event_id, cpKey])[0] || { checkpoint_key: cpKey, name: cpKey === 'main_gate' ? 'Pintu Masuk Utama' : cpKey, icon: '📍', checkpoint_type: 'facility' };

  const base = { code: code, kind: o.kind, name: o.name, church: o.church, age: o.age, whatsapp: o.whatsapp, event: o.event_name, qty: o.qty, at: o.checked_in_at, checkpoint: cpInfo };
  if (o.status === 'cancelled') return Object.assign(base, { result: 'CANCELLED' });
  if (o.status === 'pending_payment') return Object.assign(base, { result: 'UNPAID' });

  if (cpKey === 'main_gate') {
    if (o.checked_in >= o.qty) return Object.assign(base, { result: 'USED', checked: o.checked_in });
    const r = q(`UPDATE orders SET checked_in=qty,checked_in_at=now(),checked_in_by=$2::uuid WHERE id=$1::uuid AND checked_in<qty RETURNING qty`, [o.id, u.id]);
    if (!r.length) return Object.assign(base, { result: 'USED', checked: o.qty });
    q(`INSERT INTO checkpoint_claims(event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by, claimed_by_name)
      VALUES($1::uuid, 'main_gate', $2::uuid, $3, $4::int, $5::uuid, $6) ON CONFLICT (order_id, checkpoint_key) DO NOTHING`,
      [o.event_id, o.id, code, o.qty, u.id, u.name || 'Petugas Gerbang']);
    return Object.assign(base, { result: 'VALID', entered: o.qty - o.checked_in, checked: o.qty, at: new Date().toISOString() });
  }

  // Facility / Session Checkpoint
  if (o.checked_in <= 0) {
    return Object.assign(base, {
      result: 'NOT_CHECKED_IN',
      message: 'Peserta belum check-in di Pintu Masuk Utama! Arahkan ke meja registrasi / gerbang masuk terlebih dahulu.'
    });
  }

  const existingClaim = q(`SELECT claimed_at, to_char(claimed_at AT TIME ZONE 'Asia/Jakarta','HH24:MI') AS claim_time, claimed_by_name, qty FROM checkpoint_claims WHERE order_id=$1::uuid AND checkpoint_key=$2`, [o.id, cpKey])[0];
  if (existingClaim) {
    return Object.assign(base, {
      result: 'ALREADY_CLAIMED',
      message: cpInfo.name + ' sudah diambil pada ' + existingClaim.claim_time + ' WIB' + (existingClaim.claimed_by_name ? ' oleh ' + existingClaim.claimed_by_name : '') + '.',
      claimed_at: existingClaim.claimed_at,
      claimed_by: existingClaim.claimed_by_name,
      claimed_qty: existingClaim.qty
    });
  }

  q(`INSERT INTO checkpoint_claims(event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by, claimed_by_name)
    VALUES($1::uuid, $2, $3::uuid, $4, $5::int, $6::uuid, $7)`,
    [o.event_id, cpKey, o.id, code, o.qty, u.id, u.name || 'Petugas Pos']);

  return Object.assign(base, {
    result: 'VALID',
    message: cpInfo.name + ' berhasil diverifikasi!',
    entered: o.qty,
    claimed_qty: o.qty,
    at: new Date().toISOString()
  });
}

function offlineManifest(u, p) {
  if (!p.eventId) throw new Error('BAD_EVENT');
  const ev = q(`SELECT id, name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  const sql = `SELECT o.ticket_code AS code, o.qty, o.checked_in AS checked, o.status, o.kind,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
    e.name AS event_name
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
    WHERE o.event_id=$1::uuid AND o.status<>'cancelled'`;
  const rows = q(sql, [p.eventId]);
  return { eventId: ev.id, eventName: ev.name, downloadedAt: new Date().toISOString(), count: rows.length, tickets: rows };
}

function syncOfflineCheckins(u, p) {
  const list = p.checkins || [];
  if (!list.length) return { synced: 0 };
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const code = String(it.code || '').trim().toUpperCase();
    if (!code) continue;
    const at = it.at ? new Date(it.at).toISOString() : new Date().toISOString();
    const r = q(`UPDATE orders SET checked_in=qty, checked_in_at=$2::timestamptz, checked_in_by=$3::uuid WHERE ticket_code=$1 AND checked_in<qty RETURNING qty`, [code, at, u.id]);
    if (r.length) count++;
  }
  return { synced: count, total: list.length };
}

function gateLink(u, p) {
  if (!p.eventId) throw new Error('BAD_EVENT');
  const ev = q(`SELECT id, name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  const evId = String(ev.id).trim().toLowerCase();
  const key = sha('gate_' + evId).slice(0, 16);
  let base = (p && p.base ? String(p.base) : '').trim();
  if (!base || base.indexOf('http') !== 0) {
    base = config().scanUrl ? config().scanUrl.replace(/scan\.html.*$/, '') : 'https://xavierindoprama-sudo.github.io/ambiltiketnya/';
  }
  const url = base.replace(/\/+$/, '') + '/?gate=' + evId + '&k=' + key;
  return { eventId: evId, eventName: ev.name, key: key, url: url };
}

function gateLogin(p) { return pubRun(gateLoginImpl, p); }
function gateLoginImpl(p) {
  const evId = String(p.eventId || '').trim().toLowerCase(), key = String(p.key || '').trim().toLowerCase();
  if (!evId || !key) throw new Error('BAD_GATE');
  const k1 = sha('gate_' + evId).slice(0, 16).toLowerCase();
  const k2 = sha('gate_' + evId + '_' + P.getProperty('DATABASE_URL')).slice(0, 16).toLowerCase();
  const k3 = sha('gate_pass_' + evId).slice(0, 16).toLowerCase();
  if (key !== k1 && key !== k2 && key !== k3) throw new Error('INVALID_KEY');
  const ev = q(`SELECT id, name, is_active FROM events WHERE id=$1::uuid`, [evId])[0];
  if (!ev) throw new Error('EVENT_NOT_FOUND');
  let vol = null;
  try {
    vol = q(`SELECT id, name, role, email FROM users WHERE lower(email)='gate_volunteer@ambiltiketnya.online'`)[0];
  } catch (e) { Logger.log(e); }
  if (!vol) {
    try {
      vol = q(`INSERT INTO users(name,email,whatsapp,age,church,password_hash,role)
        VALUES('Petugas Gerbang','gate_volunteer@ambiltiketnya.online','628123456789',25,'Panitia Gerbang','!','gate_staff')
        ON CONFLICT (email) DO UPDATE SET role='gate_staff'
        RETURNING id,name,role,email`)[0];
    } catch (e2) {
      Logger.log('Insert volunteer err: ' + e2);
      try {
        vol = q(`SELECT id, name, role, email FROM users WHERE lower(email)='gate_volunteer@ambiltiketnya.online'`)[0];
      } catch (e3) {}
    }
  }
  if (!vol) throw new Error('AUTH');
  const token = newSession(vol.id);
  const user = { id: vol.id, name: 'Petugas Gerbang', role: 'gate_staff', email: 'gate_volunteer@ambiltiketnya.online' };
  return { session: token, user: user, role: 'gate_staff', name: 'Petugas Gerbang', eventId: ev.id, eventName: ev.name };
}


/* ---------- Pengiriman email: Gmail (MailApp) -> Brevo -> MailerSend -> Resend ---------- */
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
      Logger.log('Kuota Gmail habis, coba provider cadangan: ' + e.message);
    }
  }

  // 1. Coba Brevo jika sudah diatur
  if (P.getProperty('BREVO_API_KEY') && P.getProperty('BREVO_SENDER_EMAIL')) {
    try {
      return brevoSend(m);
    } catch (e) {
      Logger.log('Brevo gagal / kuota habis: ' + (e.message || e) + ', mencoba MailerSend...');
    }
  }

  // 2. Coba MailerSend jika sudah diatur
  if (P.getProperty('MAILERSEND_API_KEY')) {
    try {
      return mailersendSend(m);
    } catch (e) {
      Logger.log('MailerSend gagal / kuota habis: ' + (e.message || e) + ', mencoba Resend...');
    }
  }

  // 3. Coba Resend jika sudah diatur
  if (P.getProperty('RESEND_API_KEY')) {
    try {
      return resendSend(m);
    } catch (e) {
      Logger.log('Resend gagal: ' + (e.message || e));
      throw e;
    }
  }

  throw new Error('EMAIL_QUOTA');
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

/* ---------- Provider Resend (api.resend.com) ---------- */
function resendRaw(m) {
  const key = (P.getProperty('RESEND_API_KEY') || '').trim();
  const from = (P.getProperty('RESEND_SENDER_EMAIL') || 'tiket@ambiltiketnya.online').trim();
  const name = (P.getProperty('RESEND_SENDER_NAME') || m.name || 'AmbilTiketnya').trim();
  const toEmail = String(m.to || '').trim();
  const body = {
    from: `${name} <${from}>`,
    to: [toEmail],
    subject: m.subject,
    html: m.htmlBody
  };
  if (m.attachments && m.attachments.length) {
    body.attachments = m.attachments.map(b => ({
      filename: b.getName(),
      content: Utilities.base64Encode(b.getBytes())
    }));
  }
  const r = UrlFetchApp.fetch('https://api.resend.com/emails', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + key },
    payload: JSON.stringify(body)
  });
  return { code: r.getResponseCode(), text: String(r.getContentText()) };
}
function resendSend(m) {
  if (!P.getProperty('RESEND_API_KEY')) throw new Error('EMAIL_QUOTA');
  const r = resendRaw(m);
  if (r.code < 200 || r.code >= 300) {
    let msg = 'Resend HTTP ' + r.code;
    try {
      const j = JSON.parse(r.text);
      if (j.message) msg += ': ' + j.message;
    } catch (e) {
      msg += ': ' + r.text.slice(0, 150);
    }
    Logger.log(msg);
    throw new Error(msg);
  }
  return 'resend';
}
function ujiResend() {
  const to = P.getProperty('SUPERADMIN_EMAIL');
  if (!to) { Logger.log('GAGAL: SUPERADMIN_EMAIL belum diisi'); return; }
  if (!P.getProperty('RESEND_API_KEY')) { Logger.log('GAGAL: isi RESEND_API_KEY di Script Properties'); return; }
  const r = resendRaw({ to: to, subject: 'Uji Resend - ambiltiketnya.online', htmlBody: '<p>Jika email ini diterima, integrasi Resend berfungsi sempurna!</p>' });
  if (r.code >= 200 && r.code < 300) Logger.log('OK - email percobaan terkirim via Resend ke ' + to + ' (periksa kotak masuk/spam)');
  else Logger.log('GAGAL (HTTP ' + r.code + '): ' + r.text);
}
function ujiResendTiket() {
  const to = P.getProperty('SUPERADMIN_EMAIL');
  if (!to) { Logger.log('GAGAL: SUPERADMIN_EMAIL belum diisi'); return; }
  const list = q(`SELECT o.id, o.ticket_code, u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='confirmed' AND o.kind='order' LIMIT 1`);
  if (!list.length) { Logger.log('GAGAL: Tidak ada pesanan confirmed di database'); return; }
  const item = list[0];
  Logger.log('Membuat e-tiket PDF untuk kode ' + item.ticket_code + '...');
  try {
    const o = orderFull(item.id);
    const blob = ticketBlob(o);
    Logger.log('PDF berhasil dibuat (' + blob.getBytes().length + ' bytes). Mengirim via Resend ke ' + to + '...');
    const r = resendRaw({
      to: to,
      subject: '[UJI TIKET PDF] ' + o.ename + ' - ' + o.ticket_code,
      htmlBody: '<p>Halo, ini adalah email uji coba tiket PDF via Resend.</p>',
      attachments: [blob]
    });
    Logger.log('Status Resend HTTP ' + r.code + ': ' + r.text);
    if (r.code >= 200 && r.code < 300) {
      Logger.log('SUKSES! E-tiket PDF berhasil dikirim ke ' + to);
    } else {
      Logger.log('GAGAL dari Resend: ' + r.text);
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}

/* ---------- Provider MailerSend (api.mailersend.com) ---------- */
function mailersendRaw(m) {
  const key = (P.getProperty('MAILERSEND_API_KEY') || '').trim();
  const from = (P.getProperty('MAILERSEND_SENDER_EMAIL') || P.getProperty('RESEND_SENDER_EMAIL') || 'tiket@ambiltiketnya.online').trim();
  const name = (P.getProperty('MAILERSEND_SENDER_NAME') || m.name || 'AmbilTiketnya').trim();
  const toEmail = String(m.to || '').trim();
  const body = {
    from: { email: from, name: name },
    to: [{ email: toEmail }],
    subject: m.subject,
    html: m.htmlBody
  };
  if (m.attachments && m.attachments.length) {
    body.attachments = m.attachments.map(b => ({
      filename: b.getName(),
      content: Utilities.base64Encode(b.getBytes()),
      disposition: 'attachment'
    }));
  }
  const r = UrlFetchApp.fetch('https://api.mailersend.com/v1/email', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + key, 'X-Requested-With': 'XMLHttpRequest' },
    payload: JSON.stringify(body)
  });
  return { code: r.getResponseCode(), text: String(r.getContentText()) };
}
function mailersendSend(m) {
  if (!P.getProperty('MAILERSEND_API_KEY')) throw new Error('EMAIL_QUOTA');
  const r = mailersendRaw(m);
  if (r.code < 200 || r.code >= 300) {
    let msg = 'MailerSend HTTP ' + r.code;
    try {
      const j = JSON.parse(r.text);
      if (j.message) msg += ': ' + j.message;
      else if (j.errors) msg += ': ' + JSON.stringify(j.errors);
    } catch (e) {
      msg += ': ' + r.text.slice(0, 150);
    }
    Logger.log(msg);
    throw new Error(msg);
  }
  return 'mailersend';
}
function ujiMailersend() {
  const to = P.getProperty('SUPERADMIN_EMAIL');
  if (!to) { Logger.log('GAGAL: SUPERADMIN_EMAIL belum diisi'); return; }
  if (!P.getProperty('MAILERSEND_API_KEY')) { Logger.log('GAGAL: isi MAILERSEND_API_KEY di Script Properties'); return; }
  const r = mailersendRaw({ to: to, subject: 'Uji MailerSend - ambiltiketnya.online', htmlBody: '<p>Jika email ini diterima, integrasi MailerSend berfungsi sempurna!</p>' });
  if (r.code >= 200 && r.code < 300) Logger.log('OK - email percobaan terkirim via MailerSend ke ' + to + ' (periksa kotak masuk/spam)');
  else Logger.log('GAGAL (HTTP ' + r.code + '): ' + r.text);
}
function ujiMailersendTiket() {
  const to = P.getProperty('SUPERADMIN_EMAIL');
  if (!to) { Logger.log('GAGAL: SUPERADMIN_EMAIL belum diisi'); return; }
  const list = q(`SELECT o.id, o.ticket_code, u.email FROM orders o JOIN users u ON u.id=o.user_id WHERE o.status='confirmed' AND o.kind='order' LIMIT 1`);
  if (!list.length) { Logger.log('GAGAL: Tidak ada pesanan confirmed di database'); return; }
  const item = list[0];
  Logger.log('Membuat e-tiket PDF untuk kode ' + item.ticket_code + '...');
  try {
    const o = orderFull(item.id);
    const blob = ticketBlob(o);
    Logger.log('PDF berhasil dibuat (' + blob.getBytes().length + ' byte). Mengirim via MailerSend ke ' + to + '...');
    const r = mailersendRaw({
      to: to,
      subject: '[UJI TIKET PDF] ' + o.ename + ' - ' + o.ticket_code,
      htmlBody: '<p>Halo, ini adalah email uji coba tiket PDF via MailerSend.</p>',
      attachments: [blob]
    });
    Logger.log('Status MailerSend HTTP ' + r.code + ': ' + r.text);
    if (r.code >= 200 && r.code < 300) {
      Logger.log('SUKSES! E-tiket PDF berhasil dikirim ke ' + to);
    } else {
      Logger.log('GAGAL dari MailerSend: ' + r.text);
    }
  } catch (err) {
    Logger.log('ERROR: ' + (err.stack || err));
  }
}

/* ---------- E-ticket PDF + email ---------- */
function orderFull(id) {
  return q(`SELECT o.id,o.user_id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.created_at,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_email,o.guest_age,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS uname,
    CASE WHEN o.kind='invitation' THEN 'Undangan' WHEN o.kind='walk_in' THEN coalesce(nullif(o.guest_email,''), 'Walk-In') ELSE u.email END AS email,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
    e.name AS ename,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location,e.announcement,e.terms
    FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.id=$1::uuid`, [id])[0];
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function idDate(s) {
  const D = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'], M = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const [y, m, d] = s.split('-').map(Number), dt = new Date(Date.UTC(y, m - 1, d));
  return D[dt.getUTCDay()] + ', ' + d + ' ' + M[m - 1] + ' ' + y;
}
function getEventTerms(o) {
  if (o.terms && String(o.terms).trim()) return String(o.terms).trim();
  return [
    '1. Tiket berlaku untuk satu kali masuk dan sesuai jumlah kuota pesanan.',
    '2. Tunjukkan kode QR e-tiket di gerbang masuk. Satu QR berlaku untuk seluruh rombongan.',
    '3. Peserta diharapkan hadir sebelum acara dimulai sesuai pengumuman panitia.',
    '4. Tiket tidak dapat dipindahtangankan atau diperjualbelikan.',
    '5. Panitia berhak menolak peserta yang tidak membawa tiket sah atau mengganggu ketertiban.',
    '6. Dengan memiliki tiket ini, peserta menyetujui seluruh syarat dan ketentuan yang berlaku.'
  ].join('\n');
}
function formatTermsHtml(rawTerms, isGold) {
  const text = String(rawTerms || '').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const color = isGold ? '#6b5300' : '#475569';
  const border = isGold ? '#e5d59e' : '#e2e8f0';
  const bg = isGold ? '#fffdf7' : '#f8fafc';
  const headerColor = isGold ? '#8a7a3a' : '#1e293b';
  const rows = lines.map(line => `<div style="margin-bottom:3px;font-size:9px;line-height:1.4;color:${color}">${esc(line)}</div>`).join('');
  return `<div style="margin:14px 36px 0;padding:10px 14px;background:${bg};border:1px solid ${border};border-radius:6px">
    <div style="font-size:9.5px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:${headerColor};margin-bottom:6px">Syarat & Ketentuan Acara</div>
    ${rows}
  </div>`;
}
function invitationPdfHtml(o, img) {             // desain undangan: navy + emas
  const G = '#d4af37', N = '#0b1026';
  const f = (l, v) => `<div style="font-size:9px;color:#8a7a3a;letter-spacing:1px;text-transform:uppercase;margin-top:10px">${l}</div><div style="font-size:14px;font-weight:bold">${esc(v)}</div>`;
  const termsHtml = formatTermsHtml(getEventTerms(o), true);
  return `<html><body style="margin:0;font-family:Arial,sans-serif;color:${N}">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${N};border-bottom:6px solid ${G}"><tr><td style="padding:22px 36px">
  <div style="font-size:12px;letter-spacing:7px;color:${G};font-weight:bold">UNDANGAN</div>
  <div style="font-size:24px;font-weight:bold;color:#fff;margin-top:6px">${esc(o.ename)}</div>
  <div style="font-size:9px;letter-spacing:3px;color:#c9b873;margin-top:6px">E-TIKET UNDANGAN - AMBILTIKETNYA</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0"><tr><td style="padding:18px 36px 0"><div style="font-size:10px;color:#8a7a3a;letter-spacing:3px">KEPADA YTH.</div>
  <div style="font-size:22px;font-weight:bold;margin-top:4px">${esc(o.uname)}</div><div style="font-size:13px;color:#555;margin-top:2px">${esc(o.church)}</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px"><tr>
  <td width="200" valign="top" style="padding:0 20px 0 36px"><div style="border:2px solid ${G};padding:6px;width:160px"><img src="${img}" width="160" height="160"/></div>
   <div style="font-family:monospace;font-size:13px;font-weight:bold;margin-top:8px">${o.ticket_code}</div><div style="font-size:9px;color:#778">Pindai di gerbang masuk</div></td>
  <td valign="top" style="padding-right:36px">${f('Hari & Tanggal', idDate(o.edate))}${f('Waktu', o.stime + ' WIB')}${f('Lokasi', o.location)}${f('Jumlah Tiket', o.qty + ' orang')}${f('Nomor Undangan', o.order_code)}</td></tr></table>
  ${o.qty > 1 ? `<div style="margin:14px 36px 0;padding:10px 14px;border:1px solid ${G};background:#fffdf7;border-radius:6px;font-size:10.5px;color:#6b5300;line-height:1.45">&#9432; <b>Catatan:</b> Satu kode QR ini berlaku untuk ${o.qty} orang. Mohon hadir dan masuk bersamaan di gerbang masuk karena tiket hanya dapat dipindai 1 kali.</div>` : ''}
  ${termsHtml}
  </body></html>`;
}
function ticketBlob(o) {
  const png = UrlFetchApp.fetch('https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=' + encodeURIComponent(o.ticket_code)).getBlob();
  const img = 'data:image/png;base64,' + Utilities.base64Encode(png.getBytes());
  const f = (l, v) => `<div style="font-size:9px;color:#778;letter-spacing:1px;text-transform:uppercase;margin-top:10px">${l}</div><div style="font-size:14px;font-weight:bold">${esc(v)}</div>`;
  const termsHtml = formatTermsHtml(getEventTerms(o), false);
  const tag = o.kind === 'walk_in' ? 'E-TIKET WALK-IN (DI TEMPAT) · AMBILTIKETNYA' : 'E-TIKET RESMI · AMBILTIKETNYA';
  const html = o.kind === 'invitation' ? invitationPdfHtml(o, img) : `<html><body style="margin:0;font-family:Arial,sans-serif;color:#0f1222">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1222"><tr><td style="padding:22px 36px">
  <div style="font-size:10px;letter-spacing:3px;color:#9a8cff">${tag}</div>
  <div style="font-size:24px;font-weight:bold;color:#fff;margin-top:6px">${esc(o.ename)}</div></td></tr></table>
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px"><tr>
  <td width="200" valign="top" style="padding:0 20px 0 36px"><img src="${img}" width="160" height="160"/>
   <div style="font-family:monospace;font-size:13px;font-weight:bold;margin-top:8px">${o.ticket_code}</div>
   <div style="font-size:9px;color:#778">Pindai di gerbang masuk</div></td>
  <td valign="top" style="padding-right:36px">${f('Hari & Tanggal', idDate(o.edate))}${f('Waktu', o.stime + ' WIB')}${f('Lokasi', o.location)}
   ${f('Nama', o.uname)}${f('Gereja / Asal', o.church || '-')}${f('Jumlah Tiket', o.qty + ' orang')}${f(o.kind === 'walk_in' ? 'Nomor Walk-In' : 'Nomor Pesanan', o.order_code)}</td></tr></table>
  ${o.announcement ? `<div style="margin:14px 36px 0;padding:10px 14px;background:#f1f0ff;border-radius:6px;font-size:10.5px;color:#333"><b>Pengumuman:</b> ${esc(o.announcement)}</div>` : ''}
  ${o.kind === 'walk_in' ? `<div style="margin:10px 36px 0;padding:8px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:6px;font-size:10.5px;color:#065f46"><b>Pendaftaran di Tempat (Walk-In):</b> Tiket ini diterbitkan langsung di lokasi acara.</div>` : ''}
  ${termsHtml}
  </body></html>`;
  return HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf').setName('E-Tiket-' + o.ticket_code + '.pdf');
}
function sendTicketEmail(o) {
  const row = (l, v) => `<tr><td style="padding:6px 0;color:#667">${l}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${esc(v)}</td></tr>`;
  return sendMail({
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
const INV_SQL = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_age,
    e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions
    FROM orders o JOIN events e ON e.id=o.event_id`;
function invitations() { return q(INV_SQL + " WHERE o.kind='invitation' ORDER BY o.created_at DESC LIMIT 500"); }

function getInvConfig(u) {
  const r = q(`SELECT value FROM settings WHERE key='invitation_max_qty'`)[0];
  const maxQty = r ? parseInt(r.value, 10) : (parseInt(P.getProperty('INVITATION_MAX_QTY'), 10) || 50);
  return { maxQty: (maxQty >= 1 && maxQty <= 1000) ? maxQty : 50 };
}

function setInvMaxQty(u, p) {
  const maxQty = parseInt(p.maxQty, 10);
  if (isNaN(maxQty) || maxQty < 1 || maxQty > 1000) throw new Error('BAD_MAX_QTY');
  q(`INSERT INTO settings(key, value, updated_at) VALUES('invitation_max_qty', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now() RETURNING key`, [String(maxQty)]);
  return { maxQty: maxQty };
}

function invitationCreate(u, p) {                // undangan memakai kuota yang sama dengan pesanan biasa
  ensureWalkinSchema();
  const cfg = getInvConfig(u);
  const maxAllowed = cfg.maxQty || 50;
  const name = String(p.name || '').trim().slice(0, 120), org = String(p.org || '').trim().slice(0, 120), qty = parseInt(p.qty, 10) || 1;
  let phone = String(p.phone || '').trim();
  if (phone) {
    phone = normPhone(phone);
    if (!phone) throw new Error('BAD_PHONE');
  } else {
    phone = null;
  }
  let age = p.age != null && String(p.age).trim() !== '' ? parseInt(p.age, 10) : null;
  if (age !== null && (isNaN(age) || age < 1 || age > 120)) throw new Error('BAD_AGE');

  if (name.length < 2) throw new Error('BAD_NAME');
  if (org.length < 2) throw new Error('BAD_ORG');
  if (!(qty >= 1 && qty <= maxAllowed)) throw new Error('BAD_QTY');
  const ev = q(`SELECT name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
  const ins = `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org,guest_phone,guest_age)
    SELECT $1,$2,$3::uuid,e.id,$4::int,0,'confirmed','invitation',$6::text,$7::text,$8::text,$9::int FROM events e WHERE e.id=$5::uuid
     AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled') + $4::int <= e.quota
    RETURNING id`;
  const res = neon([
    { query: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [p.eventId] },
    { query: wrap(ins), params: [rnd(8), 'TKT-' + prefix + '-' + rnd(6), u.id, qty, p.eventId, name, org, phone, age] }
  ]);
  const row = rowsOf(res[1])[0];
  if (!row) throw new Error('SOLDOUT');
  return q(INV_SQL + ' WHERE o.id=$1::uuid', [row.id])[0];
}
function ensureWaitingSchema() {
  neon([{ query: `CREATE TABLE IF NOT EXISTS invitation_waiting_list (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    created_by uuid REFERENCES users(id) ON DELETE SET NULL,
    guest_name text NOT NULL,
    guest_org text NOT NULL,
    guest_phone text,
    guest_age integer,
    qty integer NOT NULL DEFAULT 1,
    status text NOT NULL DEFAULT 'waiting',
    order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
    promoted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )` }]);
}

function waitingList(u, p) {
  ensureWaitingSchema();
  const evId = p && p.eventId ? String(p.eventId).trim() : '';
  const filterEv = evId ? ` AND w.event_id='` + evId + `'::uuid` : '';
  return q(`SELECT w.id, w.event_id, w.guest_name, w.guest_org, w.guest_phone, w.guest_age, w.qty, w.status, w.order_id,
      w.created_at, e.name AS event_name, e.event_date,
      (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining
    FROM invitation_waiting_list w
    JOIN events e ON e.id=w.event_id
    WHERE w.status='waiting'` + filterEv + `
    ORDER BY w.created_at ASC`);
}

function waitingCreate(u, p) {
  ensureWaitingSchema();
  const cfg = getInvConfig(u);
  const maxAllowed = cfg.maxQty || 50;
  const name = String(p.name || '').trim().slice(0, 120),
        org = String(p.org || '').trim().slice(0, 120),
        qty = parseInt(p.qty, 10) || 1;
  let phone = String(p.phone || '').trim();
  if (phone) {
    phone = normPhone(phone);
    if (!phone) throw new Error('BAD_PHONE');
  } else {
    phone = null;
  }
  let age = p.age != null && String(p.age).trim() !== '' ? parseInt(p.age, 10) : null;
  if (age !== null && (isNaN(age) || age < 1 || age > 120)) throw new Error('BAD_AGE');

  if (name.length < 2) throw new Error('BAD_NAME');
  if (org.length < 2) throw new Error('BAD_ORG');
  if (!(qty >= 1 && qty <= maxAllowed)) throw new Error('BAD_QTY');
  const ev = q(`SELECT id, name FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');

  const r = q(`INSERT INTO invitation_waiting_list(event_id, created_by, guest_name, guest_org, guest_phone, guest_age, qty, status, created_at)
    VALUES($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'waiting', now()) RETURNING id`,
    [ev.id, u.id, name, org, phone, age, qty]);
  return { id: r[0].id, name: name, qty: qty, eventId: ev.id };
}

function waitingUpdate(u, p) {
  ensureWaitingSchema();
  if (!p || !p.id) throw new Error('MISSING_ID');
  const cfg = getInvConfig(u);
  const maxAllowed = cfg.maxQty || 50;

  const item = q(`SELECT * FROM invitation_waiting_list WHERE id=$1::uuid`, [p.id])[0];
  if (!item) throw new Error('NOT_FOUND');

  const name = p.name !== undefined ? String(p.name).trim() : item.guest_name;
  const org = p.org !== undefined ? String(p.org).trim() : item.guest_org;
  const phone = p.phone !== undefined ? normPhone(p.phone) : item.guest_phone;
  const age = p.age !== undefined ? (p.age ? parseInt(p.age, 10) : null) : item.guest_age;
  let qty = p.qty !== undefined ? parseInt(p.qty, 10) : item.qty;

  if (!name) throw new Error('BAD_NAME');
  if (p.phone && !phone) throw new Error('BAD_PHONE');
  if (isNaN(qty) || qty < 1) qty = 1;
  if (qty > maxAllowed) throw new Error('MAX_QTY_EXCEEDED');

  q(`UPDATE invitation_waiting_list
     SET guest_name=$1, guest_org=$2, guest_phone=$3, guest_age=$4, qty=$5
     WHERE id=$6::uuid RETURNING id`,
    [name, org, phone, age, qty, p.id]);

  return { id: p.id, name: name, org: org, phone: phone, age: age, qty: qty, eventId: item.event_id };
}

function waitingDelete(u, p) {
  ensureWaitingSchema();
  q(`DELETE FROM invitation_waiting_list WHERE id=$1::uuid RETURNING id`, [p.id]);
  return true;
}

function waitingPromote(u, p) {
  ensureWaitingSchema();
  const item = q(`SELECT * FROM invitation_waiting_list WHERE id=$1::uuid AND status='waiting'`, [p.id])[0];
  if (!item) throw new Error('NOT_FOUND');

  const invOrder = invitationCreate(u, {
    eventId: item.event_id,
    name: item.guest_name,
    org: item.guest_org,
    phone: item.guest_phone,
    age: item.guest_age,
    qty: item.qty
  });

  q(`UPDATE invitation_waiting_list SET status='promoted', order_id=$1::uuid, promoted_at=now() WHERE id=$2::uuid RETURNING id`,
    [invOrder.id, item.id]);

  return invOrder;
}

function waitingPromoteAll(u, p) {
  ensureWaitingSchema();
  const evId = p && p.eventId ? String(p.eventId).trim() : '';
  const filterEv = evId ? ` AND event_id='` + evId + `'::uuid` : '';
  const items = q(`SELECT * FROM invitation_waiting_list WHERE status='waiting'` + filterEv + ` ORDER BY created_at ASC`);
  if (!items.length) return { promoted: 0, failed: 0, items: [] };

  let successCount = 0;
  let failedCount = 0;
  const createdOrders = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const invOrder = invitationCreate(u, {
        eventId: item.event_id,
        name: item.guest_name,
        org: item.guest_org,
        phone: item.guest_phone,
        age: item.guest_age,
        qty: item.qty
      });
      q(`UPDATE invitation_waiting_list SET status='promoted', order_id=$1::uuid, promoted_at=now() WHERE id=$2::uuid RETURNING id`,
        [invOrder.id, item.id]);
      createdOrders.push(invOrder);
      successCount++;
    } catch (err) {
      Logger.log('Promote all error at item ' + item.id + ': ' + err);
      failedCount++;
      break;
    }
  }

  return { promoted: successCount, failed: failedCount, total: items.length, orders: createdOrders };
}

function getCheckinPin(u) {
  const r = q(`SELECT value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI') AS updated_at FROM settings WHERE key='checkin_pin'`)[0];
  const custom = r ? r.value : (P.getProperty('CHECKIN_PIN') || P.getProperty('CHECKIN_PASSWORD') || '');
  return { pin: custom || '', isCustom: !!custom, updated: r ? r.updated_at : null };
}

function setCheckinPin(u, p) {
  const pin = String(p.pin || '').trim();
  if (p.reset || !pin) {
    q(`DELETE FROM settings WHERE key='checkin_pin' RETURNING key`);
    return { pin: '', isCustom: false };
  }
  if (pin.length < 4 || pin.length > 50) throw new Error('BAD_PIN');
  q(`INSERT INTO settings(key, value, updated_at) VALUES('checkin_pin', $1, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now() RETURNING key`, [pin]);
  return { pin: pin, isCustom: true };
}

function verifyCheckinPassword(u, pw) {          // PIN khusus check-in atau password SUPER ADMIN; 5 kali salah -> terkunci 10 menit
  const cache = CacheService.getScriptCache(), key = 'ci:' + u.id, n = parseInt(cache.get(key) || '0', 10);
  if (n >= 5) throw new Error('LOCKED');

  const inputPw = String(pw || '').trim();
  let ok = false;

  // 1. Cek PIN khusus check-in di settings / Script Properties
  const r = q(`SELECT value FROM settings WHERE key='checkin_pin'`)[0];
  const customPin = r ? r.value : (P.getProperty('CHECKIN_PIN') || P.getProperty('CHECKIN_PASSWORD') || '');
  if (customPin && inputPw === customPin.trim()) {
    ok = true;
  }

  // 2. Fallback: jika belum cocok, periksa password super admin mana pun (master password)
  if (!ok) {
    const rows = q(`SELECT password_hash FROM users WHERE role='super_admin'`);
    for (let i = 0; i < rows.length && !ok; i++) ok = checkPw(inputPw, rows[i].password_hash);
  }

  if (!ok) { cache.put(key, String(n + 1), 600); throw new Error('BAD_PASSWORD'); }
  cache.remove(key);
}
function verifySuperPassword(u, pw) { return verifyCheckinPassword(u, pw); }

function checkinOrder(u, p) {                    // cek in manual = sama seperti scan QR, wajib PIN check-in / password super admin
  verifyCheckinPassword(u, p.password);
  const o = q(`SELECT ticket_code FROM orders WHERE id=$1::uuid`, [p.id])[0];
  if (!o) throw new Error('NOT_FOUND');
  return validate(u, { code: o.ticket_code });
}

/* ---------- Walk-In (Pendaftaran di Tempat dengan Kuota Terpisah) ---------- */
function walkinCreate(u, p) {
  ensureWalkinSchema();
  const name = String(p.name || '').trim().slice(0, 120);
  const org = String(p.church || p.org || '').trim().slice(0, 120);
  const phone = normPhone(p.whatsapp || p.phone || '');
  const email = String(p.email || '').trim().toLowerCase();
  const age = p.age != null && String(p.age).trim() !== '' ? parseInt(p.age, 10) : null;
  const qty = parseInt(p.qty, 10) || 1;
  const autoCheckin = p.autoCheckin !== false; // default true: langsung check-in saat registrasi di gerbang

  if (name.length < 2) throw new Error('BAD_NAME');
  if (!(qty >= 1 && qty <= 50)) throw new Error('BAD_QTY');

  const ev = q(`SELECT id, name, is_active, coalesce(walkin_quota, 0)::int AS walkin_quota FROM events WHERE id=$1::uuid`, [p.eventId])[0];
  if (!ev) throw new Error('NOT_FOUND');
  if (!ev.is_active) throw new Error('INACTIVE');
  if (ev.walkin_quota <= 0) throw new Error('WALKIN_DISABLED');

  const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'WALK');
  const ticketCode = 'TKT-WLK-' + prefix.slice(0, 3) + '-' + rnd(5);
  const orderCode = 'WLK-' + rnd(7);

  const ins = `INSERT INTO orders(order_code, ticket_code, user_id, event_id, qty, total, status, kind, guest_name, guest_org, guest_phone, guest_email, guest_age, checked_in, checked_in_at, checked_in_by)
    SELECT $1, $2, $3::uuid, e.id, $4::int, 0, 'confirmed', 'walk_in', $6::text, $7::text, $8::text, $9::text, $10::int,
      CASE WHEN $11::boolean THEN $4::int ELSE 0 END,
      CASE WHEN $11::boolean THEN now() ELSE NULL END,
      CASE WHEN $11::boolean THEN $3::uuid ELSE NULL END
    FROM events e WHERE e.id=$5::uuid AND e.is_active
      AND (coalesce(e.walkin_quota, 0) - coalesce((SELECT sum(qty) FROM orders WHERE event_id=e.id AND status<>'cancelled' AND kind='walk_in'), 0)) >= $4::int
    RETURNING id`;

  const res = neon([
    { query: 'SELECT pg_advisory_xact_lock(hashtext($1))', params: [p.eventId] },
    { query: wrap(ins), params: [orderCode, ticketCode, u.id, qty, p.eventId, name, org, phone, email, age, autoCheckin] }
  ]);
  const row = rowsOf(res[1])[0];
  if (!row) throw new Error('WALKIN_SOLDOUT');

  if (email && EMAIL_RE.test(email)) {
    try {
      const o = orderFull(row.id);
      sendTicketEmail(o);
      q(`UPDATE orders SET emailed=true, emailed_at=now() WHERE id=$1::uuid RETURNING id`, [row.id]);
    } catch (e) {
      Logger.log('Walk-in email notice err: ' + e);
    }
  }

  return orderFull(row.id);
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
    "ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS emailed boolean DEFAULT true",
    "ALTER TABLE orders ALTER COLUMN emailed SET DEFAULT false",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS email_error text",
    "ALTER TABLE orders ADD COLUMN IF NOT EXISTS emailed_at timestamptz"
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

/* ---------- Survey Kepuasan & Feedback Peserta ---------- */
function surveyInfo(p) { return pubRun(surveyInfoImpl, p); }
function surveyInfoImpl(p) {
  const evId = String(p && p.eventId || '').trim();
  const fid = String(p && p.feedbackId || '').trim();
  const clientToken = String(p && (p.clientToken || p.deviceId) || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  const ev = q(`SELECT id, name, banner_url, event_date::text AS edate, to_char(start_time,'HH24:MI') AS stime, location FROM events WHERE id=$1::uuid`, [evId])[0];
  if (!ev) throw new Error('EVENT_NOT_FOUND');
  let myFeedback = null;
  if (fid) {
    myFeedback = q(`SELECT id, rating AS rating_overall, coalesce(rating_content,5) AS rating_content, coalesce(rating_service,5) AS rating_service, coalesce(rating_venue,5) AS rating_venue, coalesce(rating_sound,5) AS rating_sound, aspects, comment, is_anonymous, guest_name, guest_org FROM event_feedbacks WHERE id=$1::uuid AND event_id=$2::uuid`, [fid, evId])[0] || null;
  }
  if (!myFeedback && clientToken) {
    myFeedback = q(`SELECT id, rating AS rating_overall, coalesce(rating_content,5) AS rating_content, coalesce(rating_service,5) AS rating_service, coalesce(rating_venue,5) AS rating_venue, coalesce(rating_sound,5) AS rating_sound, aspects, comment, is_anonymous, guest_name, guest_org FROM event_feedbacks WHERE event_id=$1::uuid AND client_token=$2 ORDER BY created_at DESC LIMIT 1`, [evId, clientToken])[0] || null;
  }
  const cnt = q(`SELECT count(*)::int AS count FROM event_feedbacks WHERE event_id=$1::uuid`, [evId])[0];
  return { event: ev, count: cnt ? cnt.count : 0, myFeedback: myFeedback };
}

function surveyStagePoll(p) { return pubRun(surveyStagePollImpl, p); }
function surveyStagePollImpl(p) {
  const evId = String(p && p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  const ev = q(`SELECT id, name, banner_url, event_date::text AS edate FROM events WHERE id=$1::uuid`, [evId])[0];
  if (!ev) throw new Error('EVENT_NOT_FOUND');
  const stat = q(`SELECT count(*)::int AS count, coalesce(round(avg(rating)::numeric,1),0)::float AS avg FROM event_feedbacks WHERE event_id=$1::uuid`, [evId])[0];
  return { event: ev, count: stat ? stat.count : 0, avg: stat ? stat.avg : 0 };
}

function feedbackPublic(p) { return pubRun(feedbackPublicImpl, p); }
function feedbackPublicImpl(p) {
  const code = String(p && p.code || '').trim().toUpperCase();
  const eventId = String(p && p.eventId || '').trim();
  const clientToken = String(p && (p.clientToken || p.deviceId) || '').trim();
  const ratings = (p && (p.ratings || p.aspects)) || {};
  const rOverall = Math.min(Math.max(parseInt(ratings.overall || (p && p.rating), 10) || 5, 1), 5);
  const rContent = Math.min(Math.max(parseInt(ratings.content, 10) || 5, 1), 5);
  const rService = Math.min(Math.max(parseInt(ratings.service, 10) || 5, 1), 5);
  const rVenue   = Math.min(Math.max(parseInt(ratings.venue, 10) || 5, 1), 5);
  const rSound   = Math.min(Math.max(parseInt(ratings.sound, 10) || 5, 1), 5);
  const aspectsJson = JSON.stringify({ overall: rOverall, content: rContent, service: rService, venue: rVenue, sound: rSound });
  const category = String(p && p.category || 'Umum').trim() || 'Umum';
  const comment = String(p && p.comment || '').trim();
  const isAnon = !!(p && p.isAnonymous);
  let targetEventId = eventId, targetOrderId = null, gName = '', gOrg = '';
  if (code) {
    const ord = q(`SELECT o.id, o.event_id, CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name, CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.ticket_code=$1`, [code])[0];
    if (ord) { targetOrderId = ord.id; targetEventId = ord.event_id; gName = ord.name || ''; gOrg = ord.org || ''; }
  }
  if (!targetEventId) throw new Error('EVENT_NOT_FOUND');

  // 1. Edit existing feedback if feedbackId provided
  if (p && p.feedbackId) {
    const fid = String(p.feedbackId).trim();
    const upd = q(`UPDATE event_feedbacks SET rating=$1, rating_content=$2, rating_service=$3, rating_venue=$4, rating_sound=$5, aspects=$6::jsonb, is_anonymous=$7, guest_name=$8, guest_org=$9, comment=$10, client_token=coalesce(nullif($11,''),client_token), created_at=now() WHERE id=$12::uuid AND event_id=$13::uuid RETURNING id`, [rOverall, rContent, rService, rVenue, rSound, aspectsJson, isAnon, isAnon ? '' : (gName || (p.guestName || '')), isAnon ? '' : (gOrg || (p.guestOrg || '')), comment, clientToken, fid, targetEventId]);
    if (upd.length) return { success: true, id: upd[0].id, updated: true };
  }

  // 2. Anti-duplication by clientToken
  if (clientToken) {
    const existing = q(`SELECT id FROM event_feedbacks WHERE event_id=$1::uuid AND client_token=$2 ORDER BY created_at DESC LIMIT 1`, [targetEventId, clientToken]);
    if (existing.length) {
      const upd = q(`UPDATE event_feedbacks SET rating=$1, rating_content=$2, rating_service=$3, rating_venue=$4, rating_sound=$5, aspects=$6::jsonb, is_anonymous=$7, guest_name=$8, guest_org=$9, comment=$10, created_at=now() WHERE id=$11::uuid RETURNING id`, [rOverall, rContent, rService, rVenue, rSound, aspectsJson, isAnon, isAnon ? '' : (gName || (p.guestName || '')), isAnon ? '' : (gOrg || (p.guestOrg || '')), comment, existing[0].id]);
      return { success: true, id: upd[0].id, updated: true };
    }
  }

  const ins = q(`INSERT INTO event_feedbacks(event_id, order_id, ticket_code, guest_name, guest_org, is_anonymous, rating, rating_content, rating_service, rating_venue, rating_sound, aspects, category, comment, client_token) VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15) RETURNING id`, [targetEventId, targetOrderId, code, isAnon ? '' : (gName || (p && p.guestName || '')), isAnon ? '' : (gOrg || (p && p.guestOrg || '')), isAnon, rOverall, rContent, rService, rVenue, rSound, aspectsJson, category, comment, clientToken]);
  return { success: true, id: ins[0].id };
}

function feedbackDelete(u, p) {
  const id = String(p.id || '').trim();
  q(`DELETE FROM event_feedbacks WHERE id=$1::uuid`, [id]);
  return true;
}
function feedbackSubmit(u, p) {
  const eventId = String(p.eventId || '').trim();
  const orderId = p.orderId || null;
  const ratings = p.ratings || p.aspects || {};
  const rOverall = Math.min(Math.max(parseInt(ratings.overall || p.rating, 10) || 5, 1), 5);
  const rContent = Math.min(Math.max(parseInt(ratings.content, 10) || 5, 1), 5);
  const rService = Math.min(Math.max(parseInt(ratings.service, 10) || 5, 1), 5);
  const rVenue   = Math.min(Math.max(parseInt(ratings.venue, 10) || 5, 1), 5);
  const rSound   = Math.min(Math.max(parseInt(ratings.sound, 10) || 5, 1), 5);
  const aspectsJson = JSON.stringify({ overall: rOverall, content: rContent, service: rService, venue: rVenue, sound: rSound });
  const category = String(p.category || 'Umum').trim() || 'Umum';
  const comment = String(p.comment || '').trim();
  const isAnon = !!p.isAnonymous;
  const code = String(p.code || p.ticketCode || '').trim().toUpperCase();
  q(`INSERT INTO event_feedbacks(event_id, order_id, user_id, ticket_code, guest_name, guest_org, is_anonymous, rating, rating_content, rating_service, rating_venue, rating_sound, aspects, category, comment) VALUES($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)`, [eventId, orderId, u.id, code, isAnon ? '' : u.name, isAnon ? '' : u.church, isAnon, rOverall, rContent, rService, rVenue, rSound, aspectsJson, category, comment]);
  return { success: true };
}
function feedbacksGet(u, p) {
  const evId = String(p.eventId || '').trim();
  let sql = `SELECT f.id, f.event_id, e.name AS event_name, f.rating AS rating_overall, coalesce(f.rating_content, 5) AS rating_content, coalesce(f.rating_service, 5) AS rating_service, coalesce(f.rating_venue, 5) AS rating_venue, coalesce(f.rating_sound, 5) AS rating_sound, f.aspects, f.rating, f.category, f.comment, f.is_anonymous, CASE WHEN f.is_anonymous THEN 'Anonim' ELSE coalesce(nullif(f.guest_name,''),'Peserta') END AS author_name, CASE WHEN f.is_anonymous THEN '' ELSE f.guest_org END AS author_org, to_char(f.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI') AS created_at_fmt FROM event_feedbacks f JOIN events e ON e.id=f.event_id`;
  const qArgs = [];
  if (evId) { sql += ` WHERE f.event_id=$1::uuid`; qArgs.push(evId); }
  sql += ` ORDER BY f.created_at DESC LIMIT 300`;
  const rows = q(sql, qArgs);
  const total = rows.length;
  const sumOverall = rows.reduce((acc, r) => acc + (r.rating_overall || r.rating || 0), 0);
  const sumContent = rows.reduce((acc, r) => acc + (r.rating_content || 5), 0);
  const sumService = rows.reduce((acc, r) => acc + (r.rating_service || 5), 0);
  const sumVenue   = rows.reduce((acc, r) => acc + (r.rating_venue || 5), 0);
  const sumSound   = rows.reduce((acc, r) => acc + (r.rating_sound || 5), 0);

  const aspectAvgs = {
    overall: total ? Math.round((sumOverall / total) * 10) / 10 : 0,
    content: total ? Math.round((sumContent / total) * 10) / 10 : 0,
    service: total ? Math.round((sumService / total) * 10) / 10 : 0,
    venue:   total ? Math.round((sumVenue / total) * 10) / 10 : 0,
    sound:   total ? Math.round((sumSound / total) * 10) / 10 : 0
  };

  const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let anonCount = 0;
  rows.forEach(r => {
    const rt = r.rating_overall || r.rating;
    if (dist[rt] !== undefined) dist[rt]++;
    if (r.is_anonymous) anonCount++;
  });
  return { rows: rows, total: total, avg: aspectAvgs.overall, aspectAvgs: aspectAvgs, dist: dist, anonCount: anonCount };
}

/* ---------- Live Doorprize ---------- */
function doorprizePool(u, p) {
  const evId = String(p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_REQUIRED');
  const candidates = q(`SELECT o.id AS order_id, o.ticket_code, CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name, CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org, to_char(o.checked_in_at AT TIME ZONE 'Asia/Jakarta','HH24:MI:SS') AS checkin_time FROM orders o LEFT JOIN users u ON u.id = o.user_id WHERE o.event_id = $1::uuid AND o.status = 'confirmed' AND o.checked_in >= 1 ORDER BY o.checked_in_at DESC`, [evId]);
  const winners = q(`SELECT id, order_id, ticket_code, winner_name, winner_org, prize_name, to_char(drawn_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI:SS') AS drawn_at FROM doorprize_winners WHERE event_id=$1::uuid ORDER BY drawn_at DESC`, [evId]);
  return { candidates: candidates, winners: winners };
}
function doorprizeSaveWinner(u, p) {
  const evId = String(p.eventId || '').trim(), ordId = p.orderId || null, code = String(p.ticketCode || '').trim(), name = String(p.winnerName || '').trim(), org = String(p.winnerOrg || '').trim(), prize = String(p.prizeName || 'Doorprize').trim();
  if (!evId || !name) throw new Error('BAD_DATA');
  const r = q(`INSERT INTO doorprize_winners(event_id, order_id, ticket_code, winner_name, winner_org, prize_name) VALUES($1::uuid, $2, $3, $4, $5, $6) RETURNING id`, [evId, ordId, code, name, org, prize]);
  return { id: r[0].id };
}
function doorprizeDeleteWinner(u, p) {
  const id = String(p.id || '').trim();
  q(`DELETE FROM doorprize_winners WHERE id=$1::uuid`, [id]);
  return true;
}
function doorprizeResetAll(u, p) {
  const evId = String(p.eventId || '').trim();
  q(`DELETE FROM doorprize_winners WHERE event_id=$1::uuid`, [evId]);
  return true;
}

function checkpointsGet(u, p) {
  const evId = String(p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  ensureDefaultCheckpointsGS(evId);

  const includeAll = p.all === true || p.all === 'true' || p.all === 1;
  const r = q(`
    SELECT cp.id, cp.event_id, cp.checkpoint_key, cp.name, cp.icon, cp.checkpoint_type, cp.is_active, cp.sort_order,
      coalesce(cp.description, '') AS description,
      coalesce(sum(cl.qty), 0)::int AS claimed_count
    FROM event_checkpoints cp
    LEFT JOIN checkpoint_claims cl ON cl.event_id=cp.event_id AND cl.checkpoint_key=cp.checkpoint_key
    WHERE cp.event_id=$1::uuid ${includeAll ? '' : 'AND cp.is_active=true'}
    GROUP BY cp.id, cp.event_id, cp.checkpoint_key, cp.name, cp.icon, cp.checkpoint_type, cp.is_active, cp.sort_order, cp.description
    ORDER BY cp.sort_order, cp.created_at
  `, [evId]);

  const gateStat = q(`
    SELECT coalesce(sum(qty), 0)::int AS booked,
           coalesce(sum(checked_in), 0)::int AS checked_in
    FROM orders WHERE event_id=$1::uuid AND status='confirmed'
  `, [evId])[0] || { booked: 0, checked_in: 0 };

  return {
    checkpoints: r,
    gate_checked_in: gateStat.checked_in || 0,
    total_registered: gateStat.booked || 0,
    gateStat: gateStat
  };
}

function checkpointSave(u, p) {
  const evId = String(p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  const name = String(p.name || '').trim();
  if (!name) throw new Error('NAME_REQUIRED');
  const icon = String(p.icon || '📍').trim();
  const type = String(p.checkpointType || p.type || 'facility').trim();
  const desc = String(p.description || '').trim();
  const isActive = p.isActive !== false && p.is_active !== false;
  const sortOrder = parseInt(p.sortOrder != null ? p.sortOrder : (p.sort_order != null ? p.sort_order : 10), 10) || 10;
  const key = String(p.checkpointKey || p.key || ('cp_' + Date.now().toString(36))).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

  if (p.id) {
    q(`UPDATE event_checkpoints SET name=$1, icon=$2, checkpoint_type=$3, is_active=$4, sort_order=$5, description=$6 WHERE id=$7::uuid AND event_id=$8::uuid`,
      [name, icon, type, isActive, sortOrder, desc, p.id, evId]);
  } else {
    q(`INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, is_active, sort_order, description)
      VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (event_id, checkpoint_key) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon, checkpoint_type=EXCLUDED.checkpoint_type, is_active=EXCLUDED.is_active, sort_order=EXCLUDED.sort_order, description=EXCLUDED.description`,
      [evId, key, name, icon, type, isActive, sortOrder, desc]);
  }
  return true;
}

function checkpointDelete(u, p) {
  const id = p.id;
  const key = p.checkpointKey || p.key;
  const evId = p.eventId;
  if (!id && !key) throw new Error('ID_REQUIRED');
  if (id) {
    const cp = q(`SELECT checkpoint_key FROM event_checkpoints WHERE id=$1::uuid`, [id])[0];
    if (cp && cp.checkpoint_key === 'main_gate') throw new Error('CANNOT_DELETE_MAIN_GATE');
    q(`DELETE FROM event_checkpoints WHERE id=$1::uuid`, [id]);
  } else if (key && evId) {
    if (key === 'main_gate') throw new Error('CANNOT_DELETE_MAIN_GATE');
    q(`DELETE FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2`, [evId, key]);
  }
  return true;
}

function checkpointsResetDefaults(u, p) {
  const evId = String(p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  q(`DELETE FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key NOT IN (SELECT DISTINCT checkpoint_key FROM checkpoint_claims WHERE event_id=$1::uuid)`, [evId]);
  const DEFAULT_CPS = [
    { key: 'main_gate', name: 'Pintu Masuk Utama', icon: '🎟️', type: 'gate', sort_order: 1 },
    { key: 'meal', name: 'Konsumsi (Lunch/Dinner/Snack)', icon: '🍱', type: 'meal', sort_order: 2 },
    { key: 'kit', name: 'Souvenir / Seminar Kit', icon: '🎁', type: 'kit', sort_order: 3 },
    { key: 'breakout', name: 'Breakout Session / Ruang Kelas', icon: '🚪', type: 'session', sort_order: 4 },
    { key: 'voucher', name: 'Voucher Diskon Bazaar', icon: '🏷️', type: 'voucher', sort_order: 5 }
  ];
  for (const cp of DEFAULT_CPS) {
    q(`INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, sort_order)
      VALUES($1::uuid, $2, $3, $4, $5, $6) ON CONFLICT (event_id, checkpoint_key) DO UPDATE SET is_active=true, name=EXCLUDED.name, icon=EXCLUDED.icon`,
      [evId, cp.key, cp.name, cp.icon, cp.type, cp.sort_order]);
  }
  return true;
}

function ticketFacilities(p) { return pubRun(ticketFacilitiesImpl, p); }
function ticketFacilitiesImpl(p) {
  const code = String(p && p.code || '').trim().toUpperCase().replace(/\s/g, '');
  if (!code) throw new Error('NOT_FOUND');
  const ord = q(`SELECT id, event_id, status, checked_in, checked_in_at, qty FROM orders WHERE ticket_code=$1`, [code])[0];
  if (!ord) return { items: [] };

  ensureDefaultCheckpointsGS(ord.event_id);

  const checkpoints = q(`
    SELECT cp.checkpoint_key, cp.name, cp.icon, cp.checkpoint_type,
      cl.claimed_at, cl.qty AS claimed_qty
    FROM event_checkpoints cp
    LEFT JOIN checkpoint_claims cl ON cl.event_id=cp.event_id AND cl.checkpoint_key=cp.checkpoint_key AND cl.order_id=$1::uuid
    WHERE cp.event_id=$2::uuid AND cp.is_active=true
    ORDER BY cp.sort_order, cp.created_at
  `, [ord.id, ord.event_id]);

  const items = checkpoints.map(cp => {
    let status = 'ready';
    if (cp.checkpoint_key === 'main_gate') {
      status = ord.checked_in > 0 ? 'claimed' : 'ready';
    } else if (cp.claimed_at) {
      status = 'claimed';
    } else if (ord.checked_in <= 0) {
      status = 'gate_required';
    }
    return {
      key: cp.checkpoint_key,
      name: cp.name,
      icon: cp.icon,
      type: cp.checkpoint_type,
      status: status,
      claimed_at: cp.claimed_at || (cp.checkpoint_key === 'main_gate' ? ord.checked_in_at : null),
      qty: cp.claimed_qty || ord.qty
    };
  });

  return { items: items };
}

function sessionStageLiveCount(p) { return pubRun(sessionStageLiveCountImpl, p); }
function sessionStageLiveCountImpl(p) {
  const evId = String(p && p.eventId || '').trim();
  const cpKey = String(p && p.checkpointKey || '').trim();
  if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
  const countRes = q(`
    SELECT count(DISTINCT order_id)::int AS cnt
    FROM checkpoint_claims
    WHERE event_id=$1::uuid AND checkpoint_key=$2
  `, [evId, cpKey])[0];
  return { count: countRes ? countRes.cnt : 0 };
}

function checkpointPublicInfo(p) { return pubRun(checkpointPublicInfoImpl, p); }
function checkpointPublicInfoImpl(p) {
  const evId = String(p && p.eventId || '').trim();
  const cpKey = String(p && p.checkpointKey || '').trim();
  if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
  const ev = q(`SELECT id, name, event_date, banner_url, location, start_time FROM events WHERE id=$1::uuid`, [evId])[0];
  if (!ev) throw new Error('EVENT_NOT_FOUND');
  const cp = q(`SELECT * FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2 AND is_active=true`, [evId, cpKey])[0];
  if (!cp) throw new Error('CHECKPOINT_NOT_FOUND');
  const liveCnt = q(`SELECT count(DISTINCT order_id)::int AS cnt FROM checkpoint_claims WHERE event_id=$1::uuid AND checkpoint_key=$2`, [evId, cpKey])[0];
  return { event: ev, checkpoint: cp, attendeesCount: liveCnt ? liveCnt.cnt : 0 };
}

function sessionSelfCheckin(p) { return pubRun(sessionSelfCheckinImpl, p); }
function sessionSelfCheckinImpl(p) {
  const evId = String(p && p.eventId || '').trim();
  const cpKey = String(p && p.checkpointKey || '').trim();
  const rawInput = String(p && (p.ticketCode || p.code || p.phone || '')).trim();

  if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
  if (!rawInput) throw new Error('TICKET_OR_PHONE_REQUIRED');

  const cp = q(`SELECT * FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2 AND is_active=true`, [evId, cpKey])[0];
  if (!cp) return { ok: false, error: 'CHECKPOINT_NOT_FOUND', message: 'Sesi / pos check-in ini tidak aktif atau tidak ditemukan.' };

  const ev = q(`SELECT id, name FROM events WHERE id=$1::uuid`, [evId])[0];
  if (!ev) return { ok: false, error: 'EVENT_NOT_FOUND', message: 'Acara tidak ditemukan.' };

  let ord = null;
  const cleanInput = rawInput.toUpperCase().replace(/\s/g, '');
  const cleanDigits = rawInput.replace(/[^0-9]/g, '');

  if (cleanInput.startsWith('TKT-') || cleanInput.length >= 6) {
    ord = q(`
      SELECT o.*, u.name AS user_name, u.whatsapp AS user_phone, u.church AS user_church
      FROM orders o
      LEFT JOIN users u ON u.id=o.user_id
      WHERE o.event_id=$1::uuid AND (upper(o.ticket_code)=$2 OR upper(o.order_code)=$2) AND o.status='confirmed'
      LIMIT 1
    `, [evId, cleanInput])[0];
  }

  if (!ord && cleanDigits.length >= 8) {
    const suffix = cleanDigits.slice(-8);
    ord = q(`
      SELECT o.*, u.name AS user_name, u.whatsapp AS user_phone, u.church AS user_church
      FROM orders o
      LEFT JOIN users u ON u.id=o.user_id
      WHERE o.event_id=$1::uuid AND o.status='confirmed' AND (
        replace(replace(coalesce(o.guest_phone, ''), '+', ''), ' ', '') LIKE '%' || $2 || '%' OR
        replace(replace(coalesce(u.whatsapp, ''), '+', ''), ' ', '') LIKE '%' || $2 || '%'
      )
      ORDER BY o.created_at DESC LIMIT 1
    `, [evId, suffix])[0];
  }

  if (!ord) {
    return {
      ok: false,
      error: 'NOT_FOUND',
      message: 'Tiket tidak ditemukan untuk acara ini. Pastikan Kode Tiket atau Nomor WhatsApp terdaftar sudah benar.'
    };
  }

  const attendeeName = (ord.kind === 'invitation' || ord.kind === 'walk_in') ? (ord.guest_name || 'Peserta') : (ord.user_name || 'Peserta');
  const attendeeOrg = (ord.kind === 'invitation' || ord.kind === 'walk_in') ? (ord.guest_org || '') : (ord.user_church || '');

  if (cpKey !== 'main_gate' && (ord.checked_in || 0) <= 0) {
    return {
      ok: false,
      error: 'NOT_CHECKED_IN',
      message: 'Anda belum melakukan check-in di Pintu Gerbang Utama. Silakan registrasi di meja kedatangan depan terlebih dahulu.',
      attendeeName: attendeeName,
      checkpoint: cp
    };
  }

  const existingClaim = q(`SELECT * FROM checkpoint_claims WHERE order_id=$1::uuid AND checkpoint_key=$2`, [ord.id, cpKey])[0];
  if (existingClaim) {
    const claimedTime = new Date(existingClaim.claimed_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return {
      ok: false,
      error: 'ALREADY_CLAIMED',
      message: `Anda sudah tercatat hadir di ${cp.name} pada pukul ${claimedTime} WIB.`,
      attendeeName: attendeeName,
      checkpoint: cp,
      claimed_at: existingClaim.claimed_at
    };
  }

  const qtyToClaim = Math.max(1, ord.qty || 1);
  q(`
    INSERT INTO checkpoint_claims (event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by_name)
    VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'Presensi Mandiri (Self-Checkin)')
  `, [evId, cpKey, ord.id, ord.ticket_code, qtyToClaim]);

  return {
    ok: true,
    data: {
      result: 'VALID',
      eventName: ev.name,
      checkpoint: cp,
      attendeeName: attendeeName,
      attendeeOrg: attendeeOrg,
      ticketCode: ord.ticket_code,
      claimedQty: qtyToClaim,
      time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
    }
  };
}


function checkpointExportCsv(u, p) {
  const evId = String(p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_NOT_FOUND');
  return q(`
    SELECT to_char(cl.claimed_at AT TIME ZONE 'Asia/Jakarta', 'YYYY-MM-DD HH24:MI:SS') AS claim_time,
           e.name AS event_name,
           coalesce(cp.name, cl.checkpoint_key) AS checkpoint_name,
           coalesce(cp.icon, '📍') AS checkpoint_icon,
           cl.ticket_code,
           CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS attendee_name,
           CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS attendee_org,
           cl.qty AS claimed_qty,
           coalesce(cl.claimed_by_name, '') AS staff_name
    FROM checkpoint_claims cl
    JOIN events e ON e.id=cl.event_id
    JOIN orders o ON o.id=cl.order_id
    LEFT JOIN users u ON u.id=o.user_id
    LEFT JOIN event_checkpoints cp ON cp.event_id=cl.event_id AND cp.checkpoint_key=cl.checkpoint_key
    WHERE cl.event_id=$1::uuid
    ORDER BY cl.claimed_at DESC
  `, [evId]);
}

function certificateVerify(p) {
  var code = String(p && p.code || '').trim().toUpperCase().replace(/\s/g, '');
  if (!code) throw new Error('NOT_FOUND');
  var rows = neonQuery(`SELECT o.ticket_code, o.checked_in, o.checked_in_at,
    coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
    CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org,
    e.name AS event_name, e.event_date::text AS event_date, to_char(e.start_time, 'HH24:MI') AS start_time, e.location,
    coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
    coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config
    FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN users u ON u.id=o.user_id
    WHERE o.ticket_code=$1`, [code]);
  if (!rows || !rows.length) return { verified: false, code: code };
  var r = rows[0];
  var valid = r.enable_certificate && r.checked_in > 0;
  return {
    verified: valid,
    code: r.ticket_code,
    name: r.name,
    org: r.org,
    eventName: r.event_name,
    eventDate: r.event_date,
    startTime: r.start_time,
    location: r.location,
    checkedInAt: r.checked_in_at,
    config: r.certificate_config,
    customAnswers: r.custom_answers
  };
}

function organizerPublic(p) {
  var slug = String(p && p.slug || '').trim().toLowerCase();
  if (!slug) throw new Error('NOT_FOUND');
  var orgs = neonQuery(`SELECT id, name, slug, description, logo_url, contact_whatsapp, contact_email, is_verified FROM organizers WHERE lower(slug)=$1`, [slug]);
  if (!orgs || !orgs.length) return { found: false };
  var org = orgs[0];
  var events = neonQuery(`SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.terms,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining
    FROM events e WHERE e.organizer_id=$1::uuid AND e.is_active ORDER BY e.event_date, e.start_time`, [org.id]);
  return { found: true, organizer: org, events: events };
}




function organizersList(u) {
  var sql = `SELECT o.*,
    coalesce((SELECT count(e.id) FROM events e WHERE e.organizer_id=o.id), 0)::int AS event_count,
    coalesce((SELECT sum(ord.qty) FROM orders ord JOIN events ev ON ev.id=ord.event_id WHERE ev.organizer_id=o.id AND ord.status='confirmed'), 0)::int AS total_sold
    FROM organizers o `;
  var qParams = [];
  if (u.role === 2 && u.organizer_id) {
    sql += ` WHERE o.id = $1::uuid `;
    qParams.push(u.organizer_id);
  }
  sql += ` ORDER BY o.created_at ASC `;
  return neonQuery(sql, qParams);
}

function organizerSave(u, p) {
  var name = String(p.name || '').trim();
  if (!name) throw new Error('NAME_REQUIRED');
  var slug = String(p.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');

  var id = p.id ? String(p.id).trim() : null;
  if (u.role === 2) {
    if (!u.organizer_id || (id && id !== u.organizer_id)) throw new Error('FORBIDDEN');
    id = u.organizer_id;
  }

  var desc = String(p.description || '').trim();
  var logo = String(p.logo_url || '').trim();
  var banner = String(p.banner_url || '').trim();
  var email = String(p.contact_email || '').trim();
  var phone = String(p.contact_phone || '').trim();
  var bankName = String(p.bank_name || '').trim();
  var bankAcc = String(p.bank_account_no || '').trim();
  var bankHolder = String(p.bank_account_holder || '').trim();
  var isVerified = u.role >= 3 ? (p.is_verified !== false) : true;

  if (!id) {
    if (u.role < 3) throw new Error('FORBIDDEN');
    var r = neonQuery(`INSERT INTO organizers(name, slug, description, logo_url, banner_url, contact_email, contact_phone, bank_name, bank_account_no, bank_account_holder, is_verified)
      VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, logo_url=EXCLUDED.logo_url, banner_url=EXCLUDED.banner_url, contact_email=EXCLUDED.contact_email, contact_phone=EXCLUDED.contact_phone, bank_name=EXCLUDED.bank_name, bank_account_no=EXCLUDED.bank_account_no, bank_account_holder=EXCLUDED.bank_account_holder
      RETURNING id`, [name, slug, desc, logo, banner, email, phone, bankName, bankAcc, bankHolder, isVerified]);
    return r[0];
  } else {
    var r = neonQuery(`UPDATE organizers SET name=$1, slug=$2, description=$3, logo_url=$4, banner_url=$5, contact_email=$6, contact_phone=$7, bank_name=$8, bank_account_no=$9, bank_account_holder=$10, is_verified=$11 WHERE id=$12::uuid RETURNING id`, [name, slug, desc, logo, banner, email, phone, bankName, bankAcc, bankHolder, isVerified, id]);
    return r[0];
  }
}

function userAssignOrganizer(u, p) {
  if (u.role < 3) throw new Error('FORBIDDEN');
  var userId = String(p.userId || '').trim();
  var orgId = p.organizerId ? String(p.organizerId).trim() : null;
  var role = p.role !== undefined ? parseInt(p.role, 10) : undefined;
  if (!userId) throw new Error('USER_ID_REQUIRED');
  if (role !== undefined) {
    neonQuery(`UPDATE users SET organizer_id=$1, role=$2 WHERE id=$3::uuid`, [orgId, role, userId]);
  } else {
    neonQuery(`UPDATE users SET organizer_id=$1 WHERE id=$2::uuid`, [orgId, userId]);
  }
  return true;
}


function guestbookWall(p) {
  var evId = String(p && p.eventId || '').trim();
  if (!evId) throw new Error('EVENT_REQUIRED');
  var rows = neonQuery(`
    SELECT o.id, o.ticket_code, o.guestbook_message AS message, o.created_at,
      to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'HH24:MI') AS time_str,
      to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon YYYY') AS date_str,
      CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
      CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org,
      coalesce(o.table_assignment, '') AS table_assignment
    FROM orders o
    JOIN users u ON u.id = o.user_id
    WHERE o.event_id = $1::uuid AND o.guestbook_message <> '' AND o.status <> 'cancelled' AND o.status <> 'declined'
    ORDER BY o.created_at DESC
    LIMIT 100
  `, [evId]);
  var evs = neonQuery(`SELECT id, name, banner_url, coalesce(active_modules, '["ticketing"]'::jsonb) AS active_modules FROM events WHERE id=$1::uuid`, [evId]);
  return { messages: rows, event: evs && evs[0] ? evs[0] : null };
}

function assignTable(u, p) {
  var ordId = String(p.orderId || '').trim();
  var table = String(p.tableAssignment || '').trim();
  if (!ordId) throw new Error('ORDER_ID_REQUIRED');
  neonQuery(`UPDATE orders SET table_assignment=$1 WHERE id=$2::uuid`, [table, ordId]);
  return true;
}


function digitalInvitationInfo(p) {
        const code = String(p && (p.code || p.invite || p.undangan) || '').trim();
        if (!code) throw new Error('CODE_REQUIRED');
  ensureFeatureTables();

        // Check if code matches an order (ticket_code, order_code, id)
        const ordRows = neonQuery( `
          SELECT o.id, o.order_code, o.ticket_code, o.qty, o.total, o.status, o.checked_in, o.checked_in_at, o.kind,
            coalesce(o.rsvp_status, 'pending') AS rsvp_status,
            coalesce(o.plus_one_count, 0)::int AS plus_one_count,
            coalesce(o.guestbook_message, '') AS guestbook_message,
            coalesce(o.table_assignment, '') AS table_assignment,
            coalesce(o.guest_name, u.name) AS guest_name,
            coalesce(o.guest_org, u.church) AS guest_org,
            coalesce(o.guest_phone, u.whatsapp) AS guest_phone,
            e.id AS event_id, e.name AS event_name, e.category, e.banner_url, e.description,
            e.event_date::text AS event_date, to_char(e.start_time, 'HH24:MI') AS start_time, to_char(e.end_time, 'HH24:MI') AS end_time,
            e.location, e.announcement, e.terms,
            coalesce(e.active_modules, '["ticketing"]'::jsonb) AS active_modules,
            coalesce(e.module_config, '{}'::jsonb) AS module_config,
            coalesce(org.name, 'Ambiltiketnya') AS organizer_name,
            coalesce(org.logo_url, '') AS organizer_logo
          FROM orders o
          JOIN events e ON e.id = o.event_id
          LEFT JOIN users u ON u.id = o.user_id
          LEFT JOIN organizers org ON org.id = e.organizer_id
          WHERE o.ticket_code = $1 OR o.order_code = $1 OR o.id::text = $1
          LIMIT 1
        `, [code]);

        if (ordRows.length) {
          const o = ordRows[0];
          const wishes = neonQuery( `
            SELECT coalesce(o.guest_name, u.name) AS name, coalesce(o.guest_org, u.church) AS org,
              o.guestbook_message AS message, to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon HH24:MI') AS time_str
            FROM orders o
            LEFT JOIN users u ON u.id = o.user_id
            WHERE o.event_id = $1::uuid AND o.guestbook_message <> '' AND o.status <> 'cancelled' AND o.status <> 'declined'
            ORDER BY o.created_at DESC LIMIT 15
          `, [o.event_id]);
          return { found: true, type: 'order', order: o, wishes } });
        }

        // Check if code matches an event ID
        const evRows = neonQuery( `
          SELECT e.id, e.name AS event_name, e.category, e.banner_url, e.description,
            e.event_date::text AS event_date, to_char(e.start_time, 'HH24:MI') AS start_time, to_char(e.end_time, 'HH24:MI') AS end_time,
            e.location, e.announcement, e.terms,
            coalesce(e.active_modules, '["ticketing"]'::jsonb) AS active_modules,
            coalesce(e.module_config, '{}'::jsonb) AS module_config,
            coalesce(org.name, 'Ambiltiketnya') AS organizer_name,
            coalesce(org.logo_url, '') AS organizer_logo
          FROM events e
          LEFT JOIN organizers org ON org.id = e.organizer_id
          WHERE e.id::text = $1 AND e.is_active = true
          LIMIT 1
        `, [code]);

        if (evRows.length) {
          const ev = evRows[0];
          const wishes = neonQuery( `
            SELECT coalesce(o.guest_name, u.name) AS name, coalesce(o.guest_org, u.church) AS org,
              o.guestbook_message AS message, to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon HH24:MI') AS time_str
            FROM orders o
            LEFT JOIN users u ON u.id = o.user_id
            WHERE o.event_id = $1::uuid AND o.guestbook_message <> '' AND o.status <> 'cancelled' AND o.status <> 'declined'
            ORDER BY o.created_at DESC LIMIT 15
          `, [ev.id]);
          return { found: true, type: 'event', event: ev, wishes } });
        }

        return { found: false } });
      }

function digitalInvitationRsvp(p) {
  var code = String(p && p.code || '').trim();
  var rsvpStatus = String(p && p.rsvp_status || 'attending').trim().toLowerCase();
  var plusOne = Math.max(0, parseInt(p && p.plus_one_count, 10) || 0);
  var message = String(p && p.guestbook_message || '').trim().slice(0, 1000);
  var guestName = String(p && p.guest_name || '').trim();
  var guestPhone = String(p && p.guest_phone || '').trim();
  var guestOrg = String(p && p.guest_org || '').trim();

  ensureFeatureTables();

  var ordRows = neonQuery(`SELECT o.id, o.event_id, o.qty, o.status, e.module_config FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1 OR o.order_code=$1 OR o.id::text=$1`, [code]);
  if (ordRows.length) {
    var ord = ordRows[0];
    var maxPO = 2;
    var allowPO = true;
    if (ord.module_config) {
      var cfg = ord.module_config;
      if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch(x) { cfg = {}; } }
      if (cfg.allow_plus_one === false) allowPO = false;
      if (cfg.max_plus_one != null) maxPO = Math.max(0, parseInt(cfg.max_plus_one, 10) || 0);
    }
    if (!allowPO || maxPO === 0) plusOne = 0;
    else plusOne = Math.min(maxPO, plusOne);

    var isDeclined = rsvpStatus === 'declined';
    var newQty = isDeclined ? 1 : (1 + plusOne);
    var newStatus = isDeclined ? 'declined' : 'confirmed';
    neonQuery(`UPDATE orders SET rsvp_status=$1, plus_one_count=$2, guestbook_message=$3, qty=$4, status=$5 WHERE id=$6::uuid`, [rsvpStatus, plusOne, message, newQty, newStatus, ord.id]);
    return { success: true, status: newStatus, rsvp_status: rsvpStatus, plus_one_count: plusOne };
  }

  var evRows = neonQuery(`SELECT id, name, quota, module_config FROM events WHERE id::text=$1 AND is_active=true`, [code]);
  if (!evRows.length) throw new Error('NOT_FOUND');
  var ev = evRows[0];
  var maxPO = 2;
  var allowPO = true;
  if (ev.module_config) {
    var cfg = ev.module_config;
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch(x) { cfg = {}; } }
    if (cfg.allow_plus_one === false) allowPO = false;
    if (cfg.max_plus_one != null) maxPO = Math.max(0, parseInt(cfg.max_plus_one, 10) || 0);
  }
  if (!allowPO || maxPO === 0) plusOne = 0;
  else plusOne = Math.min(maxPO, plusOne);

  var isDeclined = rsvpStatus === 'declined';
  var qty = isDeclined ? 1 : (1 + plusOne);
  var prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
  var tCode = 'INV-' + prefix + '-' + rnd(6);
  var oCode = rnd(8);

  var defaultUser = (neonQuery(`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`))[0];
  var r = neonQuery(`INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org,guest_phone,rsvp_status,plus_one_count,guestbook_message)
    VALUES($1,$2,$3::uuid,$4::uuid,$5::int,0,$6,'invitation',$7,$8,$9,$10,$11::int,$12) RETURNING id,ticket_code`, [oCode, tCode, defaultUser.id, ev.id, qty, isDeclined ? 'declined' : 'confirmed', guestName || 'Tamu Undangan', guestOrg || '', guestPhone || null, rsvpStatus, plusOne, message]);
  return { success: true, ticket_code: r[0].ticket_code, rsvp_status: rsvpStatus, plus_one_count: plusOne };
}
