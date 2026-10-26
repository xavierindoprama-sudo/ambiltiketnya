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
import ssl
import socket
import threading
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from datetime import datetime

PORT = 8080
HTTPS_PORT = 8443
DB_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'gate_hub.db')

def ensure_ssl_certs():
    """Membuat atau memastikan file cert.pem & key.pem tersedia untuk mode HTTPS lokal."""
    cert_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cert.pem')
    key_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'key.pem')
    if os.path.exists(cert_path) and os.path.exists(key_path):
        return cert_path, key_path
    try:
        import datetime, ipaddress
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.primitives import serialization

        ip = get_local_ip()
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, str(ip)),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, 'AmbilTiketnya Gate Hub'),
        ])
        san = x509.SubjectAlternativeName([
            x509.IPAddress(ipaddress.IPv4Address(ip)),
            x509.IPAddress(ipaddress.IPv4Address('127.0.0.1')),
            x509.DNSName('localhost'),
        ])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.datetime.now(datetime.timezone.utc))
            .not_valid_after(datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=730))
            .add_extension(san, critical=False)
            .sign(key, hashes.SHA256())
        )
        with open(key_path, 'wb') as f:
            f.write(key.private_bytes(
                encoding=serialization.Encoding.PEM,
                format=serialization.PrivateFormat.TraditionalOpenSSL,
                encryption_algorithm=serialization.NoEncryption(),
            ))
        with open(cert_path, 'wb') as f:
            f.write(cert.public_bytes(serialization.Encoding.PEM))
        return cert_path, key_path
    except Exception as e:
        print(f"Warning SSL: {e}")
        return None, None


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

