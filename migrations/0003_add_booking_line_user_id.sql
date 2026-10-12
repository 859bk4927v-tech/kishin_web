-- Existing bookings retain all their data and have no associated LINE user.
ALTER TABLE bookings ADD COLUMN line_user_id TEXT NOT NULL DEFAULT '';
