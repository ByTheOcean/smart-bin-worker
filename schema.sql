CREATE TABLE IF NOT EXISTS bins (
    bin_id TEXT PRIMARY KEY,
    case_code TEXT,
    bin_type TEXT,
    notes TEXT,
    photo_key TEXT,
    updated_at INTEGER
);
