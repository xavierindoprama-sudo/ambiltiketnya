#!/usr/bin/env python3
"""
AmbilTiketnya - Local Gate Hub (Posko Gerbang Lokal)
Server lokal mandiri (Zero-Dependency) untuk sinkronisasi 10+ gate scanner
tanpa koneksi internet luar via Wi-Fi Router lokal.
"""

import sys
import os
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
if sys.stderr and hasattr(sys.stderr, 'reconfigure'):
    try:
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

import re
import json
import sqlite3
import socket
import threading
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime

PORT = 8080
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gate_hub.db')

def get_api_url():
    """Membaca APP_API_URL dari config.js jika tersedia."""
    api_url = "https://ambiltiketnya-api.pram.workers.dev"
    config_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.js')
    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                cf_text = f.read()
                m = re.search(r'APP_API_URL\s*=\s*[\'\"]([^\'\"]+)[\'\"]', cf_text)
                if m:
                    api_url = m.group(1).strip()
        except Exception:
            pass
    return api_url


def get_local_ip():
    """Mendeteksi IP LAN lokal laptop (misal 192.168.x.x atau 10.x.x.x)"""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Tidak benar-benar mengirim paket, hanya untuk mendeteksi antarmuka keluar
        s.connect(('10.255.255.255', 1))
        ip = s.getsockname()[0]
    except Exception:
        try:
            ip = socket.gethostbyname(socket.gethostname())
        except Exception:
            ip = '127.0.0.1'
    finally:
        s.close()
    return ip

def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    c.execute('''
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            name TEXT,
            downloaded_at TEXT,
            total_tickets INTEGER DEFAULT 0
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS tickets (
            code TEXT PRIMARY KEY,
            event_id TEXT,
            name TEXT,
            church TEXT,
            age INTEGER,
            qty INTEGER DEFAULT 1,
            checked_in INTEGER DEFAULT 0,
            status TEXT DEFAULT 'confirmed',
            kind TEXT DEFAULT 'regular',
            checked_in_at TEXT,
            checked_in_gate TEXT
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS checkin_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT,
            name TEXT,
            church TEXT,
            qty INTEGER,
            entered INTEGER,
            gate TEXT,
            result TEXT,
            message TEXT,
            is_synced INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    c.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    ''')
    conn.commit()
    conn.close()

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AmbilTiketnya - Posko Gerbang Lokal (Local Gate Hub)</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<style>
:root{--bg:#090d16;--card:#111827;--card-border:rgba(255,255,255,.1);--ok:#10b981;--wn:#f59e0b;--er:#ef4444;--ac:#8b5cf6;--txt:#f1f5f9;--sub:#94a3b8}
*{box-sizing:border-box}
body{margin:0;padding:20px;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,sans-serif}
.container{max-width:1100px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:14px;padding-bottom:18px;border-bottom:1px solid var(--card-border);margin-bottom:20px}
.logo{display:flex;align-items:center;gap:12px;font-size:22px;font-weight:900;letter-spacing:-.5px}
.pill-status{display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,.15);color:var(--ok);border:1px solid rgba(16,185,129,.3);padding:6px 14px;border-radius:99px;font-size:13px;font-weight:700}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 10px var(--ok);animation:pulse 1.2s infinite}
@keyframes pulse{0%{opacity:.4;transform:scale(.8)}50%{opacity:1;transform:scale(1.2)}100%{opacity:.4;transform:scale(.8)}}

.grid-main{display:grid;grid-template-columns:360px 1fr;gap:20px}
@media(max-width:850px){.grid-main{grid-template-columns:1fr}}

.card{background:var(--card);border:1px solid var(--card-border);border-radius:16px;padding:20px}
.card h3{margin:0 0 12px;font-size:16px;display:flex;align-items:center;gap:8px}

.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat-box{background:rgba(255,255,255,.03);border:1px solid var(--card-border);border-radius:12px;padding:14px;text-align:center}
.stat-box small{color:var(--sub);font-size:12px;display:block;margin-bottom:4px}
.stat-box b{font-size:26px;font-weight:800}

