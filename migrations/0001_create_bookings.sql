CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    booking_number TEXT NOT NULL UNIQUE,
    idempotency_key TEXT NOT NULL UNIQUE,
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    menu TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled')),
    notification_status TEXT NOT NULL DEFAULT 'pending',
    notification_error TEXT NOT NULL DEFAULT '',
    line_retry_key TEXT NOT NULL DEFAULT '',
    line_retry_created_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_start_status
    ON bookings(start_at, status);
