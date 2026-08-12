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
 * @returns {boolean} Whether `model` is a syntactically valid `provider/model` reference.
 */
export function isValidModelReference(model) {
  if (typeof model !== 'string' || model.length === 0) return false;
  const i = model.indexOf('/');
  if (i <= 0) return false;
  if (i === model.length - 1) return false;
  return true;
}