.btn{padding:10px 16px;border-radius:10px;border:none;cursor:pointer;font-weight:700;font-size:14px;display:inline-flex;align-items:center;gap:8px;transition:.15s}
.btn:hover{filter:brightness(1.1);transform:translateY(-1px)}
.btn-pri{background:var(--ac);color:#fff}
.btn-ok{background:var(--ok);color:#fff}
.btn-outline{background:transparent;border:1px solid var(--card-border);color:var(--txt)}

.qr-box{text-align:center;padding:16px;background:#fff;border-radius:14px;display:inline-block;margin:10px auto}
.qr-box canvas{display:block;margin:0 auto}

.log-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:10px}
.log-table th{text-align:left;padding:10px;color:var(--sub);border-bottom:1px solid var(--card-border);font-size:11px;text-transform:uppercase}
.log-table td{padding:10px;border-bottom:1px solid rgba(255,255,255,.05)}
.badge-res{display:inline-block;padding:2px 8px;border-radius:6px;font-weight:700;font-size:11px}
.res-VALID{background:rgba(16,185,129,.2);color:var(--ok)}
.res-USED{background:rgba(245,158,11,.2);color:var(--wn)}
.res-ERROR{background:rgba(239,68,68,.2);color:var(--er)}
</style>
<script src="/qrcode.min.js"></script>
</head>
<body>
<div class="container">
  <div class="header">
    <div class="logo">
      <span>🎟️</span>
      <div>
        AmbilTiketnya <span style="color:var(--ac);font-weight:400">| Posko Gerbang Lokal</span>
        <div style="font-size:12px;color:var(--sub);font-weight:400" id="hub_event_name">Memuat data acara...</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <div class="pill-status">
        <span class="pulse"></span>
        <span id="hub_ip_badge">Wi-Fi LAN: Memuat...</span>
      </div>
      <button class="btn btn-outline" onclick="loadStats()">🔄 Refresh</button>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-box" style="border-left:4px solid var(--ac)">
      <small>Total Tiket Acara</small>
      <b id="st_total">0</b>
    </div>
    <div class="stat-box" style="border-left:4px solid var(--ok)">
      <small>Sudah Masuk (Check-in)</small>
      <b id="st_checked" style="color:var(--ok)">0</b>
      <div style="font-size:12px;color:var(--sub)" id="st_pct">0%</div>
    </div>
    <div class="stat-box" style="border-left:4px solid var(--wn)">
      <small>Belum Hadir</small>
      <b id="st_remain" style="color:var(--wn)">0</b>
    </div>
  </div>

  <div class="grid-main">
    <!-- KOLOM KIRI: KONEKSI HP PETUGAS & KONTROL CLOUD -->
    <div style="display:flex;flex-direction:column;gap:16px">
      <div class="card" style="text-align:center">
        <h3>📲 Sambungkan HP Petugas Gate</h3>
        <p style="color:var(--sub);font-size:13px;line-height:1.5;margin:0 0 12px">
          Hubungkan HP petugas ke Wi-Fi yang sama, lalu <b>scan QR code ini dengan kamera HP</b> untuk membuka scanner:
        </p>
        <div class="qr-box" id="qr_wrap"></div>
        <div style="margin-top:10px">
          <div style="font-size:12px;color:var(--sub);margin-bottom:4px">Atau ketik manual di browser HP:</div>
          <code style="background:rgba(255,255,255,.08);padding:6px 12px;border-radius:8px;font-size:14px;color:#38bdf8;font-weight:700" id="scan_url_txt">http://...</code>
        </div>
      </div>

      <div class="card">
        <h3>☁️ Sinkronisasi Cloud (Cloudflare)</h3>
        <div style="background:rgba(139,92,246,.15);border:1px solid rgba(139,92,246,.3);padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.4;margin-bottom:14px;color:#ddd6fe">
          <b>💡 Cara 1-Klik Paling Praktis:</b><br>
          Buka dashboard admin <b>ambiltiketnya.online</b> di browser laptop ini, masuk menu <b>Pos Check-In / Offline</b>, lalu klik tombol hijau <b>"💻 Kirim ke Gate Hub"</b>!
        </div>
        <p style="color:var(--sub);font-size:12px;line-height:1.5;margin:0 0 14px">
          Atau gunakan tombol manual di bawah:
        </p>
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <button class="btn btn-pri" onclick="openImportFile()" style="justify-content:center;font-size:13px">
              📂 Impor File (.json)
            </button>
            <button class="btn btn-outline" onclick="openPasteModal()" style="justify-content:center;font-size:13px">
              📋 Tempel Data
            </button>
          </div>
          <button class="btn btn-pri" onclick="openCloudFetchModal()" style="justify-content:center;background:#6366f1">
            📥 Ambil dari Cloud via Token
          </button>
          <button class="btn btn-ok" onclick="syncToCloud()" style="justify-content:center">
            ☁️ Unggah Rekap ke Cloud
          </button>
          <input type="file" id="file_import_inp" accept=".json" style="display:none" onchange="handleFileSelected(this)">
        </div>
        <div id="sync_status" style="margin-top:12px;font-size:12px;color:var(--sub);text-align:center"></div>
      </div>
    </div>

    <!-- KOLOM KANAN: LIVE CHECK-IN FEED -->
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <h3 style="margin:0">⚡ Live Activity Feed (Semua Pintu)</h3>
        <small style="color:var(--sub);font-size:12px" id="last_update">Real-time (Polling 1.5s)</small>
      </div>
      <div style="max-height:560px;overflow-y:auto">
        <table class="log-table">
          <thead>
            <tr>
              <th>Waktu</th>
              <th>Pintu / Gate</th>
              <th>Nama / Tiket</th>
              <th>Gereja / Komunitas</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="log_tbody">
            <tr><td colspan="5" style="text-align:center;color:var(--sub);padding:30px">Menunggu data scan pertama...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</div>

<script>
let HUB_URL = '';
async function loadInfo() {
  try {
    const res = await fetch('/api/info');
    const d = await res.json();
    HUB_URL = d.scanUrl;
    document.getElementById('hub_ip_badge').textContent = 'Wi-Fi: ' + d.ip + ':' + d.port;
    document.getElementById('scan_url_txt').textContent = d.scanUrl;

    // Render QR Code
    const qrWrap = document.getElementById('qr_wrap');
    if (typeof qrcode !== 'undefined') {
      try {
        const qr = qrcode(0, 'M');
        qr.addData(d.scanUrl);
        qr.make();
        const n = qr.getModuleCount();
        let p = '';
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            if (qr.isDark(r, c)) p += `M${c} ${r}h1v1h-1z`;
          }
        }
        qrWrap.innerHTML = `<svg viewBox="0 0 ${n} ${n}" width="160" height="160" shape-rendering="crispEdges" style="display:block;margin:0 auto"><path d="${p}" fill="#000"/></svg>`;
      } catch(e) {
        qrWrap.innerHTML = `<a href="${d.scanUrl}" target="_blank" style="font-size:12px;color:#2563eb;word-break:break-all">${d.scanUrl}</a>`;
      }
    } else {
      qrWrap.innerHTML = `<a href="${d.scanUrl}" target="_blank" style="font-size:12px;color:#2563eb;word-break:break-all">${d.scanUrl}</a>`;
    }
  } catch(e) {}
}

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const d = await res.json();
    document.getElementById('hub_event_name').textContent = d.eventName || 'Belum ada acara yang diunduh';
    document.getElementById('st_total').textContent = d.totalTickets;
    document.getElementById('st_checked').textContent = d.checkedIn;
    document.getElementById('st_remain').textContent = d.notCheckedIn;
    document.getElementById('st_pct').textContent = d.rate + '% masuk';

    const tbody = document.getElementById('log_tbody');
    if (d.logs && d.logs.length) {
      tbody.innerHTML = d.logs.map(l => `
        <tr>
          <td style="font-family:monospace;font-size:12px;color:var(--sub)">${l.time}</td>
          <td><b>${l.gate}</b></td>
          <td><b>${l.name}</b><br><small style="color:var(--sub);font-family:monospace">${l.code} (${l.qty} pax)</small></td>
          <td>${l.church || '-'}</td>
          <td><span class="badge-res res-${l.result}">${l.result === 'VALID' ? '✓ VALID' : (l.result === 'USED' ? '⚠️ SUDAH DIPAKAI' : l.result)}</span><br><small style="color:var(--sub);font-size:11px">${l.message || ''}</small></td>
        </tr>
      `).join('');
    }
  } catch(e) {}
}

