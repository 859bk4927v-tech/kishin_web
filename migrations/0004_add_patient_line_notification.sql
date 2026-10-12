-- Keep patient notifications separate from the existing owner notification.
ALTER TABLE bookings ADD COLUMN patient_line_notification_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE bookings ADD COLUMN patient_line_notification_error TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN patient_line_retry_key TEXT NOT NULL DEFAULT '';
ALTER TABLE bookings ADD COLUMN patient_line_retry_created_at TEXT NOT NULL DEFAULT '';
-- Preserve the original recipient and message when retrying an uncertain send.
ALTER TABLE bookings ADD COLUMN patient_line_payload TEXT NOT NULL DEFAULT '';
