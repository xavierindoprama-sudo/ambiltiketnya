/**
 * Cloudflare Worker for AmbilTiketnya (Pure JavaScript - Zero Dependencies)
 * Replaces Code.gs with ultra-low latency & unlimited fetch quota.
 */

const RANK = { attendee: 0, gate_staff: 1, admin: 2, super_admin: 3 };
const ITER = 1500;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

function errJson(errorMsg, status = 200) {
  const str = String(errorMsg || '');
  const code = /^[A-Z0-9_]+$/.test(str) ? str : 'E_GENERIC';
  return json({ ok: false, error: code, __error: code, message: str }, status);
}

// SHA-256 Web Crypto
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Password Hashing
async function hashPw(pw, salt, iter = ITER) {
  let h = salt + pw;
  for (let i = 0; i < iter; i++) {
    h = await sha256(h + salt);
  }
  return `${iter}$${salt}$${h}`;
}

async function checkPw(pw, stored) {
  try {
    const parts = stored.split('$');
    const it = parseInt(parts[0], 10);
    const salt = parts[1];
    const calc = await hashPw(pw, salt, it);
    return calc === stored;
  } catch (e) {
    return false;
  }
}

// Neon HTTP Driver
async function neonQuery(env, sql, params = []) {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set');
  const match = dbUrl.match(/@([^\/?]+)/);
  if (!match) throw new Error('Invalid DATABASE_URL format');
  const host = match[1];

  let cleanSql = String(sql || '').trim().replace(/;+$/, '');
  if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(cleanSql) && !/\bRETURNING\b/i.test(cleanSql)) {
    cleanSql += ' RETURNING 1';
  }
  const wrapped = `WITH t AS (${cleanSql}) SELECT coalesce(json_agg(t),'[]'::json) AS j FROM t`;
  const body = JSON.stringify({ query: wrapped, params: params });

  const resp = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl
    },
    body: body
  });

  const txt = await resp.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('DB response parse error: ' + txt.slice(0, 150)); }
  if (resp.status !== 200) {
    throw new Error('DB: ' + (j.message || resp.status));
  }
  const rawJ = j.rows && j.rows[0] ? j.rows[0].j : [];
  return typeof rawJ === 'string' ? JSON.parse(rawJ) : rawJ;
}

// Neon Direct SQL Exec (for DDL / statements that cannot be wrapped in CTE)
async function neonExec(env, sql) {
  const dbUrl = env.DATABASE_URL;
  if (!dbUrl) throw new Error('DATABASE_URL is not set');
  const match = dbUrl.match(/@([^\/?]+)/);
  if (!match) throw new Error('Invalid DATABASE_URL format');
  const host = match[1];

  const resp = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl
    },
    body: JSON.stringify({ query: sql, params: [] })
  });

  const txt = await resp.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('DB exec parse error: ' + txt.slice(0, 150)); }
  if (resp.status !== 200) {
    throw new Error('DB Exec: ' + (j.message || resp.status));
  }
  return j;
}

// Neon Batch / Transaction
async function neonBatch(env, queries) {
  const dbUrl = env.DATABASE_URL;
  const match = dbUrl.match(/@([^\/?]+)/);
  const host = match[1];

  const payload = {
    queries: queries.map(q => {
      let cleanSql = String(q.query || '').trim().replace(/;+$/, '');
      if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(cleanSql) && !/\bRETURNING\b/i.test(cleanSql)) {
        cleanSql += ' RETURNING 1';
      }
      return {
        query: `WITH t AS (${cleanSql}) SELECT coalesce(json_agg(t),'[]'::json) AS j FROM t`,
        params: q.params || []
      };
    })
  };

  const resp = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': dbUrl
    },
    body: JSON.stringify(payload)
  });

  const txt = await resp.text();
  let j;
  try { j = JSON.parse(txt); } catch (e) { throw new Error('DB batch parse error'); }
  if (resp.status !== 200) throw new Error('DB: ' + (j.message || resp.status));
  return (j.results || []).map(r => {
    const rawJ = r.rows && r.rows[0] ? r.rows[0].j : [];
    return typeof rawJ === 'string' ? JSON.parse(rawJ) : rawJ;
  });
}

function rnd(n) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  for (let i = 0; i < n; i++) s += c[arr[i] % c.length];
  return s;
}

function normPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  else if (d.startsWith('8')) d = '62' + d;
  return /^628\d{7,11}$/.test(d) ? d : null;
}

const AUTH_SQL = `SELECT u.id,u.email,u.name,u.whatsapp,u.age,u.church,u.role,coalesce(u.picture,'') AS picture,
  u.organizer_id, coalesce(org.name,'') AS organizer_name, coalesce(org.slug,'') AS organizer_slug
  FROM sessions s
  JOIN users u ON u.id=s.user_id
  LEFT JOIN organizers org ON org.id=u.organizer_id
  WHERE s.token_hash=$1 AND s.expires_at>now()`;

async function auth(env, token) {
  if (!token) throw new Error('AUTH');
  await ensureFeatureTables(env);
  const h = await sha256(token);
  const rows = await neonQuery(env, AUTH_SQL, [h]);
  const u = rows[0];
  if (!u) throw new Error('AUTH');
  return u;
}

async function newSession(env, uid) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const th = await sha256(token);
  if (Math.random() < 0.1) {
    await neonQuery(env, `DELETE FROM sessions WHERE expires_at < now() RETURNING token_hash`);
  }
  await neonQuery(env, `INSERT INTO sessions(token_hash, user_id, expires_at) VALUES($1, $2::uuid, now() + interval '7 days') RETURNING token_hash`, [th, uid]);
  return token;
}

// Events SQL
function eventsSql(uidExpr) {
  const mine = `FROM orders o WHERE o.event_id=e.id AND o.user_id=${uidExpr} AND o.status<>'cancelled' AND o.kind='order'`;
  return `SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,coalesce(e.walkin_quota,0)::int AS walkin_quota,
    coalesce(e.active_modules, '["ticketing"]'::jsonb) AS active_modules,
    coalesce(e.module_config, '{}'::jsonb) AS module_config,
    coalesce(e.custom_fields, '[]'::jsonb) AS custom_fields,
    coalesce(e.enable_nametag, false)::boolean AS enable_nametag,
    coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
    coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config,
    (e.quota - coalesce(os.sold, 0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce(os.walkin_sold, 0))::int AS walkin_remaining,
    EXISTS(SELECT 1 ${mine}) AS has_order,
    (SELECT o.id ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_order,
    (SELECT o.status ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_status
    FROM events e
    LEFT JOIN (
      SELECT event_id,
        sum(CASE WHEN kind<>'walk_in' THEN qty ELSE 0 END) AS sold,
        sum(CASE WHEN kind='walk_in' THEN qty ELSE 0 END) AS walkin_sold
      FROM orders
      WHERE status<>'cancelled'
      GROUP BY event_id
    ) os ON os.event_id = e.id
    WHERE e.is_active ORDER BY e.event_date, e.start_time`;
}

async function publicEventsList(env) {
  return await neonQuery(env, `SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,coalesce(e.walkin_quota,0)::int AS walkin_quota,
    coalesce(e.active_modules, '["ticketing"]'::jsonb) AS active_modules,
    coalesce(e.module_config, '{}'::jsonb) AS module_config,
    coalesce(e.custom_fields, '[]'::jsonb) AS custom_fields,
    coalesce(e.enable_nametag, false)::boolean AS enable_nametag,
    coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
    coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config,
    (e.quota - coalesce(os.sold, 0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce(os.walkin_sold, 0))::int AS walkin_remaining,
    false AS has_order, null AS my_order, null AS my_status
    FROM events e
    LEFT JOIN (
      SELECT event_id,
        sum(CASE WHEN kind<>'walk_in' THEN qty ELSE 0 END) AS sold,
        sum(CASE WHEN kind='walk_in' THEN qty ELSE 0 END) AS walkin_sold
      FROM orders
      WHERE status<>'cancelled'
      GROUP BY event_id
    ) os ON os.event_id = e.id
    WHERE e.is_active ORDER BY e.event_date, e.start_time`);
}

// Email Sender (Brevo -> MailerSend -> Resend)
async function sendEmail(env, { to, subject, htmlBody, name = 'AmbilTiketnya' }) {
  // 1. Brevo
  if (env.BREVO_API_KEY) {
    try {
      const senderEmail = env.BREVO_SENDER_EMAIL || 'tiket@ambiltiketnya.online';
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': env.BREVO_API_KEY },
        body: JSON.stringify({
          sender: { name, email: senderEmail },
          to: [{ email: to }],
          subject,
          htmlContent: htmlBody
        })
      });
      if (r.status >= 200 && r.status < 300) return 'brevo';
    } catch (e) { console.error('Brevo error:', e); }
  }

  // 2. MailerSend
  if (env.MAILERSEND_API_KEY) {
    try {
      const senderEmail = env.MAILERSEND_SENDER_EMAIL || env.RESEND_SENDER_EMAIL || 'tiket@ambiltiketnya.online';
      const r = await fetch('https://api.mailersend.com/v1/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.MAILERSEND_API_KEY}`,
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: JSON.stringify({
          from: { email: senderEmail, name },
          to: [{ email: to }],
          subject,
          html: htmlBody
        })
      });
      if (r.status >= 200 && r.status < 300) return 'mailersend';
    } catch (e) { console.error('MailerSend error:', e); }
  }

  // 3. Resend
  if (env.RESEND_API_KEY) {
    try {
      const senderEmail = env.RESEND_SENDER_EMAIL || 'tiket@ambiltiketnya.online';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: `${name} <${senderEmail}>`,
          to: [to],
          subject,
          html: htmlBody
        })
      });
      if (r.status >= 200 && r.status < 300) return 'resend';
    } catch (e) { console.error('Resend error:', e); }
  }

  throw new Error('EMAIL_QUOTA');
}

// Legal docs defaults
const LEGAL = {
  syarat: { title: 'Syarat dan Ketentuan', text: '## 1. Ketentuan Umum\n- Dengan memesan tiket di {ORG}, peserta menyetujui seluruh ketentuan yang berlaku.\n\n## 2. Tiket & Masuk\n- E-tiket resmi wajib ditunjukkan saat check-in di gerbang.' },
  privasi: { title: 'Kebijakan Privasi', text: '## 1. Pengumpulan Data\n- Kami mengumpulkan nama, email, dan WhatsApp semata-mata untuk penerbitan tiket dan verifikasi acara.' },
  cookie: { title: 'Kebijakan Cookie', text: '## 1. Cookie Teknis\n- Kami hanya menyimpan token sesi di peramban Anda untuk keperluan autentikasi masuk.' }
};