async function promptDownloadCloud() {
  const evId = prompt('Masukkan Event ID dari dashboard Cloudflare (atau kosongkan untuk menggunakan ID yang tersimpan):');
  if (evId === null) return;
  const tok = prompt('Masukkan Super Admin Token (atau token sesi):');
  if (!tok) return alert('Token diperlukan untuk mengunduh data acara dari Cloud.');

  document.getElementById('sync_status').innerHTML = '⏳ Mengunduh tiket dari Cloudflare...';
  try {
    const res = await fetch('/api/download-cloud', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ eventId: evId, token: tok })
    });
    const d = await res.json();
    if (d.ok) {
      alert('✓ Berhasil mengunduh ' + d.count + ' tiket untuk ' + d.eventName + '!');
      loadStats();
      document.getElementById('sync_status').innerHTML = '✓ Terakhir unduh: ' + new Date().toLocaleTimeString('id-ID');
    } else {
      alert('Gagal: ' + (d.error || 'Terjadi kesalahan'));
      document.getElementById('sync_status').innerHTML = '✗ Gagal mengunduh';
    }
  } catch(e) {
    alert('Koneksi gagal: ' + e.message);
  }
}

function openImportFile() {
  document.getElementById('file_import_inp').click();
}

function handleFileSelected(inp) {
  const file = inp.files && inp.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      const data = JSON.parse(e.target.result);
      const res = await fetch('/api/save-manifest', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(data)
      });
      const d = await res.json();
      if (d.ok) {
        alert('✓ Berhasil memuat ' + d.count + ' tiket untuk acara ' + d.eventName + '!');
        loadStats();
        document.getElementById('sync_status').innerHTML = '✓ Terakhir impor: ' + new Date().toLocaleTimeString('id-ID');
      } else {
        alert('Gagal: ' + (d.error || 'Format tidak valid'));
      }
    } catch(err) {
      alert('File tidak valid: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function openPasteModal() {
  const text = prompt('Tempelkan teks data JSON tiket di sini (dari tombol "📋 Salin Data Tiket"):');
  if (!text) return;
  try {
    const data = JSON.parse(text);
    fetch('/api/save-manifest', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(data)
    }).then(r => r.json()).then(d => {
      if (d.ok) {
        alert('✓ Sukses memuat ' + d.count + ' tiket untuk acara ' + d.eventName + '!');
        loadStats();
      } else {
        alert('Gagal: ' + d.error);
      }
    }).catch(e => alert('Error: ' + e.message));
  } catch(e) {
    alert('Format JSON tidak valid!');
  }
}

