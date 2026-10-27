-- Additive metadata only: reservations and imported busy periods are unchanged.
CREATE TABLE google_calendar_watch_state (
  calendar_id TEXT PRIMARY KEY NOT NULL,
  lease_token TEXT NOT NULL DEFAULT '',
  lease_until INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE google_calendar_watch_channel (
  id TEXT PRIMARY KEY NOT NULL,
  calendar_id TEXT NOT NULL,
  address TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL DEFAULT '',
  expires_at INTEGER NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  message_number TEXT NOT NULL DEFAULT '',
  notified_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX google_calendar_watch_active ON google_calendar_watch_channel(calendar_id, expires_at);

-- Notifications arriving during an import must remain pending after publication.
ALTER TABLE google_calendar_import ADD COLUMN requested_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendar_import ADD COLUMN run_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_calendar_import ADD COLUMN completed_revision INTEGER NOT NULL DEFAULT 0;
