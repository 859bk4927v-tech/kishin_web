-- Transactional outbox: a Google outage never rolls back a valid reservation.
-- No patient/contact payloads or credentials are copied into the queue.
CREATE TABLE google_calendar_sync (
 source_type TEXT NOT NULL CHECK(source_type IN ('booking','block')),
 source_id TEXT NOT NULL,
 version INTEGER NOT NULL DEFAULT 1,
 pending INTEGER NOT NULL DEFAULT 1,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT NOT NULL DEFAULT '',
 lease_until INTEGER NOT NULL DEFAULT 0,
 calendar_id TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT '',
 synced_at TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(source_type, source_id)
);
CREATE INDEX idx_google_calendar_pending ON google_calendar_sync(pending, next_attempt_at, lease_until);

CREATE TRIGGER google_calendar_booking_insert
AFTER INSERT ON bookings
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('booking',NEW.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

CREATE TRIGGER google_calendar_booking_update
AFTER UPDATE OF start_at,end_at,menu,customer_name,status ON bookings
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('booking',NEW.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

CREATE TRIGGER google_calendar_booking_delete
AFTER DELETE ON bookings
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('booking',OLD.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

INSERT INTO google_calendar_sync(source_type,source_id) SELECT 'booking',id FROM bookings WHERE julianday(end_at)>=julianday('now') AND status='confirmed';

CREATE TRIGGER google_calendar_block_insert
AFTER INSERT ON blocked_periods
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('block',NEW.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

CREATE TRIGGER google_calendar_block_update
AFTER UPDATE OF start_at,end_at,menu,customer_name,block_type ON blocked_periods
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('block',NEW.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

CREATE TRIGGER google_calendar_block_delete
AFTER DELETE ON blocked_periods
BEGIN
 INSERT INTO google_calendar_sync(source_type,source_id) VALUES('block',OLD.id)
 ON CONFLICT(source_type,source_id) DO UPDATE SET
 version=version+1,pending=1,attempts=0,next_attempt_at=0,last_error='';
END;

INSERT INTO google_calendar_sync(source_type,source_id) SELECT 'block',id FROM blocked_periods WHERE julianday(end_at)>=julianday('now');
