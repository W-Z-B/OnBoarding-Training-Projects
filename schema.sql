-- GPL VPMO Training schema. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  unit          TEXT NOT NULL,
  salt          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,
  unit           TEXT NOT NULL,
  level          TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'Member' CHECK (role IN ('Member','UnitHead')),
  attendees      INTEGER NOT NULL DEFAULT 1 CHECK (attendees >= 1 AND attendees <= 500),
  date           DATE NOT NULL,
  "time"         TEXT NOT NULL,
  duration       INTEGER NOT NULL CHECK (duration > 0 AND duration <= 600),
  format         TEXT NOT NULL DEFAULT 'In-person',
  notes          TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled','Completed','Cancelled','Postponed')),
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  postponed_to   DATE,
  postponed_time TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings(date);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id);
CREATE INDEX IF NOT EXISTS bookings_user_date_idx ON bookings(user_id, date);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings(status);

CREATE TABLE IF NOT EXISTS team_members (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS team_members_booking_idx ON team_members(booking_id);

CREATE TABLE IF NOT EXISTS study_notes (
  id         TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS study_notes_booking_idx ON study_notes(booking_id, created_at DESC);

CREATE TABLE IF NOT EXISTS materials (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL CHECK (size >= 0),
  mime        TEXT,
  data        TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS materials_booking_idx ON materials(booking_id, uploaded_at);

-- Presence tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
-- VPMO platform APK installed flag (tracked by trainer)
ALTER TABLE users ADD COLUMN IF NOT EXISTS has_vpmo_apk BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS apk_confirmed_at TIMESTAMPTZ;

-- Direct messages between users (with optional forwarded-note link)
CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  sender_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  forwarded_note_id TEXT REFERENCES study_notes(id) ON DELETE SET NULL,
  forwarded_booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  read_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS messages_pair_idx ON messages(LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), created_at);
CREATE INDEX IF NOT EXISTS messages_recipient_unread_idx ON messages(recipient_id, read_at) WHERE read_at IS NULL;

-- One-time cleanup (safe no-ops if already applied). Older schema
-- had users.email UNIQUE which conflicts with our new LOWER(email) index.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'users' AND c.contype = 'u' AND c.conname = 'users_email_key'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_email_key;
  END IF;
END $$;
