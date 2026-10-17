-- ambiltiketnya.online - skema PostgreSQL (Neon). Untuk database BARU / kosong.
-- Jika database sudah berisi skema lama, jalankan migrate.sql saja.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text NOT NULL,
  whatsapp        text NOT NULL CHECK (whatsapp ~ '^628[0-9]{7,11}$'),  -- format baku 628xxxxxxxxx
  age             int  NOT NULL CHECK (age BETWEEN 1 AND 120),
  church          text NOT NULL,
  password_hash   text NOT NULL,                  -- iterasi$salt$hash (SHA-256 berulang)
  failed_attempts int  NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  role            text NOT NULL DEFAULT 'attendee'
                  CHECK (role IN ('attendee','gate_staff','admin','super_admin')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_exp_idx ON sessions (expires_at);

CREATE TABLE password_resets (                    -- OTP lupa password
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  otp_hash   text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  category              text NOT NULL DEFAULT '',
  banner_url            text NOT NULL DEFAULT '',
  description           text NOT NULL DEFAULT '',
  announcement          text NOT NULL DEFAULT '',
  event_date            date NOT NULL,
  start_time            time NOT NULL,
  end_time              time,
  location              text NOT NULL,
  quota                 int  NOT NULL CHECK (quota > 0),
  is_paid               boolean NOT NULL DEFAULT false,
  price                 int  NOT NULL DEFAULT 0 CHECK (price >= 0),
  payment_instructions  text NOT NULL DEFAULT '',
  terms                 text NOT NULL DEFAULT '',          -- syarat & ketentuan acara (teks, dapat diedit super admin)
  max_per_order         int  NOT NULL DEFAULT 1 CHECK (max_per_order >= 1),
  one_order_per_account boolean NOT NULL DEFAULT false,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (is_paid OR price = 0)
);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code    text UNIQUE NOT NULL,
  ticket_code   text UNIQUE NOT NULL,
  user_id       uuid NOT NULL REFERENCES users(id),
  event_id      uuid NOT NULL REFERENCES events(id),
  qty           int  NOT NULL CHECK (qty > 0),
  total         int  NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'confirmed'
                CHECK (status IN ('pending_payment','confirmed','cancelled')),
  checked_in    int  NOT NULL DEFAULT 0,
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  cancelled_at  timestamptz,
  kind          text NOT NULL DEFAULT 'order' CHECK (kind IN ('order','invitation')),   -- undangan dibuat super admin; user_id = pembuatnya
  guest_name    text,                                                                      -- nama yang diundang
  guest_org     text,                                                                      -- instansi
  CHECK (checked_in BETWEEN 0 AND qty)
);
CREATE INDEX orders_event_status_idx ON orders (event_id, status);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);

CREATE TABLE settings (                           -- pengaturan umum; dipakai untuk teks halaman hukum yang diedit dari dashboard
  key        text PRIMARY KEY,                    -- legal_syarat | legal_privasi | legal_cookie
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
