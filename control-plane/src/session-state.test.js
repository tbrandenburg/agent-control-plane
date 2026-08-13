import { describe, expect, it } from 'vitest';
import { isValidTransition } from './session-state.js';

describe('isValidTransition', () => {
  it.each([
    ['pending_bootstrap', 'active', true],
    ['pending_bootstrap', 'pending_bootstrap-failed', true],
    ['pending_bootstrap', 'archived', true],
    ['active', 'archived', true],
    ['pending_bootstrap-failed', 'archived', true],
    ['archived', 'active', false],
    ['archived', 'pending_bootstrap', false],
    ['active', 'pending_bootstrap', false],
    ['pending_bootstrap-failed', 'active', false],
    ['pending_bootstrap-failed', 'pending_bootstrap', false],
    ['active', 'active', false],
    ['unknown_status', 'active', false],
  ])('%s -> %s is %s', (current, target, expected) => {
    expect(isValidTransition(current, target)).toBe(expected);
  });
});