async function openCloudFetchModal() {
  const tok = prompt('Masukkan Super Admin Token Anda:');
  if (!tok) return;
  document.getElementById('sync_status').innerHTML = '⏳ Menghubungi Cloudflare...';
  try {
    const res = await fetch('/api/list-events', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ token: tok })
    });
    const d = await res.json();
    if (!d.ok || !d.events || !d.events.length) {
      return alert('Gagal mengambil daftar acara: ' + (d.error || 'Tidak ada acara aktif'));
    }
    const choices = d.events.map((e, i) => `${i + 1}. ${e.name} (${e.sold} tiket)`).join('\\n');
    const pick = prompt(`Pilih nomor acara yang ingin diunduh:\\n\\n${choices}\\n\\nKetik nomornya (misal: 1):`);
    const idx = parseInt(pick, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= d.events.length) return alert('Pilihan dibatalkan');
    const selEvent = d.events[idx];

    document.getElementById('sync_status').innerHTML = '⏳ Mengunduh tiket ' + selEvent.name + '...';
    const dlRes = await fetch('/api/download-cloud', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ eventId: selEvent.id, token: tok })
    });
    const dlData = await dlRes.json();
    if (dlData.ok) {
      alert('✓ Berhasil mengunduh ' + dlData.count + ' tiket untuk ' + dlData.eventName + '!');
      loadStats();
      document.getElementById('sync_status').innerHTML = '✓ Terakhir unduh: ' + new Date().toLocaleTimeString('id-ID');
    } else {
      alert('Gagal mengunduh: ' + dlData.error);
    }
  } catch(e) {
    alert('Koneksi gagal: ' + e.message);
  }
}

