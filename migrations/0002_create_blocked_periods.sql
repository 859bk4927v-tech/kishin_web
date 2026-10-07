CREATE TABLE IF NOT EXISTS blocked_periods (
    id TEXT PRIMARY KEY,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_blocked_periods_start
    ON blocked_periods(start_at);
