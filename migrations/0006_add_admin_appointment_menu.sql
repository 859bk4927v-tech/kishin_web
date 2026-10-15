-- Old appointments keep their saved times; an empty menu preserves their behavior.
ALTER TABLE blocked_periods ADD COLUMN menu TEXT NOT NULL DEFAULT '';