async function syncToCloud() {
  const tok = prompt('Masukkan Super Admin Token untuk sinkronisasi ke Cloud:');
  if (!tok) return;
  document.getElementById('sync_status').innerHTML = '⏳ Mengunggah data check-in ke Cloudflare...';
  try {
    const res = await fetch('/api/sync-cloud', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ token: tok })
    });
    const d = await res.json();
    if (d.ok) {
      alert('✓ Sukses menyinkronkan ' + d.synced + ' tiket ke Cloudflare!');
      document.getElementById('sync_status').innerHTML = '✓ Terakhir sinkron ke cloud: ' + new Date().toLocaleTimeString('id-ID');
    } else {
      alert('Gagal: ' + (d.error || 'Terjadi kesalahan'));
    }
  } catch(e) {
    alert('Koneksi gagal: ' + e.message);
  }
}

loadInfo();
loadStats();
setInterval(loadStats, 1500);
</script>
</body>
</html>
"""

class GateHubHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        # Serve static files from workspace root
        base_dir = os.path.dirname(os.path.abspath(__file__))
        super().__init__(*args, directory=base_dir, **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/' or path == '/dashboard':
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.end_headers()
            self.wfile.write(DASHBOARD_HTML.encode('utf-8'))
            return

        if path == '/api/info':
            ip = get_local_ip()
            data = {
                'ip': ip,
                'port': PORT,
                'scanUrl': f"http://{ip}:{PORT}/scan.html"
            }
            self.send_json(data)
            return

        if path == '/api/stats':
            self.handle_stats()
            return

        # Fallback to standard static file server (for scan.html, config.js, favicon.svg, etc.)
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        length = int(self.headers.get('Content-Length', 0))
        raw_body = self.rfile.read(length).decode('utf-8') if length > 0 else '{}'
        try:
            body = json.loads(raw_body)
        except Exception:
            body = {}

        if path == '/api/validate' or path == '/':
            self.handle_validate(body)
            return

        if path == '/api/save-manifest':
            self.handle_save_manifest(body)
            return

        if path == '/api/list-events':
            self.handle_list_events(body)
            return

        if path == '/api/download-cloud':
            self.handle_download_cloud(body)
            return

        if path == '/api/sync-cloud':
            self.handle_sync_cloud(body)
            return

        self.send_json({'error': 'NOT_FOUND'}, status=404)

    def send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode('utf-8'))

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Access-Control-Request-Private-Network')
        self.send_header('Access-Control-Allow-Private-Network', 'true')
        self.end_headers()

    def handle_validate(self, body):
        code = str(body.get('code') or '').strip().upper()
        gate = str(body.get('gate') or 'Pintu Masuk').strip()
        entered_qty = int(body.get('entered_qty') or 1)
        confirm = bool(body.get('confirm', False))

        if not code:
            self.send_json({'ok': False, 'error': 'KODE_TIKET_KOSONG'}, status=400)
            return

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('SELECT code, name, church, age, qty, checked_in, status, kind, checked_in_at, checked_in_gate FROM tickets WHERE UPPER(code) = ?', (code,))
        row = c.fetchone()

        if not row:
            conn.close()
            # Log as NOT_FOUND
            self.log_scan(code, 'Tidak Terdaftar', '', 1, 0, gate, 'NOT_FOUND', 'Tiket tidak ada di database acara ini')
            self.send_json({
                'ok': True,
                'data': {
                    'result': 'NOT_FOUND',
                    'code': code,
                    'message': 'Tiket tidak terdaftar di database acara ini.'
                }
            })
            return

        t_code, t_name, t_church, t_age, t_qty, t_checked, t_status, t_kind, t_at, t_gate = row

        if t_status == 'cancelled':
            conn.close()
            self.log_scan(t_code, t_name, t_church, t_qty, 0, gate, 'CANCELLED', 'Pesanan dibatalkan')
            self.send_json({
                'ok': True,
                'data': {
                    'result': 'CANCELLED',
                    'code': t_code,
                    'name': t_name,
                    'message': 'Tiket / Pesanan telah DIBATALKAN.'
                }
            })
            return

        remaining = max(0, t_qty - t_checked)

        # Jika sudah pernah digunakan penuh
        if remaining <= 0:
            conn.close()
            msg = f"SUDAH DIGUNAKAN di {t_gate or 'Pintu lain'} pada {t_at or '-'}!"
            self.log_scan(t_code, t_name, t_church, t_qty, 0, gate, 'USED', msg)
            self.send_json({
                'ok': True,
                'data': {
                    'result': 'USED',
                    'code': t_code,
                    'name': t_name,
                    'church': t_church,
                    'qty': t_qty,
                    'checked': t_checked,
                    'message': msg
                }
            })
            return

        # Tiket multi-person (rombongan) tapi belum konfirmasi
        if t_qty > 1 and not confirm and remaining > 1:
            conn.close()
            self.send_json({
                'ok': True,
                'data': {
                    'result': 'CONFIRM_PARTIAL',
                    'code': t_code,
                    'name': t_name,
                    'church': t_church,
                    'qty': t_qty,
                    'checked': t_checked,
                    'remaining': remaining
                }
            })
            return

        # Eksekusi Check-in
        qty_to_enter = min(entered_qty, remaining)
        new_checked = t_checked + qty_to_enter
        now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

        c.execute('UPDATE tickets SET checked_in = ?, checked_in_at = ?, checked_in_gate = ? WHERE code = ?',
                  (new_checked, now_str, gate, t_code))
        conn.commit()
        conn.close()

        msg = f"Check-in {qty_to_enter} pax berhasil di {gate}"
        self.log_scan(t_code, t_name, t_church, t_qty, qty_to_enter, gate, 'VALID', msg)

        self.send_json({
            'ok': True,
            'data': {
                'result': 'VALID',
                'code': t_code,
                'name': t_name,
                'church': t_church,
                'age': t_age,
                'qty': t_qty,
                'entered': qty_to_enter,
                'checked': new_checked,
                'remaining': t_qty - new_checked,
                'gate': gate
            }
        })

    def log_scan(self, code, name, church, qty, entered, gate, result, message):
        try:
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute('''
                INSERT INTO checkin_logs(code, name, church, qty, entered, gate, result, message)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?)
            ''', (code, name, church, qty, entered, gate, result, message))
            conn.commit()
            conn.close()
        except Exception:
            pass

    def handle_stats(self):
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('SELECT count(*), coalesce(sum(qty), 0), coalesce(sum(checked_in), 0) FROM tickets WHERE status != "cancelled"')
        row = c.fetchone()
        total_rows, total_tix, total_checked = row if row else (0, 0, 0)
        not_checked = max(0, total_tix - total_checked)
        rate = round((total_checked / total_tix * 100), 1) if total_tix else 0

        c.execute('SELECT name FROM events LIMIT 1')
        ev_row = c.fetchone()
        ev_name = ev_row[0] if ev_row else 'Belum ada acara'

        c.execute('''
            SELECT to_char_time, gate, name, code, qty, result, message
            FROM (
                SELECT strftime('%H:%M:%S', created_at) AS to_char_time, gate, name, code, qty, result, message, id
                FROM checkin_logs
                ORDER BY id DESC LIMIT 40
            )
        ''')
        logs = []
        for r in c.fetchall():
            logs.append({
                'time': r[0],
                'gate': r[1],
                'name': r[2],
                'code': r[3],
                'qty': r[4],
                'result': r[5],
                'message': r[6]
            })
        conn.close()

        self.send_json({
            'eventName': ev_name,
            'totalTickets': total_tix,
            'checkedIn': total_checked,
            'notCheckedIn': not_checked,
            'rate': rate,
            'logs': logs
        })

    def handle_list_events(self, body):
        token = str(body.get('token') or '').strip()
        api_url = get_api_url()

        req_data = json.dumps({'action': 'adminEvents', 'token': token}).encode('utf-8')
        req = urllib.request.Request(api_url, data=req_data, headers={'Content-Type': 'text/plain'})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                if res_json.get('ok'):
                    events = res_json.get('data') or []
                    simplified = [{'id': e.get('id'), 'name': e.get('name'), 'sold': e.get('sold', 0)} for e in events]
                    self.send_json({'ok': True, 'events': simplified})
                else:
                    self.send_json({'ok': False, 'error': res_json.get('error', 'Token tidak valid')})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)})

    def handle_save_manifest(self, data):
        ev_id = str(data.get('eventId') or '').strip()
        ev_name = str(data.get('eventName') or 'Acara').strip()
        tickets = data.get('tickets') or []

        if not tickets and not ev_name:
            self.send_json({'ok': False, 'error': 'Data tiket kosong'}, status=400)
            return

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('DELETE FROM events')
        c.execute('INSERT INTO events(id, name, downloaded_at, total_tickets) VALUES(?, ?, ?, ?)',
                  (ev_id, ev_name, datetime.now().isoformat(), len(tickets)))

        c.execute('DELETE FROM tickets')
        for t in tickets:
            c.execute('''
                INSERT OR REPLACE INTO tickets(code, event_id, name, church, age, qty, checked_in, status, kind)
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
            ''', (t.get('code'), ev_id, t.get('name'), t.get('church'), t.get('age'), t.get('qty', 1), t.get('checked', 0), t.get('status', 'confirmed'), t.get('kind', 'regular')))
        conn.commit()
        conn.close()

        self.send_json({'ok': True, 'eventName': ev_name, 'count': len(tickets)})

    def handle_download_cloud(self, body):
        token = str(body.get('token') or '').strip()
        event_id = str(body.get('eventId') or '').strip()
        api_url = get_api_url()

        req_data = json.dumps({
            'action': 'offlineManifest',
            'token': token,
            'eventId': event_id
        }).encode('utf-8')

        req = urllib.request.Request(api_url, data=req_data, headers={'Content-Type': 'text/plain'})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                if not res_json.get('ok'):
                    self.send_json({'ok': False, 'error': res_json.get('error', 'Gagal dari server')})
                    return
                data = res_json.get('data', {})
                ev_id = data.get('eventId', '')
                ev_name = data.get('eventName', '')
                tickets = data.get('tickets', [])

                conn = sqlite3.connect(DB_FILE)
                c = conn.cursor()
                c.execute('DELETE FROM events')
                c.execute('INSERT INTO events(id, name, downloaded_at, total_tickets) VALUES(?, ?, ?, ?)',
                          (ev_id, ev_name, datetime.now().isoformat(), len(tickets)))

                c.execute('DELETE FROM tickets')
                for t in tickets:
                    c.execute('''
                        INSERT OR REPLACE INTO tickets(code, event_id, name, church, age, qty, checked_in, status, kind)
                        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ''', (t.get('code'), ev_id, t.get('name'), t.get('church'), t.get('age'), t.get('qty', 1), t.get('checked', 0), t.get('status', 'confirmed'), t.get('kind', 'regular')))
                conn.commit()
                conn.close()

                self.send_json({'ok': True, 'eventName': ev_name, 'count': len(tickets)})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)})

    def handle_sync_cloud(self, body):
        token = str(body.get('token') or '').strip()
        api_url = get_api_url()

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('SELECT code, checked_in_at, checked_in_gate FROM tickets WHERE checked_in > 0')
        checked_rows = c.fetchall()
        conn.close()

        if not checked_rows:
            self.send_json({'ok': True, 'synced': 0, 'message': 'Tidak ada data check-in untuk diunggah.'})
            return

        checkins = [{'code': r[0], 'at': r[1] or datetime.now().isoformat()} for r in checked_rows]

        req_data = json.dumps({
            'action': 'syncOfflineCheckins',
            'token': token,
            'checkins': checkins
        }).encode('utf-8')

        req = urllib.request.Request(api_url, data=req_data, headers={'Content-Type': 'text/plain'})
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                res_json = json.loads(resp.read().decode('utf-8'))
                if res_json.get('ok'):
                    synced_cnt = res_json.get('data', {}).get('synced', len(checkins))
                    self.send_json({'ok': True, 'synced': synced_cnt})
                else:
                    self.send_json({'ok': False, 'error': res_json.get('error', 'Gagal sinkron')})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)})

def run_server():
    init_db()
    ip = get_local_ip()
    server = ThreadingHTTPServer(('0.0.0.0', PORT), GateHubHandler)
    print("=" * 65)
    print(">> AMBILTIKETNYA - LOCAL GATE HUB (POSKO GERBANG LOKAL)")
    print("=" * 65)
    print(f">> IP LAN Laptop     : http://{ip}:{PORT}")
    print(f">> URL Scan Petugas : http://{ip}:{PORT}/scan.html")
    print(f">> Dashboard Posko   : http://localhost:{PORT}")
    print("=" * 65)
    print("Petunjuk:")
    print("1. Pastikan HP Petugas terhubung ke Wi-Fi yang sama.")
    print(f"2. Buka http://localhost:{PORT} di laptop ini untuk melihat dashboard.")
    print("3. Scan QR code di layar laptop dengan kamera HP petugas.")
    print("Tekan Ctrl+C untuk menghentikan server.")
    print("=" * 65)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer Gate Hub dihentikan.")
        server.server_close()

if __name__ == '__main__':
    run_server()
