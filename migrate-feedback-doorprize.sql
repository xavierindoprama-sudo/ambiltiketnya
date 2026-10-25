-- Migrasi Penambahan Fitur Survey Kepuasan & Live Doorprize
-- Untuk database Neon PostgreSQL AmbilTiketnya

-- 1. Tabel Survey Kepuasan & Feedback Peserta
CREATE TABLE IF NOT EXISTS event_feedbacks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id     uuid REFERENCES orders(id) ON DELETE SET NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  ticket_code  text DEFAULT '',
  guest_name   text DEFAULT '',
  guest_org    text DEFAULT '',
  is_anonymous boolean NOT NULL DEFAULT false,
  rating       int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  category     text NOT NULL DEFAULT 'Umum',
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS event_feedbacks_ev_idx ON event_feedbacks (event_id, created_at DESC);

-- 2. Tabel Pemenang Doorprize Acara
CREATE TABLE IF NOT EXISTS doorprize_winners (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id     uuid REFERENCES orders(id) ON DELETE CASCADE,
  ticket_code  text NOT NULL,
  winner_name  text NOT NULL,
  winner_org   text DEFAULT '',
  prize_name   text NOT NULL,
  drawn_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS doorprize_winners_ev_idx ON doorprize_winners (event_id, drawn_at DESC);