let _tablesEnsured = true;
async function ensureFeatureTables(env, force = false) {
  if (_tablesEnsured && !force) return;
  const ddlStatements = [
    `CREATE TABLE IF NOT EXISTS event_feedbacks (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
      user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
      ticket_code     text DEFAULT '',
      guest_name      text DEFAULT '',
      guest_org       text DEFAULT '',
      is_anonymous    boolean NOT NULL DEFAULT false,
      rating          int NOT NULL CHECK (rating BETWEEN 1 AND 5),
      rating_content  int NOT NULL DEFAULT 5,
      rating_service  int NOT NULL DEFAULT 5,
      rating_venue    int NOT NULL DEFAULT 5,
      rating_sound    int NOT NULL DEFAULT 5,
      aspects         jsonb NOT NULL DEFAULT '{}'::jsonb,
      category        text NOT NULL DEFAULT 'Umum',
      comment         text NOT NULL DEFAULT '',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS rating_content int NOT NULL DEFAULT 5`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS rating_service int NOT NULL DEFAULT 5`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS rating_venue int NOT NULL DEFAULT 5`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS rating_sound int NOT NULL DEFAULT 5`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS aspects jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE event_feedbacks ADD COLUMN IF NOT EXISTS client_token text DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS event_feedbacks_ev_idx ON event_feedbacks (event_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS event_feedbacks_client_idx ON event_feedbacks (event_id, client_token)`,
    `CREATE TABLE IF NOT EXISTS doorprize_winners (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      order_id     uuid REFERENCES orders(id) ON DELETE CASCADE,
      ticket_code  text NOT NULL,
      winner_name  text NOT NULL,
      winner_org   text DEFAULT '',
      prize_name   text NOT NULL,
      drawn_at     timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS doorprize_winners_ev_idx ON doorprize_winners (event_id, drawn_at DESC)`,
    `CREATE TABLE IF NOT EXISTS event_checkpoints (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      checkpoint_key  text NOT NULL,
      name            text NOT NULL,
      icon            text DEFAULT '📍',
      checkpoint_type text NOT NULL DEFAULT 'facility',
      is_active       boolean NOT NULL DEFAULT true,
      sort_order      int NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS event_checkpoints_ev_key ON event_checkpoints (event_id, checkpoint_key)`,
    `CREATE INDEX IF NOT EXISTS event_checkpoints_ev_idx ON event_checkpoints (event_id, sort_order)`,
    `ALTER TABLE event_checkpoints ADD COLUMN IF NOT EXISTS description text DEFAULT ''`,
    `CREATE TABLE IF NOT EXISTS checkpoint_claims (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      checkpoint_key  text NOT NULL,
      order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      ticket_code     text NOT NULL,
      qty             int NOT NULL DEFAULT 1,
      claimed_at      timestamptz NOT NULL DEFAULT now(),
      claimed_by      uuid REFERENCES users(id) ON DELETE SET NULL,
      claimed_by_name text DEFAULT '',
      notes           text DEFAULT '',
      created_at      timestamptz NOT NULL DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS checkpoint_claims_unique ON checkpoint_claims (order_id, checkpoint_key)`,
    `CREATE INDEX IF NOT EXISTS checkpoint_claims_ev_idx ON checkpoint_claims (event_id, checkpoint_key, claimed_at DESC)`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS enable_nametag boolean NOT NULL DEFAULT false`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS enable_certificate boolean NOT NULL DEFAULT false`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS certificate_config jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS custom_answers jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `CREATE TABLE IF NOT EXISTS organizers (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name                text NOT NULL,
      slug                text UNIQUE NOT NULL,
      description         text DEFAULT '',
      logo_url            text DEFAULT '',
      banner_url          text DEFAULT '',
      contact_email       text DEFAULT '',
      contact_phone       text DEFAULT '',
      bank_name           text DEFAULT '',
      bank_account_no     text DEFAULT '',
      bank_account_holder text DEFAULT '',
      is_verified         boolean NOT NULL DEFAULT true,
      created_at          timestamptz NOT NULL DEFAULT now()
    )`,
    `INSERT INTO organizers (id, name, slug, description, is_verified)
      VALUES ('00000000-0000-0000-0000-000000000001', 'Penyelenggara Utama', 'default', 'Penyelenggara resmi platform Ambiltiketnya.', true)
      ON CONFLICT (id) DO NOTHING`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS organizer_id uuid REFERENCES organizers(id)`,
    `UPDATE events SET organizer_id = '00000000-0000-0000-0000-000000000001' WHERE organizer_id IS NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS organizer_id uuid REFERENCES organizers(id)`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS active_modules jsonb NOT NULL DEFAULT '["ticketing"]'::jsonb`,
    `ALTER TABLE events ADD COLUMN IF NOT EXISTS module_config jsonb NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS rsvp_status text NOT NULL DEFAULT 'attending'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS plus_one_count int NOT NULL DEFAULT 0`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS guestbook_message text NOT NULL DEFAULT ''`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_assignment text NOT NULL DEFAULT ''`,
    `CREATE INDEX IF NOT EXISTS orders_guestbook_idx ON orders(event_id, created_at DESC) WHERE guestbook_message <> ''`
  ];
  for (const sql of ddlStatements) {
    try {
      await neonExec(env, sql);
    } catch (e) {
      console.error('ensureFeatureTables error:', e);
    }
  }
  _tablesEnsured = true;
}

const DEFAULT_CHECKPOINTS = [
  { key: 'main_gate', name: 'Pintu Masuk Utama', icon: '🎟️', type: 'gate', sort_order: 1 },
  { key: 'meal', name: 'Konsumsi (Lunch/Dinner/Snack)', icon: '🍱', type: 'meal', sort_order: 2 },
  { key: 'kit', name: 'Souvenir / Seminar Kit', icon: '🎁', type: 'kit', sort_order: 3 },
  { key: 'breakout', name: 'Breakout Session / Ruang Kelas', icon: '🚪', type: 'session', sort_order: 4 },
  { key: 'voucher', name: 'Voucher Diskon Bazaar', icon: '🏷️', type: 'voucher', sort_order: 5 }
];

