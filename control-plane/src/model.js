/**
 * Model reference handling shared by `POST /api/sessions` and `POST /api/sessions/:id/prompt`
 * (ARCHITECTURE.md §5/§8). Validation is syntax only — `provider/model`, first-`/`-is-separator —
 * never allowlist membership (ARCHITECTURE.md §5 explicitly warns against adding that gate).
 */

/**
 * Splits a `provider/model` string on the FIRST `/` only — model ids can legitimately contain
 * further slashes (e.g. `litellm/eu.anthropic.claude-sonnet-4-6`, or `litellm/a/b`).
 * @param {string} model - Raw model reference.
 * @returns {{providerID: string, modelID: string}} The split provider/model pair.
 */
export function splitModel(model) {
  const i = model.indexOf('/');
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/**
 * Validates a model reference's syntax only: non-empty `provider` and `model` around the first
 * `/`. Does NOT check membership in `MODEL_ALLOWLIST` — that gate is deliberately not part of this
 * design (ARCHITECTURE.md §5).
 * @param {unknown} model - Raw value to validate.
 * @returns {model is string} Whether `model` is a syntactically valid `provider/model` reference.
 */
export function isValidModelReference(model) {
  if (typeof model !== 'string' || model.length === 0) return false;
  const i = model.indexOf('/');
  if (i <= 0) return false;
  if (i === model.length - 1) return false;
  return true;
}

/** Max length for a GitHub repo owner/name segment (GitHub's own limit is 39/100; 100 is generous but bounded). */
export const MAX_REPO_SEGMENT_LENGTH = 100;

/** Max length for a session `title`. */
export const MAX_TITLE_LENGTH = 200;

const REPO_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Validates a GitHub repo owner or repo name segment: non-empty, bounded length, and restricted
 * to GitHub's own charset (alphanumeric, `.`, `_`, `-` — no `/`, spaces, or shell/path-special
 * characters).
 * @param {unknown} value - Raw value to validate.
 * @returns {value is string} Whether `value` is a syntactically valid repo owner/name.
 */
export function isValidRepoSegment(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.length > MAX_REPO_SEGMENT_LENGTH) return false;
  return REPO_SEGMENT_PATTERN.test(value);
}

/**
 * Validates a session `title`: non-empty string within the max length cap. Deliberately does not
 * sanitize or strip content (e.g. HTML/script tags) — rendering is the client's responsibility.
 * @param {unknown} value - Raw value to validate.
 * @returns {value is string} Whether `value` is a valid title.
 */
export function isValidTitle(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  return value.length <= MAX_TITLE_LENGTH;
}
