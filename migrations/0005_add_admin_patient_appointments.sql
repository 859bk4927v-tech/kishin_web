-- Existing blocked periods remain private, with their dates and notes preserved.
ALTER TABLE blocked_periods ADD COLUMN block_type TEXT NOT NULL DEFAULT 'private'
    CHECK (block_type IN ('private', 'patient'));
ALTER TABLE blocked_periods ADD COLUMN customer_name TEXT NOT NULL DEFAULT '';
ALTER TABLE blocked_periods ADD COLUMN phone TEXT NOT NULL DEFAULT '';
