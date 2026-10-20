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

const AUTH_SQL = `SELECT u.id,u.email,u.name,u.whatsapp,u.age,u.church,u.role,coalesce(u.picture,'') AS picture FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`;

async function auth(env, token) {
  if (!token) throw new Error('AUTH');
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
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining,
    EXISTS(SELECT 1 ${mine}) AS has_order,
    (SELECT o.id ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_order,
    (SELECT o.status ${mine} ORDER BY o.created_at DESC LIMIT 1) AS my_status
    FROM events e WHERE e.is_active ORDER BY e.event_date, e.start_time`;
}

async function publicEventsList(env) {
  return await neonQuery(env, `SELECT e.id,e.name,e.category,e.banner_url,e.description,e.event_date,e.start_time,e.end_time,e.location,e.quota,e.is_paid,e.price,e.max_per_order,e.one_order_per_account,e.terms,coalesce(e.walkin_quota,0)::int AS walkin_quota,
    (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining,
    (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining,
    false AS has_order, null AS my_order, null AS my_status
    FROM events e WHERE e.is_active ORDER BY e.event_date, e.start_time`);
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
  syarat: { title: 'Syarat dan Ketentuan', text: '## 1. Ketentuan Umum\\n- Dengan memesan tiket di {ORG}, peserta menyetujui seluruh ketentuan yang berlaku.\\n\\n## 2. Tiket & Masuk\\n- E-tiket resmi wajib ditunjukkan saat check-in di gerbang.' },
  privasi: { title: 'Kebijakan Privasi', text: '## 1. Pengumpulan Data\\n- Kami mengumpulkan nama, email, dan WhatsApp semata-mata untuk penerbitan tiket dan verifikasi acara.' },
  cookie: { title: 'Kebijakan Cookie', text: '## 1. Cookie Teknis\\n- Kami hanya menyimpan token sesi di peramban Anda untuk keperluan autentikasi masuk.' }
};

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

    if (request.method !== 'POST') {
      return json({ ok: true, service: 'ambiltiketnya-api', status: 'running' });
    }

    try {
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

      if (fn === 'ticketPublic') {
        const [p] = args;
        const code = String(p.code || '').trim().toUpperCase();
        const rows = await neonQuery(env, `SELECT o.ticket_code AS code,o.qty,o.status,o.checked_in,o.kind,e.name,e.event_date::text AS edate,to_char(e.start_time,'HH24:MI') AS stime,e.location
          FROM orders o JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code]);
        if (!rows.length) return json({ ok: true, data: { found: false } });
        const o = rows[0];
        const st = o.status === 'cancelled' ? 'CANCELLED' : o.status === 'pending_payment' ? 'UNPAID' : o.checked_in >= o.qty ? 'USED' : 'OK';
        return json({ ok: true, data: { found: true, ...o, status: st } });
      }

      if (fn === 'legalPublic') {
        const [p] = args;
        const key = String(p && p.key || '');
        const r = (await neonQuery(env, `SELECT value, to_char(updated_at AT TIME ZONE 'Asia/Jakarta','YYYY-MM-DD') AS d FROM settings WHERE key=$1`, ['legal_' + key]))[0];
        const def = LEGAL[key] || { title: 'Informasi Hukum', text: '' };
        return json({ ok: true, data: { title: def.title, updated: r ? r.d : '2026-10-18', html: `<p style="white-space:pre-wrap">${r ? r.value : def.text}</p>` } });
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
            e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.user_id=$1::uuid AND o.kind='order' ORDER BY o.created_at DESC`, [u.id]);
          return json({ ok: true, data: rows });
        }

        if (action === 'book') {
          const qty = parseInt(params.qty, 10) || 1;
          const ev = (await neonQuery(env, `SELECT name, quota, is_paid, price, max_per_order, one_order_per_account FROM events WHERE id=$1::uuid AND is_active`, [params.eventId]))[0];
          if (!ev) throw new Error('NOT_FOUND');
          const prefix = (ev.name.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'EVNT');
          const ticketCode = 'TKT-' + prefix + '-' + rnd(6);
          const orderCode = rnd(8);

          const r = await neonQuery(env, `INSERT INTO orders(order_code,ticket_code,user_id,event_id,qty,total,status)
            SELECT $1,$2,$3::uuid,e.id,$4::int,e.price*$4::int, CASE WHEN e.is_paid THEN 'pending_payment' ELSE 'confirmed' END
            FROM events e WHERE e.id=$5::uuid AND e.is_active AND $4::int>=1 AND $4::int<=e.max_per_order
             AND (SELECT coalesce(sum(qty),0) FROM orders WHERE event_id=e.id AND status<>'cancelled' AND kind<>'walk_in') + $4::int <= e.quota
             AND (NOT e.one_order_per_account OR NOT EXISTS(SELECT 1 FROM orders WHERE event_id=e.id AND user_id=$3::uuid AND status<>'cancelled' AND kind='order'))
            RETURNING id,status,ticket_code`, [orderCode, ticketCode, u.id, qty, params.eventId]);

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
          const code = String(params.code || '').trim().toUpperCase().replace(/\s/g, '');
          const rows = await neonQuery(env, `SELECT o.id,o.qty,o.status,o.checked_in,o.checked_in_at,o.kind,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,e.name AS event_name
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id WHERE o.ticket_code=$1`, [code]);
          if (!rows.length) return json({ ok: true, data: { result: 'NOT_FOUND', code } });
          const o = rows[0];
          const base = { code, kind: o.kind, name: o.name, church: o.church, age: o.age, whatsapp: o.whatsapp, event: o.event_name, qty: o.qty, at: o.checked_in_at };
          if (o.status === 'cancelled') return json({ ok: true, data: { ...base, result: 'CANCELLED' } });
          if (o.status === 'pending_payment') return json({ ok: true, data: { ...base, result: 'UNPAID' } });
          if (o.checked_in >= o.qty) return json({ ok: true, data: { ...base, result: 'USED', checked: o.checked_in } });

          await neonQuery(env, `UPDATE orders SET checked_in=qty,checked_in_at=now(),checked_in_by=$2::uuid WHERE id=$1::uuid AND checked_in<qty`, [o.id, u.id]);
          return json({ ok: true, data: { ...base, result: 'VALID', entered: o.qty - o.checked_in, checked: o.qty, at: new Date().toISOString() } });
        }

        if (action === 'stats') {
          needRole(1);
          const r = await neonQuery(env, `SELECT e.id,e.name,e.quota,coalesce(e.walkin_quota,0)::int AS walkin_quota,e.is_active,
            coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS booked,
            coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind<>'walk_in'),0)::int AS checked,
            coalesce(sum(o.qty) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_booked,
            coalesce(sum(o.checked_in) FILTER (WHERE o.status='confirmed' AND o.kind='walk_in'),0)::int AS walkin_checked,
            coalesce(sum(o.qty) FILTER (WHERE o.status='pending_payment'),0)::int AS pending,
            coalesce(sum(o.total) FILTER (WHERE o.status='confirmed'),0)::int AS revenue
            FROM events e LEFT JOIN orders o ON o.event_id=e.id GROUP BY e.id ORDER BY e.event_date`);
          return json({ ok: true, data: r });
        }

        if (action === 'adminEvents') {
          needRole(1);
          const r = await neonQuery(env, `SELECT e.*,
            coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0)::int AS sold,
            coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0)::int AS walkin_sold,
            (coalesce(e.walkin_quota,0) - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind='walk_in'),0))::int AS walkin_remaining
            FROM events e ORDER BY e.event_date DESC, e.start_time`);
          return json({ ok: true, data: r });
        }

        if (action === 'orders' || action === 'ordersAll') {
          needRole(2);
          const sql = `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.checked_in_at,o.created_at,o.kind,
            coalesce(o.emailed, false) AS emailed, o.email_error, o.emailed_at,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_name ELSE u.name END AS name,
            CASE WHEN o.kind='invitation' THEN 'Undangan' WHEN o.kind='walk_in' THEN coalesce(nullif(o.guest_email,''), 'Walk-In') ELSE u.email END AS email,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN coalesce(o.guest_phone, '') ELSE u.whatsapp END AS whatsapp,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_age ELSE u.age END AS age,
            CASE WHEN o.kind IN ('invitation','walk_in') THEN o.guest_org ELSE u.church END AS church,
            e.id AS event_id,e.name AS event_name,e.terms,e.location,e.event_date,e.start_time,e.announcement
            FROM orders o JOIN users u ON u.id=o.user_id JOIN events e ON e.id=o.event_id
            WHERE ($1::uuid IS NULL OR o.event_id=$1::uuid) AND ($2::text IS NULL OR o.status=$2::text)
            ORDER BY o.created_at DESC LIMIT 5000`;
          const rows = await neonQuery(env, sql, [params.eventId || null, params.status || null]);
          return json({ ok: true, data: action === 'ordersAll' ? { rows, truncated: false } : rows });
        }

        if (action === 'users') {
          needRole(3);
          const r = await neonQuery(env, `SELECT id,name,email,whatsapp,age,church,role,coalesce(picture,'') AS picture,created_at FROM users ORDER BY created_at DESC LIMIT 5000`);
          return json({ ok: true, data: r });
        }

        if (action === 'invitations') {
          needRole(2);
          const r = await neonQuery(env, `SELECT o.id,o.order_code,o.ticket_code,o.qty,o.total,o.status,o.checked_in,o.created_at,o.kind,o.guest_name,o.guest_org,o.guest_phone,o.guest_age,
            e.id AS event_id,e.name,e.banner_url,e.event_date,e.start_time,e.end_time,e.location,e.announcement,e.is_paid,e.payment_instructions,e.terms
            FROM orders o JOIN events e ON e.id=o.event_id WHERE o.kind='invitation' ORDER BY o.created_at DESC LIMIT 500`);
          return json({ ok: true, data: r });
        }

        if (action === 'waitingList') {
          needRole(2);
          const r = await neonQuery(env, `SELECT w.id, w.event_id, w.guest_name, w.guest_org, w.guest_phone, w.guest_age, w.qty, w.status, w.order_id,
            w.created_at, e.name AS event_name, e.event_date,
            (e.quota - coalesce((SELECT sum(qty) FROM orders o WHERE o.event_id=e.id AND o.status<>'cancelled' AND o.kind<>'walk_in'),0))::int AS remaining
            FROM invitation_waiting_list w JOIN events e ON e.id=w.event_id WHERE w.status='waiting' ORDER BY w.created_at ASC`);
          return json({ ok: true, data: r });
        }

        if (action === 'waitingCreate') {
          needRole(2);
          const name = String(params.name || '').trim(), org = String(params.org || '').trim(), qty = parseInt(params.qty, 10) || 1;
          const phone = params.phone ? normPhone(params.phone) : null;
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
          needRole(3);
          const paid = !!params.is_paid, quota = parseInt(params.quota, 10), maxp = parseInt(params.max_per_order, 10), walkinQuota = parseInt(params.walkin_quota, 10) || 0;
          const v = [params.name.trim(), params.category || '', params.banner_url || '', params.description || '', params.announcement || '', params.event_date, params.start_time, params.end_time || null, params.location.trim(),
            quota, walkinQuota, paid, paid ? Math.max(0, parseInt(params.price, 10) || 0) : 0, maxp, !!params.one_order_per_account, params.is_active !== false, params.payment_instructions || '', String(params.terms || '').slice(0, 8000)];
          const r = await neonQuery(env, `INSERT INTO events(name,category,banner_url,description,announcement,event_date,start_time,end_time,location,quota,walkin_quota,is_paid,price,max_per_order,one_order_per_account,is_active,payment_instructions,terms,id)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::uuid) ON CONFLICT(id) DO UPDATE SET
            name=EXCLUDED.name,quota=EXCLUDED.quota,walkin_quota=EXCLUDED.walkin_quota,is_active=EXCLUDED.is_active,price=EXCLUDED.price,event_date=EXCLUDED.event_date,start_time=EXCLUDED.start_time,location=EXCLUDED.location
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

        return errJson('NOT_FOUND', 404);
      }

      return errJson('NOT_FOUND', 404);
    } catch (err) {
      console.error('Worker error:', err);
      return errJson(err.message || 'E_GENERIC');
    }
  }
};
