-- Google-origin busy periods are separate from clinic bookings and the export outbox.
CREATE TABLE google_calendar_busy (
 calendar_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 start_at TEXT NOT NULL,
 end_at TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(calendar_id,event_id)
);
CREATE INDEX idx_google_busy_times ON google_calendar_busy(start_at,end_at);

CREATE TABLE google_calendar_import (
 calendar_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL DEFAULT '',
 page_token TEXT NOT NULL DEFAULT '',
 window_start TEXT NOT NULL DEFAULT '',
 window_end TEXT NOT NULL DEFAULT '',
 started_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT NOT NULL DEFAULT '',
 lease_until INTEGER NOT NULL DEFAULT 0,
 synced_at TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT ''
);

-- Publish only after all pages have been fetched. A failed fetch keeps the prior snapshot.
CREATE TABLE google_calendar_import_stage (
 calendar_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 start_at TEXT NOT NULL,
 end_at TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(calendar_id,run_id,event_id)
);