async function ensureDefaultCheckpoints(env, eventId) {
  const existing = await neonQuery(env, `SELECT count(*)::int AS cnt FROM event_checkpoints WHERE event_id=$1::uuid`, [eventId]);
  if (!existing || !existing[0] || existing[0].cnt === 0) {
    for (const cp of DEFAULT_CHECKPOINTS) {
      await neonQuery(env, `INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, sort_order)
        VALUES($1::uuid, $2, $3, $4, $5, $6) ON CONFLICT (event_id, checkpoint_key) DO NOTHING`,
        [eventId, cp.key, cp.name, cp.icon, cp.type, cp.sort_order]);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // Ping check
    if (url.searchParams.get('ping')) {
      return json({ ok: true, ping: 'pong', time: new Date().toISOString() });
    }

    // Dynamic Invitation Link Preview for WhatsApp / Telegram / Social Media crawlers
    const pathnameNorm = url.pathname.toLowerCase().replace(/\/+$/, '');
    if (pathnameNorm === '/invite' || pathnameNorm === '/inv') {
      const code = String(url.searchParams.get('code') || url.searchParams.get('invite') || '').trim().toUpperCase();
      const guestTo = String(url.searchParams.get('to') || '').trim();
      let eventName = 'Undangan Acara';
      let bannerUrl = 'https://ambiltiketnya.online/favicon.png';
      let dateStr = '';
      let locationStr = '';
      let targetGuest = guestTo;

      if (code) {
        try {
          const rows = await neonQuery(env, `
            SELECT o.guest_name, e.name AS event_name, e.banner_url, e.event_date, e.start_time, e.location
            FROM orders o JOIN events e ON e.id = o.event_id WHERE o.ticket_code = $1 LIMIT 1
          `, [code]);
          if (rows.length) {
            const r = rows[0];
            eventName = r.event_name || eventName;
            bannerUrl = r.banner_url || bannerUrl;
            targetGuest = targetGuest || r.guest_name || '';
            dateStr = r.event_date ? new Date(r.event_date).toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
            locationStr = r.location || '';
          }
        } catch (e) {}
      }

      const redirectTarget = `https://ambiltiketnya.online/?invite=${encodeURIComponent(code)}&to=${encodeURIComponent(targetGuest)}`;
      const title = targetGuest ? `Undangan untuk ${targetGuest} - ${eventName}` : `Undangan Resmi: ${eventName}`;
      const desc = [dateStr, locationStr].filter(Boolean).join(' · ') || 'Buka tautan ini untuk informasi detail acara dan konfirmasi kehadiran (RSVP)';

      const html = `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="AmbilTiketnya">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:image" content="${bannerUrl}">
<meta property="og:image:alt" content="${eventName}">
<meta property="og:url" content="${redirectTarget}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
<meta name="twitter:image" content="${bannerUrl}">
<meta http-equiv="refresh" content="0;url=${redirectTarget}">
<script>location.replace(${JSON.stringify(redirectTarget)});</script>
<style>body{background:#0b0f1e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style>
</head>
<body>
<div>
<p style="font-size:16px">Membuka undangan digital ${eventName}...</p>
<p><a href="${redirectTarget}" style="color:#d4af37">Klik di sini jika tidak terbuka otomatis</a></p>
</div>
</body>
</html>`;

      return new Response(html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      });
    }

    if (request.method !== 'POST') {
      return json({ ok: true, service: 'ambiltiketnya-api', status: 'running' });
    }

    try {
      await ensureFeatureTables(env);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return errJson('BAD_REQUEST', 400);
      }

      const { fn, args = [] } = body;

      // Router API
      if (fn === 'init') {
        const [token] = args;
        const cfg = {
          scanUrl: env.SCAN_URL || 'https://ambiltiketnya.online/scan.html',
          appUrl: env.APP_URL || 'https://ambiltiketnya.online/',
          siteUrl: env.SITE_URL || 'https://ambiltiketnya.online',
          googleClientId: (env.GOOGLE_CLIENT_ID || '866753632616-opg57movh0h0th1av7b927d7fvrg3n6e.apps.googleusercontent.com').trim()
        };

        if (!token) {
          const events = await publicEventsList(env);
          return json({ cfg, events });
        }

        try {
          const u = await auth(env, token);
          const evs = await neonQuery(env, eventsSql('$1::uuid'), [u.id]);
          return json({ cfg, user: { ...u, needProfile: !u.whatsapp }, events: evs });
        } catch (e) {
          const events = await publicEventsList(env);
          return json({ cfg, authError: 'AUTH', events });
        }
      }

      if (fn === 'loginGoogle') {
        const [p] = args;
        const cred = String(p && p.credential || '').trim();
        if (!cred) throw new Error('BAD_GOOGLE_TOKEN');

        const gRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(cred)}`);
        if (gRes.status !== 200) throw new Error('BAD_GOOGLE_TOKEN');
        const payload = await gRes.json();

        const aud = (env.GOOGLE_CLIENT_ID || '866753632616-opg57movh0h0th1av7b927d7fvrg3n6e.apps.googleusercontent.com').trim();
        if (payload.aud !== aud) throw new Error('BAD_GOOGLE_AUD');
        if (!payload.email || (payload.email_verified !== 'true' && payload.email_verified !== true)) {
          throw new Error('BAD_GOOGLE_EMAIL');
        }

        const email = String(payload.email).trim().toLowerCase();
        const name = String(payload.name || payload.given_name || email.split('@')[0]).trim();
        const sub = String(payload.sub || '');
        const picture = String(payload.picture || '');

        let u = (await neonQuery(env, `SELECT id,whatsapp,age,church,role,locked_until FROM users WHERE lower(email)=$1`, [email]))[0];
        if (u) {
          if (u.locked_until && new Date(u.locked_until) > new Date()) throw new Error('LOCKED');
          await neonQuery(env, `UPDATE users SET failed_attempts=0,locked_until=NULL,google_sub=coalesce(google_sub,$1),picture=coalesce(picture,$2) WHERE id=$3::uuid RETURNING id`, [sub || null, picture || null, u.id]);
          const sess = await newSession(env, u.id);
          return json({ ok: true, data: { session: sess, isNewUser: !u.whatsapp } });
        }

        const sa = (env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const dummyPw = await hashPw(crypto.randomUUID(), crypto.randomUUID());
        const r = await neonQuery(env, `INSERT INTO users(name,email,password_hash,role,google_sub,picture)
          VALUES($1,$2::text,$3,CASE WHEN $2::text=$4::text AND NOT EXISTS(SELECT 1 FROM users WHERE role='super_admin') THEN 'super_admin' ELSE 'attendee' END,$5,$6)
          RETURNING id,whatsapp`, [name, email, dummyPw, sa, sub || null, picture || null]);

        const sess = await newSession(env, r[0].id);
        return json({ ok: true, data: { session: sess, isNewUser: true } });
      }

      if (fn === 'loginPw') {
        const [p] = args;
        const email = String(p.email || '').trim().toLowerCase();
        const pw = String(p.password || '');
        const u = (await neonQuery(env, `SELECT id,password_hash,failed_attempts,(locked_until IS NOT NULL AND locked_until>now()) AS locked FROM users WHERE lower(email)=$1`, [email]))[0];
        if (u && u.locked) throw new Error('LOCKED');
        const ok = u ? await checkPw(pw, u.password_hash) : false;
        if (!ok) {
          if (u) {
            await neonQuery(env, `UPDATE users SET failed_attempts=failed_attempts+1, locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '10 minutes' ELSE locked_until END WHERE id=$1::uuid RETURNING id`, [u.id]);
          }
          throw new Error('BAD_LOGIN');
        }
        await neonQuery(env, `UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=$1::uuid RETURNING id`, [u.id]);
        const sess = await newSession(env, u.id);
        return json({ ok: true, data: { session: sess } });
      }

      if (fn === 'register') {
        const [p] = args;
        const name = String(p.name || '').trim();
        const email = String(p.email || '').trim().toLowerCase();
        const wa = normPhone(p.whatsapp);
        const age = parseInt(p.age, 10);
        const church = String(p.church || '').trim();
        const pw = String(p.password || '');

        if (name.length < 2) throw new Error('BAD_NAME');
        if (!EMAIL_RE.test(email)) throw new Error('BAD_EMAIL');
        if (!wa) throw new Error('BAD_PHONE');
        if (!(age >= 1 && age <= 120)) throw new Error('BAD_AGE');
        if (church.length < 2) throw new Error('BAD_CHURCH');
        if (pw.length < 8) throw new Error('WEAK_PW');
        if (pw !== String(p.confirm || '')) throw new Error('PW_MISMATCH');

        const sa = (env.SUPERADMIN_EMAIL || '').trim().toLowerCase();
        const pwHash = await hashPw(pw, crypto.randomUUID());
        const r = await neonQuery(env, `INSERT INTO users(name,email,whatsapp,age,church,password_hash,role)
          VALUES($1,$2::text,$3,$4::int,$5,$6, CASE WHEN $2::text=$7::text AND NOT EXISTS(SELECT 1 FROM users WHERE role='super_admin') THEN 'super_admin' ELSE 'attendee' END)
          ON CONFLICT DO NOTHING RETURNING id`, [name, email, wa, age, church, pwHash, sa]);

        if (!r.length) throw new Error('EMAIL_TAKEN');
        const sess = await newSession(env, r[0].id);
        return json({ ok: true, data: { session: sess } });
      }

      if (fn === 'gateLogin') {
        const [p] = args;
        const evId = String(p.eventId || '').trim().toLowerCase();
        const key = String(p.key || '').trim().toLowerCase();
        if (!evId || !key) throw new Error('BAD_GATE');

        const k1 = (await sha256('gate_' + evId)).slice(0, 16).toLowerCase();
        const k2 = (await sha256('gate_' + evId + '_' + env.DATABASE_URL)).slice(0, 16).toLowerCase();
        const k3 = (await sha256('gate_pass_' + evId)).slice(0, 16).toLowerCase();
        if (key !== k1 && key !== k2 && key !== k3) throw new Error('INVALID_KEY');

        const ev = (await neonQuery(env, `SELECT id, name FROM events WHERE id=$1::uuid`, [evId]))[0];
        if (!ev) throw new Error('EVENT_NOT_FOUND');

        let vol = (await neonQuery(env, `SELECT id, name, role, email FROM users WHERE lower(email)='gate_volunteer@ambiltiketnya.online'`))[0];
        if (!vol) {
          try {
            const ins = await neonQuery(env, `INSERT INTO users(name,email,whatsapp,age,church,password_hash,role)
              VALUES('Petugas Gerbang','gate_volunteer@ambiltiketnya.online','628123456789',25,'Panitia Gerbang','!','gate_staff')
              ON CONFLICT (lower(email)) DO UPDATE SET role='gate_staff'
              RETURNING id,name,role,email`);
            vol = ins[0];
          } catch (eIns) {
            vol = (await neonQuery(env, `SELECT id, name, role, email FROM users WHERE lower(email)='gate_volunteer@ambiltiketnya.online'`))[0];
          }
        }
        if (!vol) {
          try {
            const ins2 = await neonQuery(env, `INSERT INTO users(name,email,whatsapp,age,church,password_hash,role)
              VALUES('Petugas Gerbang','gate_volunteer@ambiltiketnya.online','628123456789',25,'Panitia Gerbang','!','gate_staff')
              RETURNING id,name,role,email`);
            vol = ins2[0];
          } catch (eIns2) {
            vol = (await neonQuery(env, `SELECT id, name, role, email FROM users WHERE lower(email)='gate_volunteer@ambiltiketnya.online'`))[0];
          }
        }
        if (!vol) throw new Error('VOLUNTEER_FAIL');

        const sess = await newSession(env, vol.id);
        return json({ ok: true, data: { session: sess, user: vol, role: 'gate_staff', name: 'Petugas Gerbang', eventId: ev.id, eventName: ev.name } });
      }

      if (fn === 'guestbookWall') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        if (!evId) throw new Error('EVENT_REQUIRED');
        await ensureFeatureTables(env);
        const rows = await neonQuery(env, `
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
        const ev = (await neonQuery(env, `SELECT id, name, banner_url, coalesce(active_modules, '["ticketing"]'::jsonb) AS active_modules FROM events WHERE id=$1::uuid`, [evId]))[0] || null;
        return json({ ok: true, data: { messages: rows, event: ev } });
      }

      if (fn === 'digitalInvitationInfo') {
        const [p] = args;
        const code = String(p && (p.code || p.invite || p.undangan) || '').trim();
        if (!code) throw new Error('CODE_REQUIRED');
        await ensureFeatureTables(env);

        // Check if code matches an order (ticket_code, order_code, id)
        const ordRows = await neonQuery(env, `
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
          const wishes = await neonQuery(env, `
            SELECT coalesce(o.guest_name, u.name) AS name, coalesce(o.guest_org, u.church) AS org,
              o.guestbook_message AS message, to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon HH24:MI') AS time_str
            FROM orders o
            LEFT JOIN users u ON u.id = o.user_id
            WHERE o.event_id = $1::uuid AND o.guestbook_message <> '' AND o.status <> 'cancelled' AND o.status <> 'declined'
            ORDER BY o.created_at DESC LIMIT 15
          `, [o.event_id]);
          return json({ ok: true, data: { found: true, type: 'order', order: o, wishes } });
        }

        // Check if code matches an event ID
        const evRows = await neonQuery(env, `
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
          const wishes = await neonQuery(env, `
            SELECT coalesce(o.guest_name, u.name) AS name, coalesce(o.guest_org, u.church) AS org,
              o.guestbook_message AS message, to_char(o.created_at AT TIME ZONE 'Asia/Jakarta', 'DD Mon HH24:MI') AS time_str
            FROM orders o
            LEFT JOIN users u ON u.id = o.user_id
            WHERE o.event_id = $1::uuid AND o.guestbook_message <> '' AND o.status <> 'cancelled' AND o.status <> 'declined'
            ORDER BY o.created_at DESC LIMIT 15
          `, [ev.id]);
          return json({ ok: true, data: { found: true, type: 'event', event: ev, wishes } });
        }

        return json({ ok: true, data: { found: false } });
      }

      if (fn === 'digitalInvitationRsvp') {
        const [p] = args;
        const code = String(p && p.code || '').trim();
        const rsvpStatus = String(p && p.rsvp_status || 'attending').trim().toLowerCase();
        let plusOne = Math.max(0, parseInt(p && p.plus_one_count, 10) || 0);
        const message = String(p && p.guestbook_message || '').trim().slice(0, 1000);
        const guestName = String(p && p.guest_name || '').trim();
        const guestPhone = String(p && p.guest_phone || '').trim();
        const guestOrg = String(p && p.guest_org || '').trim();

        await ensureFeatureTables(env);

        // Check if updating existing order
        const ordRows = await neonQuery(env, `SELECT o.id, o.event_id, o.qty, o.status, e.module_config FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1 OR o.order_code=$1 OR o.id::text=$1`, [code]);
        if (ordRows.length) {
          const ord = ordRows[0];
          let maxPO = 2;
          let allowPO = true;
          if (ord.module_config) {
            let cfg = ord.module_config;
            if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch(x) { cfg = {}; } }
            if (cfg.allow_plus_one === false) allowPO = false;
            if (cfg.max_plus_one != null) maxPO = Math.max(0, parseInt(cfg.max_plus_one, 10) || 0);
          }
          if (!allowPO || maxPO === 0) plusOne = 0;
          else plusOne = Math.min(maxPO, plusOne);

          const isDeclined = rsvpStatus === 'declined';
          const newQty = isDeclined ? 1 : (1 + plusOne);
          const newStatus = isDeclined ? 'declined' : 'confirmed';
          await neonQuery(env, `UPDATE orders SET rsvp_status=$1, plus_one_count=$2, guestbook_message=$3, qty=$4, status=$5 WHERE id=$6::uuid`, [rsvpStatus, plusOne, message, newQty, newStatus, ord.id]);
          return json({ ok: true, data: { success: true, status: newStatus, rsvp_status: rsvpStatus, plus_one_count: plusOne } });
        }

        // Open event registration
        const evRows = await neonQuery(env, `SELECT id, name, quota, module_config FROM events WHERE id::text=$1 AND is_active=true`, [code]);
        if (!evRows.length) throw new Error('NOT_FOUND');
        const ev = evRows[0];
        let maxPO = 2;
        let allowPO = true;
        if (ev.module_config) {
          let cfg = ev.module_config;
          if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch(x) { cfg = {}; } }
          if (cfg.allow_plus_one === false) allowPO = false;
          if (cfg.max_plus_one != null) maxPO = Math.max(0, parseInt(cfg.max_plus_one, 10) || 0);
        }
        if (!allowPO || maxPO === 0) plusOne = 0;
        else plusOne = Math.min(maxPO, plusOne);

        const isDeclined = rsvpStatus === 'declined';
        const qty = isDeclined ? 1 : (1 + plusOne);
        const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
        const tCode = 'INV-' + prefix + '-' + rnd(6);
        const oCode = rnd(8);

        const defaultUser = (await neonQuery(env, `SELECT id FROM users ORDER BY created_at ASC LIMIT 1`))[0];
        const r = await neonQuery(env, `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org,guest_phone,rsvp_status,plus_one_count,guestbook_message)
          VALUES($1,$2,$3::uuid,$4::uuid,$5::int,0,$6,'invitation',$7,$8,$9,$10,$11::int,$12) RETURNING id,ticket_code`, [oCode, tCode, defaultUser.id, ev.id, qty, isDeclined ? 'declined' : 'confirmed', guestName || 'Tamu Undangan', guestOrg || '', guestPhone || null, rsvpStatus, plusOne, message]);
        return json({ ok: true, data: { success: true, ticket_code: r[0].ticket_code, rsvp_status: rsvpStatus, plus_one_count: plusOne } });
      }

      if (fn === 'organizerPublic') {
        const [p] = args;
        const slug = String(p && p.slug || '').trim();
        const id = String(p && p.id || '').trim();
        if (!slug && !id) throw new Error('SLUG_OR_ID_REQUIRED');
        await ensureFeatureTables(env);
        const orgs = await neonQuery(env, `SELECT id, name, slug, description, logo_url, banner_url, contact_email, contact_phone, is_verified, created_at FROM organizers WHERE ($1::text <> '' AND slug=$1::text) OR ($2::text <> '' AND id=$2::uuid) LIMIT 1`, [slug, id || null]);
        if (!orgs.length) return json({ ok: true, data: { found: false } });
        const org = orgs[0];
        const events = await neonQuery(env, `SELECT id, name, category, banner_url, description, event_date::text AS edate, to_char(start_time,'HH24:MI') AS stime, to_char(end_time,'HH24:MI') AS etime, location, quota, is_paid, price, is_active,
          coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=events.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0)::int AS booked
          FROM events WHERE organizer_id=$1::uuid AND is_active=true ORDER BY event_date ASC`, [org.id]);
        return json({ ok: true, data: { found: true, organizer: org, events } });
      }

      if (fn === 'ticketPublic') {
        const [p] = args;
        const code = String(p.code || '').trim().toUpperCase();
        const rows = await neonQuery(env, `SELECT o.ticket_code AS code,o.qty,o.status,o.checked_in,o.checked_in_at,o.kind,
          coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
          coalesce(o.rsvp_status, 'attending') AS rsvp_status,
          coalesce(o.plus_one_count, 0)::int AS plus_one_count,
          coalesce(o.guestbook_message, '') AS guestbook_message,
          coalesce(o.table_assignment, '') AS table_assignment,
          CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS guest_name,
          CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS guest_org,
          e.id AS event_id,e.name,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location,e.terms,
          coalesce(e.enable_nametag, false)::boolean AS enable_nametag,
          coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
          coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config
          FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN users u ON u.id=o.user_id WHERE o.ticket_code=$1`, [code]);
        if (!rows.length) return json({ ok: true, data: { found: false } });
        const o = rows[0];
        const st = o.status === 'cancelled' ? 'CANCELLED' : o.status === 'pending_payment' ? 'UNPAID' : o.checked_in >= o.qty ? 'USED' : 'OK';
        return json({ ok: true, data: { found: true, ...o, status: st } });
      }

      if (fn === 'certificateVerify') {
        const [p] = args;
        const code = String(p && p.code || '').trim().toUpperCase().replace(/\s/g, '');
        if (!code) throw new Error('NOT_FOUND');
        await ensureFeatureTables(env);
        const rows = await neonQuery(env, `SELECT o.ticket_code, o.checked_in, o.checked_in_at,
          coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
          coalesce(o.rsvp_status, 'attending') AS rsvp_status,
          coalesce(o.plus_one_count, 0)::int AS plus_one_count,
          coalesce(o.guestbook_message, '') AS guestbook_message,
          coalesce(o.table_assignment, '') AS table_assignment,
          CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
          CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org,
          e.name AS event_name, e.event_date::text AS event_date, to_char(e.start_time, 'HH24:MI') AS start_time, e.location,
          coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
          coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config
          FROM orders o JOIN events e ON e.id=o.event_id LEFT JOIN users u ON u.id=o.user_id
          WHERE o.ticket_code=$1`, [code]);
        if (!rows.length) return json({ ok: true, data: { verified: false, code } });
        const r = rows[0];
        const valid = r.enable_certificate && r.checked_in > 0;
        return json({
          ok: true,
          data: {
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
          }
        });
      }

      if (fn === 'legalPublic') {
        const [p] = args;
        const key = String(p && p.key || '');
        const r = (await neonQuery(env, `SELECT value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS d FROM settings WHERE key=$1`, ['legal_' + key]))[0];
        const def = LEGAL[key] || { title: 'Informasi Hukum', text: '' };
        return json({ ok: true, data: { title: def.title, updated: r ? r.d : '2026-10-18', html: `<p style="white-space:pre-wrap">${r ? r.value : def.text}</p>` } });
      }

      if (fn === 'ticketFacilities') {
        const [p] = args;
        const code = String(p && p.code || '').trim().toUpperCase().replace(/\s/g, '');
        if (!code) throw new Error('NOT_FOUND');
        await ensureFeatureTables(env);
        const ord = (await neonQuery(env, `SELECT id, event_id, status, checked_in, checked_in_at, qty FROM orders WHERE ticket_code=$1`, [code]))[0];
        if (!ord) return json({ ok: true, data: { items: [] } });

        await ensureDefaultCheckpoints(env, ord.event_id);

        const checkpoints = await neonQuery(env, `
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

        return json({ ok: true, data: { items } });
      }

      if (fn === 'sessionStageLiveCount') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        const cpKey = String(p && p.checkpointKey || '').trim();
        if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
        await ensureFeatureTables(env);
        const countRes = (await neonQuery(env, `
          SELECT count(DISTINCT order_id)::int AS cnt
          FROM checkpoint_claims
          WHERE event_id=$1::uuid AND checkpoint_key=$2
        `, [evId, cpKey]))[0];
        return json({ ok: true, data: { count: countRes ? countRes.cnt : 0 } });
      }

      if (fn === 'sessionSelfCheckin') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        const cpKey = String(p && p.checkpointKey || '').trim();
        const rawInput = String(p && (p.ticketCode || p.code || p.phone || '')).trim();

        if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
        if (!rawInput) throw new Error('TICKET_OR_PHONE_REQUIRED');

        await ensureFeatureTables(env);

        const cp = (await neonQuery(env, `SELECT * FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2 AND is_active=true`, [evId, cpKey]))[0];
        if (!cp) return json({ ok: false, error: 'CHECKPOINT_NOT_FOUND', message: 'Sesi / pos check-in ini tidak aktif atau tidak ditemukan.' });

        const ev = (await neonQuery(env, `SELECT id, name FROM events WHERE id=$1::uuid`, [evId]))[0];
        if (!ev) return json({ ok: false, error: 'EVENT_NOT_FOUND', message: 'Acara tidak ditemukan.' });

        let ord = null;
        const cleanInput = rawInput.toUpperCase().replace(/\s/g, '');
        const cleanDigits = rawInput.replace(/[^0-9]/g, '');

        if (cleanInput.startsWith('TKT-') || cleanInput.length >= 6) {
          ord = (await neonQuery(env, `
            SELECT o.*, u.name AS user_name, u.whatsapp AS user_phone, u.church AS user_church
            FROM orders o
            LEFT JOIN users u ON u.id=o.user_id
            WHERE o.event_id=$1::uuid AND (upper(o.ticket_code)=$2 OR upper(o.order_code)=$2) AND o.status='confirmed'
            LIMIT 1
          `, [evId, cleanInput]))[0];
        }

        if (!ord && cleanDigits.length >= 8) {
          const suffix = cleanDigits.slice(-8);
          ord = (await neonQuery(env, `
            SELECT o.*, u.name AS user_name, u.whatsapp AS user_phone, u.church AS user_church
            FROM orders o
            LEFT JOIN users u ON u.id=o.user_id
            WHERE o.event_id=$1::uuid AND o.status='confirmed' AND (
              replace(replace(coalesce(o.guest_phone, ''), '+', ''), ' ', '') LIKE '%' || $2 || '%' OR
              replace(replace(coalesce(u.whatsapp, ''), '+', ''), ' ', '') LIKE '%' || $2 || '%'
            )
            ORDER BY o.created_at DESC LIMIT 1
          `, [evId, suffix]))[0];
        }

        if (!ord) {
          return json({
            ok: false,
            error: 'NOT_FOUND',
            message: 'Tiket tidak ditemukan untuk acara ini. Pastikan Kode Tiket atau Nomor WhatsApp terdaftar sudah benar.'
          });
        }

        const attendeeName = (ord.kind === 'invitation' || ord.kind === 'walk_in') ? (ord.guest_name || 'Peserta') : (ord.user_name || 'Peserta');
        const attendeeOrg = (ord.kind === 'invitation' || ord.kind === 'walk_in') ? (ord.guest_org || '') : (ord.user_church || '');

        if (cpKey !== 'main_gate' && (ord.checked_in || 0) <= 0) {
          return json({
            ok: false,
            error: 'NOT_CHECKED_IN',
            message: 'Anda belum melakukan check-in di Pintu Gerbang Utama. Silakan registrasi di meja kedatangan depan terlebih dahulu.',
            attendeeName: attendeeName,
            checkpoint: cp
          });
        }

        const existingClaim = (await neonQuery(env, `SELECT * FROM checkpoint_claims WHERE order_id=$1::uuid AND checkpoint_key=$2`, [ord.id, cpKey]))[0];
        if (existingClaim) {
          const claimedTime = new Date(existingClaim.claimed_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
          return json({
            ok: false,
            error: 'ALREADY_CLAIMED',
            message: `Anda sudah tercatat hadir di ${cp.name} pada pukul ${claimedTime} WIB.`,
            attendeeName: attendeeName,
            checkpoint: cp,
            claimed_at: existingClaim.claimed_at
          });
        }

        const qtyToClaim = Math.max(1, ord.qty || 1);
        await neonQuery(env, `
          INSERT INTO checkpoint_claims (event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by_name)
          VALUES ($1::uuid, $2, $3::uuid, $4, $5, 'Presensi Mandiri (Self-Checkin)')
        `, [evId, cpKey, ord.id, ord.ticket_code, qtyToClaim]);

        return json({
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
        });
      }

      if (fn === 'checkpointPublicInfo') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        const cpKey = String(p && p.checkpointKey || '').trim();
        if (!evId || !cpKey) throw new Error('PARAMS_REQUIRED');
        await ensureFeatureTables(env);
        const ev = (await neonQuery(env, `SELECT id, name, event_date, banner_url, location, start_time FROM events WHERE id=$1::uuid`, [evId]))[0];
        if (!ev) throw new Error('EVENT_NOT_FOUND');
        const cp = (await neonQuery(env, `SELECT * FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2 AND is_active=true`, [evId, cpKey]))[0];
        if (!cp) throw new Error('CHECKPOINT_NOT_FOUND');
        const liveCnt = (await neonQuery(env, `SELECT count(DISTINCT order_id)::int AS cnt FROM checkpoint_claims WHERE event_id=$1::uuid AND checkpoint_key=$2`, [evId, cpKey]))[0];
        return json({ ok: true, data: { event: ev, checkpoint: cp, attendeesCount: liveCnt ? liveCnt.cnt : 0 } });
      }

      if (fn === 'surveyInfo') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        const fid = String(p && p.feedbackId || '').trim();
        const clientToken = String(p && (p.clientToken || p.deviceId) || '').trim();
        if (!evId) throw new Error('EVENT_NOT_FOUND');
        const ev = (await neonQuery(env, `SELECT id, name, banner_url, event_date::text AS edate, to_char(start_time,'HH24:MI') AS stime, location FROM events WHERE id=$1::uuid`, [evId]))[0];
        if (!ev) throw new Error('EVENT_NOT_FOUND');

        let myFeedback = null;
        await ensureFeatureTables(env);
        if (fid) {
          myFeedback = (await neonQuery(env, `SELECT id, rating AS rating_overall, coalesce(rating_content,5) AS rating_content, coalesce(rating_service,5) AS rating_service, coalesce(rating_venue,5) AS rating_venue, coalesce(rating_sound,5) AS rating_sound, aspects, comment, is_anonymous, guest_name, guest_org FROM event_feedbacks WHERE id=$1::uuid AND event_id=$2::uuid`, [fid, evId]))[0] || null;
        }
        if (!myFeedback && clientToken) {
          myFeedback = (await neonQuery(env, `SELECT id, rating AS rating_overall, coalesce(rating_content,5) AS rating_content, coalesce(rating_service,5) AS rating_service, coalesce(rating_venue,5) AS rating_venue, coalesce(rating_sound,5) AS rating_sound, aspects, comment, is_anonymous, guest_name, guest_org FROM event_feedbacks WHERE event_id=$1::uuid AND client_token=$2 ORDER BY created_at DESC LIMIT 1`, [evId, clientToken]))[0] || null;
        }

        const cnt = (await neonQuery(env, `SELECT count(*)::int AS count FROM event_feedbacks WHERE event_id=$1::uuid`, [evId]))[0];

        return json({ ok: true, data: { event: ev, count: cnt ? cnt.count : 0, myFeedback: myFeedback } });
      }

      if (fn === 'surveyStagePoll') {
        const [p] = args;
        const evId = String(p && p.eventId || '').trim();
        if (!evId) throw new Error('EVENT_NOT_FOUND');
        const ev = (await neonQuery(env, `SELECT id, name, banner_url, event_date::text AS edate FROM events WHERE id=$1::uuid`, [evId]))[0];
        if (!ev) throw new Error('EVENT_NOT_FOUND');
        await ensureFeatureTables(env);
        const stat = (await neonQuery(env, `SELECT count(*)::int AS count, coalesce(round(avg(rating)::numeric,1),0)::float AS avg FROM event_feedbacks WHERE event_id=$1::uuid`, [evId]))[0];
        return json({ ok: true, data: { event: ev, count: stat ? stat.count : 0, avg: stat ? stat.avg : 0 } });
      }

      if (fn === 'feedbackPublic') {
        const [p] = args;
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

        let targetEventId = eventId;
        let targetOrderId = null;
        let gName = '';
        let gOrg = '';

        if (code) {
          const ord = (await neonQuery(env, `SELECT o.id, o.event_id,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org
            FROM orders o LEFT JOIN users u ON u.id=o.user_id WHERE o.ticket_code=$1`, [code]))[0];
          if (ord) {
            targetOrderId = ord.id;
            targetEventId = ord.event_id;
            gName = ord.name || '';
            gOrg = ord.org || '';
          }
        }
        if (!targetEventId) throw new Error('EVENT_NOT_FOUND');

        await ensureFeatureTables(env);

        // 1. Edit Feedback berdasarkan feedbackId jika dikirimkan
        if (p && p.feedbackId) {
          const fid = String(p.feedbackId).trim();
          const upd = await neonQuery(env, `
            UPDATE event_feedbacks
            SET rating=$1, rating_content=$2, rating_service=$3, rating_venue=$4, rating_sound=$5, aspects=$6::jsonb,
                is_anonymous=$7, guest_name=$8, guest_org=$9, comment=$10, client_token=coalesce(nullif($11,''), client_token), created_at=now()
            WHERE id=$12::uuid AND event_id=$13::uuid
            RETURNING id
          `, [rOverall, rContent, rService, rVenue, rSound, aspectsJson, isAnon, isAnon ? '' : (gName || (p.guestName || '')), isAnon ? '' : (gOrg || (p.guestOrg || '')), comment, clientToken, fid, targetEventId]);
          if (upd.length) {
            return json({ ok: true, data: { success: true, id: upd[0].id, updated: true } });
          }
        }

        // 2. Anti-duplikasi: Cek apakah perangkat HP ini (clientToken) sudah pernah mengisi untuk acara ini
        if (clientToken) {
          const existing = await neonQuery(env, `SELECT id FROM event_feedbacks WHERE event_id=$1::uuid AND client_token=$2 ORDER BY created_at DESC LIMIT 1`, [targetEventId, clientToken]);
          if (existing.length) {
            const upd = await neonQuery(env, `
              UPDATE event_feedbacks
              SET rating=$1, rating_content=$2, rating_service=$3, rating_venue=$4, rating_sound=$5, aspects=$6::jsonb,
                  is_anonymous=$7, guest_name=$8, guest_org=$9, comment=$10, created_at=now()
              WHERE id=$11::uuid
              RETURNING id
            `, [rOverall, rContent, rService, rVenue, rSound, aspectsJson, isAnon, isAnon ? '' : (gName || (p.guestName || '')), isAnon ? '' : (gOrg || (p.guestOrg || '')), comment, existing[0].id]);
            return json({ ok: true, data: { success: true, id: upd[0].id, updated: true } });
          }
        }

        // 3. Simpan ulasan baru
        const ins = await neonQuery(env, `INSERT INTO event_feedbacks(event_id, order_id, ticket_code, guest_name, guest_org, is_anonymous, rating, rating_content, rating_service, rating_venue, rating_sound, aspects, category, comment, client_token)
          VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15)
          RETURNING id`,
          [targetEventId, targetOrderId, code, isAnon ? '' : (gName || (p && p.guestName || '')), isAnon ? '' : (gOrg || (p && p.guestOrg || '')), isAnon, rOverall, rContent, rService, rVenue, rSound, aspectsJson, category, comment, clientToken]);
        return json({ ok: true, data: { success: true, id: ins[0].id } });
      }

      // DISPATCHER API TEROTORISASI
      if (fn === 'api') {
        const [token, action, params = {}] = args;
        const u = await auth(env, token);

        // Helper cek role
        const needRole = minR => { if (RANK[u.role] < minR) throw new Error('FORBIDDEN'); };

        if (action === 'me') {
          return json({ ok: true, data: { ...u, needProfile: !u.whatsapp } });
        }

        if (action === 'saveProfile') {
          const wa = normPhone(params.whatsapp), age = parseInt(params.age, 10), church = String(params.church || '').trim();
          const name = String(params.name || '').trim();
          if (name && name.length < 2) throw new Error('BAD_NAME');
          if (!wa) throw new Error('BAD_PHONE');
          if (!(age >= 1 && age <= 120)) throw new Error('BAD_AGE');
          if (church.length < 2) throw new Error('BAD_CHURCH');
          if (name) {
            await neonQuery(env, `UPDATE users SET name=$1,whatsapp=$2,age=$3::int,church=$4 WHERE id=$5::uuid`, [name, wa, age, church, u.id]);
          } else {
            await neonQuery(env, `UPDATE users SET whatsapp=$1,age=$2::int,church=$3 WHERE id=$4::uuid`, [wa, age, church, u.id]);
          }
          const updated = (await neonQuery(env, `SELECT id,name,email,whatsapp,age,church,role,picture FROM users WHERE id=$1::uuid`, [u.id]))[0];
          return json({ ok: true, data: { ...updated, needProfile: false } });
        }

        if (action === 'events') {
          const evs = await neonQuery(env, eventsSql('$1::uuid'), [u.id]);
          return json({ ok: true, data: evs });
        }

        if (action === 'myTickets') {
          const rows = await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,
            coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
          coalesce(o.rsvp_status, 'attending') AS rsvp_status,
          coalesce(o.plus_one_count, 0)::int AS plus_one_count,
          coalesce(o.guestbook_message, '') AS guestbook_message,
          coalesce(o.table_assignment, '') AS table_assignment,
            coalesce(e.enable_nametag, false)::boolean AS enable_nametag,
            coalesce(e.enable_certificate, false)::boolean AS enable_certificate,
            coalesce(e.certificate_config, '{}'::jsonb) AS certificate_config,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions,e.terms
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.user_id=$1::uuid AND o.kind='order' ORDER BY o.created_at DESC`, [u.id]);
          return json({ ok: true, data: rows });
        }

        if (action === 'orderDetail') {
          const r = (await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.status,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_age,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.terms
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1::uuid`, [params.id]))[0];
          return json({ ok: true, data: r });
        }

        if (action === 'book') {
          const rsvpStatus = String(params.rsvp_status || 'attending').trim().toLowerCase();
          const plusOne = Math.max(0, parseInt(params.plus_one_count, 10) || 0);
          const isDeclined = rsvpStatus === 'declined';
          const qty = isDeclined ? 1 : (parseInt(params.qty, 10) || (1 + plusOne));
          const guestbookMsg = String(params.guestbook_message || '').trim().slice(0, 1000);
          const tableAssign = String(params.table_assignment || '').trim().slice(0, 100);

          const ev = (await neonQuery(env, `SELECT name, quota, is_paid, price, max_per_order, one_order_per_account,
            coalesce(active_modules, '["ticketing"]'::jsonb) AS active_modules
            FROM events WHERE id=$1::uuid AND is_active`, [params.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
          const ticketCode = (isDeclined ? 'RSP-DECL-' : 'TKT-' + prefix + '-') + rnd(6);
          const orderCode = rnd(8);

          const customAnswers = typeof params.custom_answers === 'object' ? JSON.stringify(params.custom_answers || {}) : (params.custom_answers || '{}');
          const initialStatus = isDeclined ? 'declined' : (ev.is_paid ? 'pending_payment' : 'confirmed');

          const r = await neonQuery(env, `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,custom_answers,rsvp_status,plus_one_count,guestbook_message,table_assignment)
            SELECT $1,$2,$3::uuid,e.id,$4::int,CASE WHEN $7='declined' THEN 0 ELSE (e.price*$4::int) END, $7::text, $6::jsonb, $7::text, $8::int, $9::text, $10::text
            FROM events e WHERE e.id=$5::uuid AND e.is_active
             AND ($7='declined' OR ((SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled' AND status<>'declined' AND kind<>'walk_in') + $4::int <= e.quota))
             AND (NOT e.one_order_per_account OR NOT EXISTS(SELECT 1 FROM orders WHERE event_id=e.id AND user_id=$3::uuid AND status<>'cancelled' AND kind='order'))
            RETURNING id,status,ticket_code`, [orderCode, ticketCode, u.id, qty, params.eventId, customAnswers, initialStatus, plusOne, guestbookMsg, tableAssign]);

          if (!r.length) throw new Error('SOLDOUT');

          // Kirim email notifikasi secara asynchronous di background
          ctx.waitUntil((async () => {
            try {
              if (r[0].status === 'confirmed') {
                await sendEmail(env, {
                  to: u.email,
                  subject: `[TIKET RESMI] ${ev.name} - ${ticketCode}`,
                  htmlBody: `<p>Halo ${u.name}, pemesanan tiket Anda berhasil!</p><p>Kode Tiket: <b>${ticketCode}</b> (${qty} tiket)</p>`
                });
                await neonQuery(env, `UPDATE orders SET emailed=true, emailed_at=now() WHERE id=$1::uuid`, [r[0].id]);
              }
            } catch (err) { console.error('Auto email err:', err); }
          })());

          return json({ ok: true, data: { id: r[0].id, status: r[0].status, ticket_code: r[0].ticket_code, emailed: true } });
        }

        if (action === 'validate') {
          needRole(1);
          await ensureFeatureTables(env);
          const code = String(params.code || '').trim().toUpperCase().replace(/\s/g, '');
          const cpKey = String(params.checkpoint || 'main_gate').trim();
          const rows = await neonQuery(env, `SELECT o.id,o.qty,o.status,o.checked_in,o.checked_in_at,o.kind,o.event_id,
            coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
          coalesce(o.rsvp_status, 'attending') AS rsvp_status,
          coalesce(o.plus_one_count, 0)::int AS plus_one_count,
          coalesce(o.guestbook_message, '') AS guestbook_message,
          coalesce(o.table_assignment, '') AS table_assignment,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,
            e.name AS event_name,
            coalesce(e.enable_nametag, false)::boolean AS enable_nametag,
            coalesce(e.enable_certificate, false)::boolean AS enable_certificate
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code]);
          if (!rows.length) return json({ ok: true, data: { result: 'NOT_FOUND', code } });
          const o = rows[0];
          await ensureDefaultCheckpoints(env, o.event_id);

          const cpInfo = (await neonQuery(env, `SELECT checkpoint_key, name, icon, checkpoint_type FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2`, [o.event_id, cpKey]))[0] || { checkpoint_key: cpKey, name: cpKey === 'main_gate' ? 'Pintu Masuk Utama' : cpKey, icon: '📍', checkpoint_type: 'facility' };

          const base = { code, kind: o.kind, name: o.name, church: o.church, age: o.age, whatsapp: o.whatsapp, event: o.event_name, qty: o.qty, at: o.checked_in_at, checkpoint: cpInfo, enable_nametag: o.enable_nametag, enable_certificate: o.enable_certificate, custom_answers: o.custom_answers, table_assignment: o.table_assignment, rsvp_status: o.rsvp_status, plus_one_count: o.plus_one_count };
          if (o.status === 'cancelled') return json({ ok: true, data: { ...base, result: 'CANCELLED' } });
          if (o.status === 'pending_payment') return json({ ok: true, data: { ...base, result: 'UNPAID' } });

          // MAIN GATE
          if (cpKey === 'main_gate') {
            const curChecked = parseInt(o.checked_in, 10) || 0;
            const remaining = Math.max(0, o.qty - curChecked);
            if (remaining <= 0) {
              return json({ ok: true, data: { ...base, result: 'USED', checked: curChecked, qty: o.qty, message: `Semua kuota tiket (${o.qty} orang) sudah check-in.` } });
            }

            // Tiket rombongan (qty > 1) dan belum ada konfirmasi/input jumlah masuk
            if (o.qty > 1 && !params.confirm && !params.entered_qty) {
              return json({
                ok: true,
                data: {
                  ...base,
                  result: 'CONFIRM_PARTIAL',
                  checked: curChecked,
                  remaining: remaining,
                  qty: o.qty,
                  message: `Tiket rombongan (${o.qty} orang). ${curChecked > 0 ? curChecked + ' orang sudah masuk sebelumnya. ' : ''}Sisa kuota: ${remaining} orang.`
                }
              });
            }

            const enterQty = Math.min(remaining, Math.max(1, parseInt(params.entered_qty, 10) || remaining));
            const newChecked = curChecked + enterQty;

            await neonQuery(env, `UPDATE orders SET checked_in=$1, checked_in_at=now(), checked_in_by=$2::uuid WHERE id=$3::uuid`, [newChecked, u.id, o.id]);
            await neonQuery(env, `INSERT INTO checkpoint_claims(event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by, claimed_by_name)
              VALUES($1::uuid, 'main_gate', $2::uuid, $3, $4::int, $5::uuid, $6)
              ON CONFLICT (order_id, checkpoint_key) DO UPDATE SET qty = checkpoint_claims.qty + EXCLUDED.qty, claimed_at = now()`,
              [o.event_id, o.id, code, enterQty, u.id, u.name || 'Petugas Gerbang']);

            return json({
              ok: true,
              data: {
                ...base,
                result: 'VALID',
                entered: enterQty,
                checked: newChecked,
                remaining: o.qty - newChecked,
                is_partial: newChecked < o.qty,
                at: new Date().toISOString()
              }
            });
          }

          // FACILITY / BREAKOUT / MEAL / KIT / VOUCHER
          // 1. Prerequisite check: Must be checked in at main gate
          if (o.checked_in <= 0) {
            return json({
              ok: true,
              data: {
                ...base,
                result: 'NOT_CHECKED_IN',
                message: 'Peserta belum check-in di Pintu Masuk Utama! Arahkan ke meja registrasi / gerbang masuk terlebih dahulu.'
              }
            });
          }

          // 2. Check if already claimed
          const existingClaim = (await neonQuery(env, `SELECT claimed_at, to_char(claimed_at AT TIME ZONE 'Asia/Jakarta','HH24:MI') AS claim_time, claimed_by_name, qty FROM checkpoint_claims WHERE order_id=$1::uuid AND checkpoint_key=$2`, [o.id, cpKey]))[0];
          if (existingClaim) {
            return json({
              ok: true,
              data: {
                ...base,
                result: 'ALREADY_CLAIMED',
                message: `${cpInfo.name} sudah diambil pada ${existingClaim.claim_time} WIB${existingClaim.claimed_by_name ? ' oleh ' + existingClaim.claimed_by_name : ''}.`,
                claimed_at: existingClaim.claimed_at,
                claimed_by: existingClaim.claimed_by_name,
                claimed_qty: existingClaim.qty
              }
            });
          }

          // 3. Record valid claim
          await neonQuery(env, `INSERT INTO checkpoint_claims(event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by, claimed_by_name)
            VALUES($1::uuid, $2, $3::uuid, $4, $5::int, $6::uuid, $7)`,
            [o.event_id, cpKey, o.id, code, o.qty, u.id, u.name || 'Petugas Pos']);

          return json({
            ok: true,
            data: {
              ...base,
              result: 'VALID',
              message: `${cpInfo.name} berhasil diverifikasi!`,
              entered: o.qty,
              claimed_qty: o.qty,
              at: new Date().toISOString()
            }
          });
        }

        if (action === 'stats') {
          needRole(1);
          let filterSql = '';
          const qParams = [];
          if (u.role === 2 && u.organizer_id) {
            filterSql = ' WHERE e.organizer_id = $1::uuid ';
            qParams.push(u.organizer_id);
          } else if (params.organizerId) {
            filterSql = ' WHERE e.organizer_id = $1::uuid ';
            qParams.push(params.organizerId);
          }
          const r = await neonQuery(env, `SELECT e.id,e.name,e.quota,coalesce(e.walkin_quota,0)::int AS walkin_quota,e.is_active,
            coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS booked,
            coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS checked,
            coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_booked,
            coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_checked,
            coalesce(sum(o.qty) FILTER (WHERE o.status='pending_payment'),0)::int AS pending,
            coalesce(sum(o.total) FILTER (WHERE o.status='confirmed'),0)::int AS revenue
            FROM events e LEFT JOIN orders o ON o.event_id=e.id ${filterSql} GROUP BY e.id ORDER BY e.event_date`, qParams);
          return json({ ok: true, data: r });
        }

        if (action === 'adminEvents') {
          needRole(1);
          let filterSql = '';
          const qParams = [];
          if (u.role === 2 && u.organizer_id) {
            filterSql = ' WHERE e.organizer_id = $1::uuid ';
            qParams.push(u.organizer_id);
          } else if (params.organizerId) {
            filterSql = ' WHERE e.organizer_id = $1::uuid ';
            qParams.push(params.organizerId);
          }
          const r = await neonQuery(env, `SELECT e.*, coalesce(org.name, 'Default') AS organizer_name, coalesce(org.slug, 'default') AS organizer_slug,
            coalesce(os.sold, 0)::int AS sold,
            coalesce(os.walkin_sold, 0)::int AS walkin_sold,
            (coalesce(e.walkin_quota, 0) - coalesce(os.walkin_sold, 0))::int AS walkin_remaining
            FROM events e
            LEFT JOIN organizers org ON org.id=e.organizer_id
            LEFT JOIN (
              SELECT event_id,
                sum(CASE WHEN kind<>'walk_in' THEN qty ELSE 0 END) AS sold,
                sum(CASE WHEN kind='walk_in' THEN qty ELSE 0 END) AS walkin_sold
              FROM orders
              WHERE status<>'cancelled'
              GROUP BY event_id
            ) os ON os.event_id = e.id
            ${filterSql}
            ORDER BY e.event_date DESC, e.start_time`, qParams);
          return json({ ok: true, data: r });
        }

        if (action === 'orders' || action === 'ordersAll') {
          needRole(2);
          const qParams = [];
          const whereClauses = [];
          if (params.eventId) {
            qParams.push(params.eventId);
            whereClauses.push(`o.event_id = $${qParams.length}::uuid`);
          }
          if (params.status) {
            qParams.push(params.status);
            whereClauses.push(`o.status = $${qParams.length}::text`);
          }
          if (u.role === 2 && u.organizer_id) {
            qParams.push(u.organizer_id);
            whereClauses.push(`e.organizer_id = $${qParams.length}::uuid`);
          }
          const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
          const sql = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.checked_in_at,o.created_at,o.kind,
            coalesce(o.custom_answers, '{}'::jsonb) AS custom_answers,
            coalesce(o.rsvp_status, '') AS rsvp_status,
            coalesce(o.plus_one_count, 0)::int AS plus_one_count,
            coalesce(o.guestbook_message, '') AS guestbook_message,
            coalesce(o.table_assignment, '') AS table_assignment,
            coalesce(o.emailed, false) AS emailed, o.email_error, o.emailed_at,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind='invitation' THEN 'Undangan' WHEN o.kind='walk_in' THEN coalesce(nullif(o.guest_email,''), 'Walk-In') ELSE u.email END AS email,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
            e.id AS event_id,e.name AS event_name,e.terms,e.location,e.event_date,e.start_time,e.announcement
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
            ${whereSql}
            ORDER BY o.created_at DESC LIMIT 3000`;
          const rows = await neonQuery(env, sql, qParams);
          return json({ ok: true, data: action === 'ordersAll' ? { rows, truncated: false } : rows });
        }

        if (action === 'adminEnsureTables') {
          needRole(3);
          await ensureFeatureTables(env, true);
          return json({ ok: true, message: 'All feature tables and columns verified.' });
        }

        if (action === 'organizersList') {
          needRole(2);
          await ensureFeatureTables(env);
          let sql = `SELECT o.*,
            coalesce((SELECT count(e.id) FROM events e WHERE e.organizer_id=o.id), 0)::int AS event_count,
            coalesce((SELECT sum(ord.qty) FROM orders ord JOIN events ev ON ev.id=ord.event_id WHERE ev.organizer_id=o.id AND ord.status='confirmed'), 0)::int AS total_sold
            FROM organizers o `;
          const qParams = [];
          if (u.role === 2 && u.organizer_id) {
            sql += ` WHERE o.id = $1::uuid `;
            qParams.push(u.organizer_id);
          }
          sql += ` ORDER BY o.created_at ASC `;
          const r = await neonQuery(env, sql, qParams);
          return json({ ok: true, data: r });
        }

        if (action === 'organizerSave') {
          needRole(2);
          await ensureFeatureTables(env);
          const name = String(params.name || '').trim();
          if (!name) throw new Error('NAME_REQUIRED');
          let slug = String(params.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
          if (!slug) slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');

          let id = params.id ? String(params.id).trim() : null;
          if (u.role === 2) {
            if (!u.organizer_id || (id && id !== u.organizer_id)) throw new Error('FORBIDDEN');
            id = u.organizer_id;
          }

          const desc = String(params.description || '').trim();
          const logo = String(params.logo_url || '').trim();
          const banner = String(params.banner_url || '').trim();
          const email = String(params.contact_email || '').trim();
          const phone = String(params.contact_phone || '').trim();
          const bankName = String(params.bank_name || '').trim();
          const bankAcc = String(params.bank_account_no || '').trim();
          const bankHolder = String(params.bank_account_holder || '').trim();
          const isVerified = u.role >= 3 ? (params.is_verified !== false) : true;

          if (!id) {
            needRole(3);
            const r = await neonQuery(env, `INSERT INTO organizers(name, slug, description, logo_url, banner_url, contact_email, contact_phone, bank_name, bank_account_no, bank_account_holder, is_verified)
              VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, description=EXCLUDED.description, logo_url=EXCLUDED.logo_url, banner_url=EXCLUDED.banner_url, contact_email=EXCLUDED.contact_email, contact_phone=EXCLUDED.contact_phone, bank_name=EXCLUDED.bank_name, bank_account_no=EXCLUDED.bank_account_no, bank_account_holder=EXCLUDED.bank_account_holder
              RETURNING id`, [name, slug, desc, logo, banner, email, phone, bankName, bankAcc, bankHolder, isVerified]);
            return json({ ok: true, data: r[0] });
          } else {
            const r = await neonQuery(env, `UPDATE organizers SET name=$1, slug=$2, description=$3, logo_url=$4, banner_url=$5, contact_email=$6, contact_phone=$7, bank_name=$8, bank_account_no=$9, bank_account_holder=$10, is_verified=$11 WHERE id=$12::uuid RETURNING id`, [name, slug, desc, logo, banner, email, phone, bankName, bankAcc, bankHolder, isVerified, id]);
            return json({ ok: true, data: r[0] });
          }
        }

        if (action === 'userAssignOrganizer') {
          needRole(3);
          await ensureFeatureTables(env);
          const userId = String(params.userId || '').trim();
          const orgId = params.organizerId ? String(params.organizerId).trim() : null;
          const role = params.role !== undefined ? parseInt(params.role, 10) : undefined;
          if (!userId) throw new Error('USER_ID_REQUIRED');
          if (role !== undefined) {
            await neonQuery(env, `UPDATE users SET organizer_id=$1, role=$2 WHERE id=$3::uuid`, [orgId, role, userId]);
          } else {
            await neonQuery(env, `UPDATE users SET organizer_id=$1 WHERE id=$2::uuid`, [orgId, userId]);
          }
          return json({ ok: true, data: true });
        }

        if (action === 'users') {
          needRole(3);
          const r = await neonQuery(env, `SELECT u.id,u.name,u.email,u.whatsapp,u.age,u.church,u.role,coalesce(u.picture,'') AS picture,u.created_at,
            u.organizer_id, coalesce(org.name, '-') AS organizer_name
            FROM users u
            LEFT JOIN organizers org ON org.id=u.organizer_id
            ORDER BY u.created_at DESC LIMIT 5000`);
          return json({ ok: true, data: r });
        }

        if (action === 'invitations') {
          needRole(2);
          const qParams = [];
          const whereClauses = ["o.kind='invitation'"];
          if (params.eventId) {
            qParams.push(params.eventId);
            whereClauses.push(`o.event_id = $${qParams.length}::uuid`);
          }
          if (u.role === 2 && u.organizer_id) {
            qParams.push(u.organizer_id);
            whereClauses.push(`e.organizer_id = $${qParams.length}::uuid`);
          }
          const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
          const r = await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_age,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions,e.terms
            FROM orders o JOIN events e ON e.id=o.event_id ${whereSql} ORDER BY o.created_at DESC LIMIT 1000`, qParams);
          return json({ ok: true, data: r });
        }

        if (action === 'waitingList') {
          needRole(2);
          const qParams = [];
          const whereClauses = ["w.status='waiting'"];
          if (params.eventId) {
            qParams.push(params.eventId);
            whereClauses.push(`w.event_id = $${qParams.length}::uuid`);
          }
          if (u.role === 2 && u.organizer_id) {
            qParams.push(u.organizer_id);
            whereClauses.push(`e.organizer_id = $${qParams.length}::uuid`);
          }
          const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
          const r = await neonQuery(env, `SELECT w.id, w.event_id, w.guest_name, w.guest_org, w.guest_phone, w.guest_age, w.qty, w.status, w.order_id,
            w.created_at, e.name AS event_name, e.event_date,
            (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining
            FROM invitation_waiting_list w JOIN events e ON e.id=w.event_id ${whereSql} ORDER BY w.created_at ASC`, qParams);
          return json({ ok: true, data: r });
        }

        if (action === 'waitingCreate') {
          needRole(2);
          const name = String(params.name || '').trim(), org = String(params.org || '').trim(), qty = parseInt(params.qty, 10) || 1;
          const phone = normPhone(params.phone);
          if (!phone) throw new Error('BAD_PHONE');
          const age = params.age ? parseInt(params.age, 10) : null;
          const r = await neonQuery(env, `INSERT INTO invitation_waiting_list(event_id, created_by, guest_name, guest_org, guest_phone, guest_age, qty, status, created_at)
            VALUES($1::uuid, $2::uuid, $3, $4, $5, $6, $7, 'waiting', now()) RETURNING id`, [params.eventId, u.id, name, org, phone, age, qty]);
          return json({ ok: true, data: { id: r[0].id } });
        }

        if (action === 'waitingDelete') {
          needRole(2);
          await neonQuery(env, `DELETE FROM invitation_waiting_list WHERE id=$1::uuid`, [params.id]);
          return json({ ok: true, data: true });
        }

        if (action === 'invitationCreate' || action === 'waitingPromote') {
          needRole(2);
          let item = params;
          if (action === 'waitingPromote') {
            const w = (await neonQuery(env, `SELECT * FROM invitation_waiting_list WHERE id=$1::uuid AND status='waiting'`, [params.id]))[0];
            if (!w) throw new Error('NOT_FOUND');
            item = { eventId: w.event_id, name: w.guest_name, org: w.guest_org, phone: w.guest_phone, age: w.guest_age, qty: w.qty, waitId: w.id };
          } else {
            const phone = normPhone(item.phone);
            if (!phone) throw new Error('BAD_PHONE');
            item.phone = phone;
          }

          const ev = (await neonQuery(env, `SELECT name FROM events WHERE id=$1::uuid`, [item.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
          const tCode = 'TKT-' + prefix + '-' + rnd(6);
          const oCode = rnd(8);

          const r = await neonQuery(env, `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org,guest_phone,guest_age)
            SELECT $1,$2,$3::uuid,e.id,$4::int,0,'confirmed','invitation',$6::text,$7::text,$8::text,$9::int FROM events e WHERE e.id=$5::uuid
             AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled') + $4::int <= e.quota
            RETURNING id`, [oCode, tCode, u.id, parseInt(item.qty, 10) || 1, item.eventId, item.name, item.org, item.phone || null, item.age || null]);

          if (!r.length) throw new Error('SOLDOUT');

          if (item.waitId) {
            await neonQuery(env, `UPDATE invitation_waiting_list SET status='promoted', order_id=$1::uuid, promoted_at=now() WHERE id=$2::uuid`, [r[0].id, item.waitId]);
          }

          const order = (await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.status,o.checked_in,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_age,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1::uuid`, [r[0].id]))[0];

          return json({ ok: true, data: order });
        }

        if (action === 'waitingPromoteAll') {
          needRole(2);
          const items = await neonQuery(env, `SELECT * FROM invitation_waiting_list WHERE status='waiting' ORDER BY created_at ASC`);
          let success = 0, fail = 0;
          for (const it of items) {
            try {
              const ev = (await neonQuery(env, `SELECT name FROM events WHERE id=$1::uuid`, [it.event_id]))[0];
              const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
              const tCode = 'TKT-' + prefix + '-' + rnd(6);
              const oCode = rnd(8);
              const r = await neonQuery(env, `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status,kind,guest_name,guest_org,guest_phone,guest_age)
                SELECT $1,$2,$3::uuid,e.id,$4::int,0,'confirmed','invitation',$6::text,$7::text,$8::text,$9::int FROM events e WHERE e.id=$5::uuid
                 AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled') + $4::int <= e.quota
                RETURNING id`, [oCode, tCode, u.id, it.qty, it.event_id, it.guest_name, it.guest_org, it.guest_phone, it.guest_age]);
              if (r.length) {
                await neonQuery(env, `UPDATE invitation_waiting_list SET status='promoted', order_id=$1::uuid, promoted_at=now() WHERE id=$2::uuid`, [r[0].id, it.id]);
                success++;
              } else { fail++; break; }
            } catch (x) { fail++; break; }
          }
          return json({ ok: true, data: { promoted: success, failed: fail } });
        }

        if (action === 'walkinCreate') {
          needRole(1);
          const name = String(params.name || '').trim();
          const org = String(params.org || '').trim();
          const phone = params.phone ? normPhone(params.phone) : null;
          const email = String(params.email || '').trim().toLowerCase();
          const age = params.age ? parseInt(params.age, 10) : null;
          const qty = parseInt(params.qty, 10) || 1;
          const ci = params.checkin !== false;

          const ev = (await neonQuery(env, `SELECT name, walkin_quota FROM events WHERE id=$1::uuid AND is_active`, [params.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'WALK');
          const tCode = 'TKT-WLK-' + prefix.slice(0, 3) + '-' + rnd(5);
          const oCode = 'WLK-' + rnd(7);

          const r = await neonQuery(env, `INSERT INTO orders(order_code, ticket_code, user_id, event_id, qty, total, status, kind, guest_name, guest_org, guest_phone, guest_email, guest_age, checked_in, checked_in_at, checked_in_by)
            SELECT $1, $2, $3::uuid, e.id, $4::int, 0, 'confirmed', 'walk_in', $6::text, $7::text, $8::text, $9::text, $10::int,
              CASE WHEN $11::boolean THEN $4::int ELSE 0 END,
              CASE WHEN $11::boolean THEN now() ELSE NULL END,
              CASE WHEN $11::boolean THEN $3::uuid ELSE NULL END
            FROM events e WHERE e.id=$5::uuid AND e.is_active
              AND (coalesce(e.walkin_quota, 0) - coalesce((SELECT sum(qty) FROM orders WHERE event_id=e.id AND status<>'cancelled' AND kind='walk_in'), 0)) >= $4::int
            RETURNING id`, [oCode, tCode, u.id, qty, params.eventId, name, org, phone, email, age, ci]);

          if (!r.length) throw new Error('WALKIN_SOLDOUT');
          const order = (await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.status,o.checked_in,o.kind,o.guest_name,o.guest_org,o.guest_phone,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.id=$1::uuid`, [r[0].id]))[0];
          return json({ ok: true, data: order });
        }

        if (action === 'saveEvent') {
          needRole(2);
          let orgId = '00000000-0000-0000-0000-000000000001';
          if (u.role === 2) {
            orgId = u.organizer_id || '00000000-0000-0000-0000-000000000001';
            if (params.id) {
              const existing = await neonQuery(env, `SELECT organizer_id FROM events WHERE id=$1::uuid`, [params.id]);
              if (existing.length && existing[0].organizer_id && existing[0].organizer_id !== orgId) {
                throw new Error('FORBIDDEN');
              }
            }
          } else if (u.role >= 3) {
            orgId = params.organizer_id || '00000000-0000-0000-0000-000000000001';
          }

          const paid = !!params.is_paid, quota = parseInt(params.quota, 10), maxp = parseInt(params.max_per_order, 10), walkinQuota = parseInt(params.walkin_quota, 10) || 0;
          const customFields = Array.isArray(params.custom_fields) ? JSON.stringify(params.custom_fields) : (params.custom_fields || '[]');
          const enableNametag = !!params.enable_nametag;
          const enableCertificate = !!params.enable_certificate;
          const certConfig = typeof params.certificate_config === 'object' ? JSON.stringify(params.certificate_config || {}) : (params.certificate_config || '{}');
          const activeModules = Array.isArray(params.active_modules) ? JSON.stringify(params.active_modules) : (params.active_modules || '["ticketing"]');
          const moduleConfig = typeof params.module_config === 'object' ? JSON.stringify(params.module_config || {}) : (params.module_config || '{}');

          const v = [params.name.trim(), params.category || '', params.banner_url || '', params.description || '', params.announcement || '', params.event_date, params.start_time, params.end_time || null, params.location.trim(),
            quota, walkinQuota, paid, paid ? Math.max(0, parseInt(params.price, 10) || 0) : 0, maxp, !!params.one_order_per_account, params.is_active !== false, params.payment_instructions || '', String(params.terms || '').slice(0, 8000),
            customFields, enableNametag, enableCertificate, certConfig, activeModules, moduleConfig, orgId];
          const r = await neonQuery(env, `INSERT INTO events(name,category,banner_url,description,announcement,event_date,start_time,end_time,location,quota,walkin_quota,is_paid,price,max_per_order,one_order_per_account,is_active,payment_instructions,terms,custom_fields,enable_nametag,enable_certificate,certificate_config,active_modules,module_config,organizer_id,id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::boolean,$21::boolean,$22::jsonb,$23::jsonb,$24::jsonb,$25::uuid,$26::uuid) ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name,category=EXCLUDED.category,banner_url=EXCLUDED.banner_url,description=EXCLUDED.description,announcement=EXCLUDED.announcement,
            quota=EXCLUDED.quota,walkin_quota=EXCLUDED.walkin_quota,is_paid=EXCLUDED.is_paid,is_active=EXCLUDED.is_active,price=EXCLUDED.price,
            event_date=EXCLUDED.event_date,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,location=EXCLUDED.location,
            max_per_order=EXCLUDED.max_per_order,one_order_per_account=EXCLUDED.one_order_per_account,
            payment_instructions=EXCLUDED.payment_instructions,terms=EXCLUDED.terms,
            custom_fields=EXCLUDED.custom_fields,enable_nametag=EXCLUDED.enable_nametag,enable_certificate=EXCLUDED.enable_certificate,certificate_config=EXCLUDED.certificate_config,
            active_modules=EXCLUDED.active_modules,module_config=EXCLUDED.module_config,
            organizer_id=EXCLUDED.organizer_id
            RETURNING id`, [...v, params.id || crypto.randomUUID()]);
          return json({ ok: true, data: r[0] });
        }

        if (action === 'toggleEvent') {
          needRole(3);
          await neonQuery(env, `UPDATE events SET is_active=$2::bool WHERE id=$1::uuid RETURNING id`, [params.id, !!params.active]);
          return json({ ok: true, data: true });
        }

        if (action === 'cancelOrder') {
          needRole(3);
          await neonQuery(env, `UPDATE orders SET status='cancelled',cancelled_at=now() WHERE id=$1::uuid AND status<>'cancelled' RETURNING id`, [params.id]);
          return json({ ok: true, data: true });
        }

        if (action === 'setRole') {
          needRole(3);
          if (params.id === u.id) throw new Error('SELF');
          await neonQuery(env, `UPDATE users SET role=$2 WHERE id=$1::uuid RETURNING id`, [params.id, params.role]);
          return json({ ok: true, data: true });
        }

        if (action === 'resetPw') {
          needRole(3);
          if (params.id === u.id) throw new Error('SELF');
          const temp = rnd(10);
          const pwHash = await hashPw(temp, crypto.randomUUID());
          await neonQuery(env, `UPDATE users SET password_hash=$1,failed_attempts=0,locked_until=NULL WHERE id=$2::uuid`, [pwHash, params.id]);
          await neonQuery(env, `DELETE FROM sessions WHERE user_id=$1::uuid`, [params.id]);
          return json({ ok: true, data: { temp } });
        }

        if (action === 'checkpointsGet') {
          needRole(1);
          const evId = String(params.eventId || '').trim();
          if (!evId) throw new Error('EVENT_NOT_FOUND');
          await ensureFeatureTables(env);
          await ensureDefaultCheckpoints(env, evId);

          const includeAll = params.all === true || params.all === 'true' || params.all === 1;
          const r = await neonQuery(env, `
            SELECT cp.id, cp.event_id, cp.checkpoint_key, cp.name, cp.icon, cp.checkpoint_type, cp.is_active, cp.sort_order,
              coalesce(cp.description, '') AS description,
              coalesce(sum(cl.qty), 0)::int AS claimed_count
            FROM event_checkpoints cp
            LEFT JOIN checkpoint_claims cl ON cl.event_id=cp.event_id AND cl.checkpoint_key=cp.checkpoint_key
            WHERE cp.event_id=$1::uuid ${includeAll ? '' : 'AND cp.is_active=true'}
            GROUP BY cp.id, cp.event_id, cp.checkpoint_key, cp.name, cp.icon, cp.checkpoint_type, cp.is_active, cp.sort_order, cp.description
            ORDER BY cp.sort_order, cp.created_at
          `, [evId]);

          const gateStat = (await neonQuery(env, `
            SELECT coalesce(sum(qty), 0)::int AS booked,
                   coalesce(sum(checked_in), 0)::int AS checked_in
            FROM orders WHERE event_id=$1::uuid AND status='confirmed'
          `, [evId]))[0] || { booked: 0, checked_in: 0 };

          return json({
            ok: true,
            data: {
              checkpoints: r,
              gate_checked_in: parseInt(gateStat.checked_in, 10) || 0,
              total_registered: parseInt(gateStat.booked, 10) || 0,
              gateStat: gateStat
            }
          });
        }

        if (action === 'checkpointSave') {
          needRole(2);
          const evId = String(params.eventId || '').trim();
          if (!evId) throw new Error('EVENT_NOT_FOUND');
          await ensureFeatureTables(env);
          const name = String(params.name || '').trim();
          if (!name) throw new Error('NAME_REQUIRED');
          const icon = String(params.icon || '📍').trim();
          const type = String(params.checkpointType || params.type || 'facility').trim();
          const desc = String(params.description || '').trim();
          const isActive = params.isActive !== false && params.is_active !== false;
          const sortOrder = parseInt(params.sortOrder != null ? params.sortOrder : (params.sort_order != null ? params.sort_order : 10), 10) || 10;
          const key = String(params.checkpointKey || params.key || ('cp_' + Date.now().toString(36))).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');

          if (params.id) {
            await neonQuery(env, `UPDATE event_checkpoints SET name=$1, icon=$2, checkpoint_type=$3, is_active=$4, sort_order=$5, description=$6 WHERE id=$7::uuid AND event_id=$8::uuid`,
              [name, icon, type, isActive, sortOrder, desc, params.id, evId]);
          } else {
            await neonQuery(env, `INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, is_active, sort_order, description)
              VALUES($1::uuid, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (event_id, checkpoint_key) DO UPDATE SET name=EXCLUDED.name, icon=EXCLUDED.icon, checkpoint_type=EXCLUDED.checkpoint_type, is_active=EXCLUDED.is_active, sort_order=EXCLUDED.sort_order, description=EXCLUDED.description`,
              [evId, key, name, icon, type, isActive, sortOrder, desc]);
          }
          return json({ ok: true, data: true });
        }

        if (action === 'checkpointDelete') {
          needRole(2);
          const id = params.id;
          const key = params.checkpointKey || params.key;
          const evId = params.eventId;
          if (!id && !key) throw new Error('ID_REQUIRED');
          if (id) {
            const cp = (await neonQuery(env, `SELECT checkpoint_key FROM event_checkpoints WHERE id=$1::uuid`, [id]))[0];
            if (cp && cp.checkpoint_key === 'main_gate') throw new Error('CANNOT_DELETE_MAIN_GATE');
            await neonQuery(env, `DELETE FROM event_checkpoints WHERE id=$1::uuid`, [id]);
          } else if (key && evId) {
            if (key === 'main_gate') throw new Error('CANNOT_DELETE_MAIN_GATE');
            await neonQuery(env, `DELETE FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key=$2`, [evId, key]);
          }
          return json({ ok: true, data: true });
        }

        if (action === 'checkpointsResetDefaults') {
          needRole(2);
          const evId = String(params.eventId || '').trim();
          if (!evId) throw new Error('EVENT_NOT_FOUND');
          await ensureFeatureTables(env);
          await neonQuery(env, `DELETE FROM event_checkpoints WHERE event_id=$1::uuid AND checkpoint_key NOT IN (SELECT DISTINCT checkpoint_key FROM checkpoint_claims WHERE event_id=$1::uuid)`, [evId]);
          for (const cp of DEFAULT_CHECKPOINTS) {
            await neonQuery(env, `INSERT INTO event_checkpoints(event_id, checkpoint_key, name, icon, checkpoint_type, sort_order)
              VALUES($1::uuid, $2, $3, $4, $5, $6) ON CONFLICT (event_id, checkpoint_key) DO UPDATE SET is_active=true, name=EXCLUDED.name, icon=EXCLUDED.icon`,
              [evId, cp.key, cp.name, cp.icon, cp.type, cp.sort_order]);
          }
          return json({ ok: true, data: true });
        }

        if (action === 'checkpointExportCsv') {
          needRole(1);
          const evId = String(params.eventId || '').trim();
          if (!evId) throw new Error('EVENT_NOT_FOUND');
          await ensureFeatureTables(env);
          const rows = await neonQuery(env, `
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
          return json({ ok: true, data: rows });
        }

        if (action === 'getInvConfig') {
          const r = (await neonQuery(env, `SELECT value FROM settings WHERE key='invitation_max_qty'`))[0];
          return json({ ok: true, data: { maxQty: r ? parseInt(r.value, 10) : 50 } });
        }

        if (action === 'setInvMaxQty') {
          needRole(3);
          const maxQ = parseInt(params.maxQty, 10) || 50;
          await neonQuery(env, `INSERT INTO settings(key, value, updated_at) VALUES('invitation_max_qty', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [String(maxQ)]);
          return json({ ok: true, data: { maxQty: maxQ } });
        }

        if (action === 'gateLink') {
          needRole(2);
          const ev = (await neonQuery(env, `SELECT id, name FROM events WHERE id=$1::uuid`, [params.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const evId = String(ev.id).toLowerCase();
          const key = (await sha256('gate_' + evId)).slice(0, 16);
          const base = (params && params.base ? String(params.base) : (env.SITE_URL || 'https://ambiltiketnya.online')).replace(/\/+$/, '');
          return json({ ok: true, data: { eventId: evId, eventName: ev.name, key, url: `${base}/?gate=${evId}&k=${key}` } });
        }

        if (action === 'offlineManifest') {
          needRole(1);
          const ev = (await neonQuery(env, `SELECT id, name FROM events WHERE id=$1::uuid`, [params.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const rows = await neonQuery(env, `SELECT o.ticket_code AS code, o.qty, o.checked_in AS checked, o.status, o.kind,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
            e.name AS event_name
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
            WHERE o.event_id=$1::uuid AND o.status<>'cancelled'`, [params.eventId]);
          return json({ ok: true, data: { eventId: ev.id, eventName: ev.name, downloadedAt: new Date().toISOString(), count: rows.length, tickets: rows } });
        }

        if (action === 'syncOfflineCheckins') {
          needRole(1);
          const list = params.checkins || [];
          let synced = 0;
          for (const it of list) {
            const code = String(it.code || '').trim().toUpperCase();
            if (code) {
              const r = await neonQuery(env, `UPDATE orders SET checked_in=qty, checked_in_at=$2::timestamptz, checked_in_by=$3::uuid WHERE ticket_code=$1 AND checked_in<qty RETURNING qty`, [code, it.at || new Date().toISOString(), u.id]);
              if (r.length) synced++;
            }
          }
          return json({ ok: true, data: { synced, total: list.length } });
        }

        if (action === 'getCheckinPin') {
          const r = (await neonQuery(env, `SELECT value FROM settings WHERE key='checkin_pin'`))[0];
          return json({ ok: true, data: { pin: r ? r.value : '', isCustom: !!r } });
        }

        if (action === 'setCheckinPin') {
          needRole(3);
          if (params.reset) {
            await neonQuery(env, `DELETE FROM settings WHERE key='checkin_pin'`);
            return json({ ok: true, data: { pin: '', isCustom: false } });
          }
          const pin = String(params.pin || '').trim();
          if (pin.length < 4) throw new Error('BAD_PIN');
          await neonQuery(env, `INSERT INTO settings(key, value, updated_at) VALUES('checkin_pin', $1, now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [pin]);
          return json({ ok: true, data: { pin, isCustom: true } });
        }

        if (action === 'checkinOrder') {
          needRole(2);
          const ordId = params.id;
          const pw = String(params.password || '').trim();
          const pinRow = (await neonQuery(env, `SELECT value FROM settings WHERE key='checkin_pin'`))[0];
          const validPin = pinRow ? pinRow.value : '';
          let authorized = false;
          if (validPin && pw === validPin) {
            authorized = true;
          } else {
            const uRow = (await neonQuery(env, `SELECT password_hash FROM users WHERE id=$1::uuid`, [u.id]))[0];
            if (uRow && await checkPw(pw, uRow.password_hash)) {
              authorized = true;
            }
          }
          if (!authorized) throw new Error('WRONG_PASSWORD');

          const ord = (await neonQuery(env, `SELECT id, event_id, ticket_code, qty, checked_in, status FROM orders WHERE id=$1::uuid`, [ordId]))[0];
          if (!ord) throw new Error('NOT_FOUND');
          if (ord.status !== 'confirmed') throw new Error('NOT_CONFIRMED');
          const curChecked = parseInt(ord.checked_in, 10) || 0;
          const rem = Math.max(0, ord.qty - curChecked);
          if (rem <= 0) throw new Error('ALREADY_CHECKED_IN');

          const enterQty = Math.min(rem, Math.max(1, parseInt(params.entered_qty, 10) || rem));
          const newChecked = curChecked + enterQty;

          await neonQuery(env, `UPDATE orders SET checked_in=$1, checked_in_at=now(), checked_in_by=$2::uuid WHERE id=$3::uuid`, [newChecked, u.id, ord.id]);
          await neonQuery(env, `INSERT INTO checkpoint_claims(event_id, checkpoint_key, order_id, ticket_code, qty, claimed_by, claimed_by_name)
            VALUES($1::uuid, 'main_gate', $2::uuid, $3, $4::int, $5::uuid, $6)
            ON CONFLICT (order_id, checkpoint_key) DO UPDATE SET qty = checkpoint_claims.qty + EXCLUDED.qty, claimed_at = now()`,
            [ord.event_id, ord.id, ord.ticket_code, enterQty, u.id, u.name || 'Admin']);

          return json({ ok: true, data: { id: ord.id, checked_in: newChecked, qty: ord.qty, entered: enterQty, remaining: ord.qty - newChecked } });
        }

        if (action === 'legalGet') {
          needRole(2);
          const rows = await neonQuery(env, `SELECT key, value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS d FROM settings WHERE key IN ('legal_syarat','legal_privasi','legal_cookie')`);
          const res = ['syarat', 'privasi', 'cookie'].map(k => {
            const r = rows.find(x => x.key === 'legal_' + k);
            return { key: k, title: LEGAL[k].title, text: r ? r.value : LEGAL[k].text, custom: !!r, updated: r ? r.d : '2026-10-18' };
          });
          return json({ ok: true, data: res });
        }

        if (action === 'legalSave') {
          needRole(3);
          const key = String(params.key || '');
          if (params.reset) {
            await neonQuery(env, `DELETE FROM settings WHERE key=$1`, ['legal_' + key]);
          } else {
            await neonQuery(env, `INSERT INTO settings(key,value,updated_at) VALUES($1,$2,now()) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`, ['legal_' + key, params.text]);
          }
          return json({ ok: true, data: true });
        }

        if (action === 'batchResendEmails') {
          needRole(2);
          const limit = Math.min(Math.max(parseInt(params.limit, 10) || 5, 1), 25);
          const list = await neonQuery(env, `SELECT o.id, o.order_code, o.ticket_code, u.name, u.email, e.name AS event_name
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
            WHERE o.status='confirmed' AND o.kind='order' AND coalesce(o.emailed, false)=false
            ORDER BY o.created_at ASC LIMIT $1`, [limit]);

          let sent = 0;
          for (const item of list) {
            try {
              await sendEmail(env, {
                to: item.email,
                subject: `[TIKET RESMI] ${item.event_name} - ${item.ticket_code}`,
                htmlBody: `<p>Halo ${item.name}, berikut adalah e-tiket Anda: <b>${item.ticket_code}</b></p>`
              });
              await neonQuery(env, `UPDATE orders SET emailed=true, emailed_at=now() WHERE id=$1::uuid`, [item.id]);
              sent++;
            } catch (x) { break; }
          }
          return json({ ok: true, data: { sent, remaining: Math.max(0, list.length - sent) } });
        }

        if (action === 'feedbackSubmit') {
          const eventId = String(params.eventId || '').trim();
          const orderId = params.orderId || null;
          const ratings = params.ratings || params.aspects || {};
          const rOverall = Math.min(Math.max(parseInt(ratings.overall || params.rating, 10) || 5, 1), 5);
          const rContent = Math.min(Math.max(parseInt(ratings.content, 10) || 5, 1), 5);
          const rService = Math.min(Math.max(parseInt(ratings.service, 10) || 5, 1), 5);
          const rVenue   = Math.min(Math.max(parseInt(ratings.venue, 10) || 5, 1), 5);
          const rSound   = Math.min(Math.max(parseInt(ratings.sound, 10) || 5, 1), 5);
          const aspectsJson = JSON.stringify({ overall: rOverall, content: rContent, service: rService, venue: rVenue, sound: rSound });
          const category = String(params.category || 'Umum').trim() || 'Umum';
          const comment = String(params.comment || '').trim();
          const isAnon = !!params.isAnonymous;
          const code = String(params.code || params.ticketCode || '').trim().toUpperCase();

          await ensureFeatureTables(env);
          await neonQuery(env, `INSERT INTO event_feedbacks(event_id, order_id, user_id, ticket_code, guest_name, guest_org, is_anonymous, rating, rating_content, rating_service, rating_venue, rating_sound, aspects, category, comment)
            VALUES($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15)`,
            [eventId, orderId, u.id, code, isAnon ? '' : u.name, isAnon ? '' : u.church, isAnon, rOverall, rContent, rService, rVenue, rSound, aspectsJson, category, comment]);
          return json({ ok: true, data: { success: true } });
        }

        if (action === 'feedbacksGet') {
          needRole(2);
          await ensureFeatureTables(env);
          const evId = String(params.eventId || '').trim();
          let sql = `SELECT f.id, f.event_id, e.name AS event_name,
            f.rating AS rating_overall,
            coalesce(f.rating_content, 5) AS rating_content,
            coalesce(f.rating_service, 5) AS rating_service,
            coalesce(f.rating_venue, 5) AS rating_venue,
            coalesce(f.rating_sound, 5) AS rating_sound,
            f.aspects,
            f.rating, f.category, f.comment, f.is_anonymous,
            CASE WHEN f.is_anonymous THEN 'Anonim' ELSE coalesce(nullif(f.guest_name,''),'Peserta') END AS author_name,
            CASE WHEN f.is_anonymous THEN '' ELSE f.guest_org END AS author_org,
            to_char(f.created_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI') AS created_at_fmt
            FROM event_feedbacks f JOIN events e ON e.id=f.event_id`;
          const qArgs = [];
          if (evId) {
            sql += ` WHERE f.event_id=$1::uuid`;
            qArgs.push(evId);
          }
          sql += ` ORDER BY f.created_at DESC LIMIT 300`;
          const rows = await neonQuery(env, sql, qArgs);

          const total = rows.length;
          const sumOverall = rows.reduce((acc, r) => acc + (r.rating_overall || r.rating || 0), 0);
          const sumContent = rows.reduce((acc, r) => acc + (r.rating_content || 5), 0);
          const sumService = rows.reduce((acc, r) => acc + (r.rating_service || 5), 0);
          const sumVenue   = rows.reduce((acc, r) => acc + (r.rating_venue || 5), 0);
          const sumSound   = rows.reduce((acc, r) => acc + (r.rating_sound || 5), 0);

          const avgOverall = total ? Math.round((sumOverall / total) * 10) / 10 : 0;
          const avgContent = total ? Math.round((sumContent / total) * 10) / 10 : 0;
          const avgService = total ? Math.round((sumService / total) * 10) / 10 : 0;
          const avgVenue   = total ? Math.round((sumVenue / total) * 10) / 10 : 0;
          const avgSound   = total ? Math.round((sumSound / total) * 10) / 10 : 0;

          const aspectAvgs = {
            overall: avgOverall,
            content: avgContent,
            service: avgService,
            venue: avgVenue,
            sound: avgSound
          };

          const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
          let anonCount = 0;
          rows.forEach(r => {
            const rt = r.rating_overall || r.rating;
            if (dist[rt] !== undefined) dist[rt]++;
            if (r.is_anonymous) anonCount++;
          });
          return json({ ok: true, data: { rows, total, avg: avgOverall, aspectAvgs, dist, anonCount } });
        }

        if (action === 'feedbackDelete') {
          needRole(2);
          const id = String(params.id || '').trim();
          await ensureFeatureTables(env);
          await neonQuery(env, `DELETE FROM event_feedbacks WHERE id=$1::uuid`, [id]);
          return json({ ok: true, data: true });
        }

        if (action === 'assignTable') {
          needRole(2);
          const ordId = String(params.orderId || '').trim();
          const table = String(params.tableAssignment || '').trim();
          if (!ordId) throw new Error('ORDER_ID_REQUIRED');
          await ensureFeatureTables(env);
          await neonQuery(env, `UPDATE orders SET table_assignment=$1 WHERE id=$2::uuid`, [table, ordId]);
          return json({ ok: true, data: true });
        }

        if (action === 'doorprizePool') {
          needRole(2);
          const evId = String(params.eventId || '').trim();
          if (!evId) throw new Error('EVENT_REQUIRED');
          await ensureFeatureTables(env);

          const candidates = await neonQuery(env, `
            SELECT o.id AS order_id, o.ticket_code,
              CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
              CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS org,
              CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
              to_char(o.checked_in_at AT TIME ZONE 'Asia/Jakarta','HH24:MI:SS') AS checkin_time
            FROM orders o
            LEFT JOIN users u ON u.id = o.user_id
            WHERE o.event_id = $1::uuid AND o.status = 'confirmed' AND o.checked_in >= 1
            ORDER BY o.checked_in_at DESC
          `, [evId]);

          const winners = await neonQuery(env, `SELECT id, order_id, ticket_code, winner_name, winner_org, prize_name, to_char(drawn_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD HH24:MI:SS') AS drawn_at FROM doorprize_winners WHERE event_id=$1::uuid ORDER BY drawn_at DESC`, [evId]);

          return json({ ok: true, data: { candidates, winners } });
        }

        if (action === 'doorprizeSaveWinner') {
          needRole(2);
          const evId = String(params.eventId || '').trim();
          const ordId = params.orderId || null;
          const code = String(params.ticketCode || '').trim();
          const name = String(params.winnerName || '').trim();
          const org = String(params.winnerOrg || '').trim();
          const prize = String(params.prizeName || 'Doorprize').trim();
          if (!evId || !name) throw new Error('BAD_DATA');
          await ensureFeatureTables(env);

          const r = await neonQuery(env, `INSERT INTO doorprize_winners(event_id, order_id, ticket_code, winner_name, winner_org, prize_name)
            VALUES($1::uuid, $2, $3, $4, $5, $6) RETURNING id`, [evId, ordId, code, name, org, prize]);
          return json({ ok: true, data: { id: r[0].id } });
        }

        if (action === 'doorprizeDeleteWinner') {
          needRole(2);
          const id = String(params.id || '').trim();
          await ensureFeatureTables(env);
          await neonQuery(env, `DELETE FROM doorprize_winners WHERE id=$1::uuid`, [id]);
          return json({ ok: true, data: true });
        }

        if (action === 'doorprizeResetAll') {
          needRole(2);
          const evId = String(params.eventId || '').trim();
          await ensureFeatureTables(env);
          await neonQuery(env, `DELETE FROM doorprize_winners WHERE event_id=$1::uuid`, [evId]);
          return json({ ok: true, data: true });
        }

        return errJson('NOT_FOUND', 404);
      }

      return errJson('NOT_FOUND', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errJson(err.message || 'E_GENERIC');
    }
  }
};
