import { describe, expect, it } from 'vitest';
import { isValidModelReference, splitModel } from './model.js';

describe('splitModel', () => {
  it('splits on the first slash only', () => {
    expect(splitModel('litellm/a/b')).toEqual({
      providerID: 'litellm',
      modelID: 'a/b',
    });
  });
});

describe('isValidModelReference', () => {
  it.each([
    ['litellm/x', true],
    ['x', false],
    ['/x', false],
    ['x/', false],
    ['litellm/a/b', true],
    ['litellm/not-in-allowlist', true],
  ])('%s -> %s', (model, expected) => {
    expect(isValidModelReference(model)).toBe(expected);
  });
});
