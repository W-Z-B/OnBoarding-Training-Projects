-- GPL VPMO Training schema. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  full_name     TEXT NOT NULL,
  phone         TEXT NOT NULL,
  unit          TEXT NOT NULL,
  salt          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name      TEXT NOT NULL,
  email          TEXT NOT NULL,
  phone          TEXT NOT NULL,
  unit           TEXT NOT NULL,
  level          TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'Member',
  attendees      INTEGER NOT NULL DEFAULT 1,
  date           DATE NOT NULL,
  "time"         TEXT NOT NULL,
  duration       INTEGER NOT NULL,
  format         TEXT NOT NULL DEFAULT 'In-person',
  notes          TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Scheduled',
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  postponed_to   DATE,
  postponed_time TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS bookings_date_idx ON bookings(date);
CREATE INDEX IF NOT EXISTS bookings_user_idx ON bookings(user_id);

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
CREATE INDEX IF NOT EXISTS study_notes_booking_idx ON study_notes(booking_id);

CREATE TABLE IF NOT EXISTS materials (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mime        TEXT,
  data        TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS materials_booking_idx ON materials(booking_id);
