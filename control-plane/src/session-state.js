/**
 * Central session lifecycle state machine (issue #28). States:
 * `pending_bootstrap`, `active`, `pending_bootstrap-failed` (terminal), `archived` (terminal).
 * The transition table below is the single source of truth — `routes/sessions.js`'s PATCH
 * handler and `spawn-session.js`'s post-bootstrap updates must both validate through it rather
 * than re-deriving allowed transitions independently.
 */

/** @type {Record<string, string[]>} */
const ALLOWED_TRANSITIONS = {
  pending_bootstrap: ['active', 'pending_bootstrap-failed', 'archived'],
  active: ['archived'],
  'pending_bootstrap-failed': ['archived'],
  archived: [],
};

/**
 * Returns whether transitioning a session from `currentStatus` to `targetStatus` is allowed.
 * @param {string} currentStatus - Session's current `status` column value.
 * @param {string} targetStatus - Requested new `status` value.
 * @returns {boolean} Whether the transition is allowed.
 */
export function isValidTransition(currentStatus, targetStatus) {
  return (ALLOWED_TRANSITIONS[currentStatus] ?? []).includes(targetStatus);
}