def call_cloudflare_api(token, action, params=None):
    """Memanggil endpoint Cloudflare Worker dengan format RPC dan User-Agent yang aman dari blokir Cloudflare WAF."""
    api_url = get_api_url()
    headers = {
        'Content-Type': 'text/plain;charset=utf-8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
    payload = {
        'fn': 'api',
        'args': [token, action, params or {}]
    }
    req = urllib.request.Request(api_url, data=json.dumps(payload).encode('utf-8'), headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return json.loads(resp.read().decode('utf-8'))



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

DASHBOARD_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dashboard.html')

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
            if os.path.exists(DASHBOARD_FILE):
                with open(DASHBOARD_FILE, 'rb') as f:
                    self.wfile.write(f.read())
            else:
                self.wfile.write(b"<h1>Dashboard file missing</h1>")
            return

        if path == '/api/info':
            ip = get_local_ip()
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute("SELECT value FROM settings WHERE key = 'admin_token'")
            row = c.fetchone()
            conn.close()
            has_token = bool(row and row[0])
            data = {
                'ip': ip,
                'port': PORT,
                'httpsPort': HTTPS_PORT,
                'hasToken': has_token,
                'scanUrl': f"https://{ip}:{HTTPS_PORT}/scan.html"
            }
            self.send_json(data)
            return

        if path == '/api/stats':
            self.handle_stats()
            return

        if path == '/api/tickets':
            self.handle_get_tickets()
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

        if path == '/api/dummy-generate':
            self.handle_dummy_generate()
            return

        if path == '/api/dummy-reset':
            self.handle_dummy_reset()
            return

        if path == '/api/save-token':
            tok = str(body.get('token') or '').strip()
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('admin_token', ?)", (tok,))
            conn.commit()
            conn.close()
            self.send_json({'ok': True, 'saved': bool(tok)})
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
        if not token:
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute("SELECT value FROM settings WHERE key = 'admin_token'")
            row = c.fetchone()
            conn.close()
            if row and row[0]:
                token = row[0].strip()

        try:
            res_json = call_cloudflare_api(token, 'adminEvents', {})
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

        admin_token = str(data.get('adminToken') or '').strip()
        if admin_token:
            c.execute("INSERT OR REPLACE INTO settings(key, value) VALUES('admin_token', ?)", (admin_token,))

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
        if not token:
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute("SELECT value FROM settings WHERE key = 'admin_token'")
            row = c.fetchone()
            conn.close()
            if row and row[0]:
                token = row[0].strip()

        try:
            res_json = call_cloudflare_api(token, 'offlineManifest', {'eventId': event_id})
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
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        if not token:
            c.execute("SELECT value FROM settings WHERE key = 'admin_token'")
            row = c.fetchone()
            if row and row[0]:
                token = row[0].strip()

        if not token:
            conn.close()
            self.send_json({'ok': False, 'needToken': True, 'error': 'Token Admin belum tersimpan. Silakan masukkan token terlebih dahulu.'})
            return

        c.execute('SELECT code, checked_in_at, checked_in_gate FROM tickets WHERE checked_in > 0')
        checked_rows = c.fetchall()
        conn.close()

        if not checked_rows:
            self.send_json({'ok': True, 'synced': 0, 'message': 'Tidak ada data check-in untuk diunggah.'})
            return

        checkins = [{'code': r[0], 'at': r[1] or datetime.now().isoformat()} for r in checked_rows]

        try:
            res_json = call_cloudflare_api(token, 'syncOfflineCheckins', {'checkins': checkins})
            if res_json.get('ok'):
                synced_cnt = res_json.get('data', {}).get('synced', len(checkins))
                self.send_json({'ok': True, 'synced': synced_cnt})
            else:
                self.send_json({'ok': False, 'error': res_json.get('error', 'Gagal sinkron')})
        except Exception as e:
            self.send_json({'ok': False, 'error': str(e)})

    def handle_get_tickets(self):
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('SELECT code, name, church, age, qty, checked_in, kind, checked_in_gate, checked_in_at FROM tickets ORDER BY code ASC')
        rows = c.fetchall()
        conn.close()
        tickets = []
        for r in rows:
            tickets.append({
                'code': r[0],
                'name': r[1],
                'church': r[2],
                'age': r[3],
                'qty': r[4],
                'checked': r[5],
                'kind': r[6],
                'gate': r[7],
                'at': r[8]
            })
        self.send_json({'ok': True, 'tickets': tickets})

    def handle_dummy_generate(self):
        import random
        first_names = ['Budi', 'David', 'Grace', 'Michael', 'Maria', 'Daniel', 'Yohanes', 'Ruth', 'Samuel', 'Christine', 'Jonathan', 'Stefanie', 'Andreas', 'Jessica', 'Hendra', 'Ratna', 'Petrus', 'Theresia', 'Anton', 'Agnes', 'Kevin', 'Cindy', 'Victor', 'Melisa', 'Ronald', 'Natalia', 'Felix', 'Irene', 'Edward', 'Veronica']
        last_names = ['Santoso', 'Wijaya', 'Siregar', 'Hutapea', 'Kurniawan', 'Sitorus', 'Pratama', 'Simanjuntak', 'Kusuma', 'Halim', 'Tanudjaja', 'Hartono', 'Setiawan', 'Lubis', 'Panggabean', 'Sinaga', 'Wibowo', 'Tanjung', 'Susanto', 'Gunawan']
        churches = ['GBI Glow Fellowship', 'HKBP Sudirman', 'GPIB Paulus Menteng', 'GKI Pondok Indah', 'Gereja Tiberias Roxy', 'Paroki Katedral Jakarta', 'GSJA Bethel Sunter', 'GKII Ebenhaezer', 'GBI Senayan City', 'GKI Kebayoran Baru']

        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()

        ev_id = 'evt_simulasi_gate'
        ev_name = 'Uji Coba Gate Hub (Simulasi 100 Tiket)'
        c.execute('DELETE FROM events')
        c.execute('INSERT INTO events(id, name, downloaded_at, total_tickets) VALUES(?, ?, ?, ?)',
                  (ev_id, ev_name, datetime.now().isoformat(), 100))

        c.execute('DELETE FROM tickets')
        c.execute('DELETE FROM checkin_logs')

        for i in range(1, 101):
            code = f'SIM-{i:03d}'
            f_name = random.choice(first_names)
            l_name = random.choice(last_names)
            church = random.choice(churches)
            age = random.randint(18, 65)
            if i <= 70:
                name = f'{f_name} {l_name}'
                qty = 1
                kind = 'regular'
            elif i <= 90:
                qty = random.choice([2, 3, 4, 5])
                name = f'Kel. {f_name} {l_name}' if random.random() > 0.4 else f'Rombongan {f_name} ({church})'
                kind = 'regular'
            else:
                qty = random.choice([1, 2])
                name = f'Pdt. {f_name} {l_name}' if random.random() > 0.5 else f'Tamu VIP {f_name} {l_name}'
                kind = 'invitation'

            c.execute('''
                INSERT INTO tickets(code, event_id, name, church, age, qty, checked_in, status, kind)
                VALUES(?, ?, ?, ?, ?, ?, 0, 'confirmed', ?)
            ''', (code, ev_id, name, church, age, qty, kind))

        conn.commit()
        conn.close()
        self.send_json({'ok': True, 'count': 100, 'eventName': ev_name})

    def handle_dummy_reset(self):
        conn = sqlite3.connect(DB_FILE)
        c = conn.cursor()
        c.execute('DELETE FROM events')
        c.execute('DELETE FROM tickets')
        c.execute('DELETE FROM checkin_logs')
        conn.commit()
        conn.close()
        self.send_json({'ok': True, 'message': 'Data uji coba telah dibersihkan.'})

def run_server():
    init_db()
    ip = get_local_ip()
    cert_path, key_path = ensure_ssl_certs()

    # 1. Server HTTP (Port 8080 untuk Laptop Dashboard)
    httpd_http = ThreadingHTTPServer(('0.0.0.0', PORT), GateHubHandler)

    # 2. Server HTTPS (Port 8443 untuk Scanner HP Petugas agar izin kamera terbuka)
    has_https = False
    if cert_path and key_path:
        try:
            httpd_https = ThreadingHTTPServer(('0.0.0.0', HTTPS_PORT), GateHubHandler)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=cert_path, keyfile=key_path)
            httpd_https.socket = ctx.wrap_socket(httpd_https.socket, server_side=True)
            has_https = True
        except Exception as e:
            print(f"Peringatan HTTPS Port 8443: {e}")

    print("=" * 65)
    print(">> AMBILTIKETNYA - LOCAL GATE HUB (POSKO GERBANG LOKAL)")
    print("=" * 65)
    print(f">> Dashboard Laptop : http://localhost:{PORT}")
    print(f">> Scanner HP (SSL) : https://{ip}:{HTTPS_PORT}/scan.html" if has_https else f">> Scanner HP (HTTP): http://{ip}:{PORT}/scan.html")
    print("=" * 65)
    print("Petunjuk:")
    print(f"1. Buka http://localhost:{PORT} di browser laptop ini untuk dashboard.")
    print("2. HP Petugas hubungkan ke Wi-Fi yang sama, lalu scan QR Code di layar.")
    print("3. Di HP petugas, jika muncul 'Koneksi tidak privat', klik:")
    print("   'Lanjutan' (Advanced) -> 'Lanjutkan ke situs (tidak aman)'.")
    print("   Setelah itu kamera HP akan langsung menyala normal.")
    print("=" * 65)

    if has_https:
        t_https = threading.Thread(target=httpd_https.serve_forever, daemon=True)
        t_https.start()

    try:
        httpd_http.serve_forever()
    except KeyboardInterrupt:
        print("\nServer Gate Hub dihentikan.")
        httpd_http.server_close()
        if has_https:
            httpd_https.server_close()

if __name__ == '__main__':
    run_server()
