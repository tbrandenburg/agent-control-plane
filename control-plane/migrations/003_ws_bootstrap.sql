-- Adds the plaintext WebSocket subscribe token issued at session creation (ARCHITECTURE.md §6).
-- No rotation/hashing yet (Phase 4) and no structured bootstrap-diagnostics columns yet (Phase 3) —
-- deliberately minimal, per this step's scope.
ALTER TABLE sessions ADD COLUMN ws_token TEXT;
