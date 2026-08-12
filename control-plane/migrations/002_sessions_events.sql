CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  repo_owner TEXT,
  repo_name TEXT,
  model TEXT,
  reasoning_effort TEXT,
  status TEXT NOT NULL,
  container_name TEXT,
  opencode_session_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX idx_events_session_timestamp_id ON events (session_id, timestamp, id);
