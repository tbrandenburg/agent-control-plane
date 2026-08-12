import { describe, expect, it } from 'vitest';
import {
  isValidModelReference,
  isValidRepoSegment,
  isValidTitle,
  splitModel,
} from './model.js';

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

describe('isValidRepoSegment', () => {
  it.each([
    ['acme', true],
    ['acme-org', true],
    ['acme.org', true],
    ['acme_org', true],
    ['../../etc', false],
    ['weird name!!', false],
    ['', false],
    ['a/b', false],
    ['a'.repeat(100), true],
    ['a'.repeat(101), false],
  ])('%s -> %s', (value, expected) => {
    expect(isValidRepoSegment(value)).toBe(expected);
  });

  it('rejects non-string input', () => {
    expect(isValidRepoSegment(undefined)).toBe(false);
    expect(isValidRepoSegment(123)).toBe(false);
  });
});

describe('isValidTitle', () => {
  it('accepts a normal title', () => {
    expect(isValidTitle('My session')).toBe(true);
  });

  it('accepts a title at the max length', () => {
    expect(isValidTitle('x'.repeat(200))).toBe(true);
  });

  it('rejects a title exceeding the max length', () => {
    expect(isValidTitle('x'.repeat(201))).toBe(false);
  });

  it('rejects an empty title', () => {
    expect(isValidTitle('')).toBe(false);
  });

  it('does not sanitize content (out of scope) — only length is validated', () => {
    expect(isValidTitle('<script>alert(1)</script>')).toBe(true);
  });
});
