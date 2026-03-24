import { describe, it, expect } from 'vitest';
import { evaluateFilter } from '../src/filter.js';

describe('evaluateFilter', () => {
  it('basic OR matching: "word1|word2" matches if either present', () => {
    expect(evaluateFilter('word1|word2', 'this has word1 in it')).toBe(true);
    expect(evaluateFilter('word1|word2', 'this has word2 in it')).toBe(true);
  });

  it('returns false when no keywords match', () => {
    expect(evaluateFilter('word1|word2', 'nothing relevant here')).toBe(false);
  });

  it('negation: "!word" blocks if word present', () => {
    expect(evaluateFilter('!blocked', 'this text contains blocked term')).toBe(false);
  });

  it('negation allows when word absent', () => {
    expect(evaluateFilter('!blocked', 'this text is clean')).toBe(true);
  });

  it('mixed: "word1|!word2" matches word1 unless word2 present', () => {
    // word1 present, word2 absent -> true
    expect(evaluateFilter('word1|!word2', 'has word1 only')).toBe(true);
    // word1 present, word2 also present -> blocked by negation
    expect(evaluateFilter('word1|!word2', 'has word1 and word2')).toBe(false);
    // word1 absent, word2 absent -> only negative terms, none matched -> true
    expect(evaluateFilter('word1|!word2', 'something else entirely')).toBe(false);
  });

  it('is case insensitive', () => {
    expect(evaluateFilter('Hello', 'HELLO world')).toBe(true);
    expect(evaluateFilter('HELLO', 'hello world')).toBe(true);
    expect(evaluateFilter('!BLOCKED', 'this has blocked word')).toBe(false);
  });

  it('empty filter returns true', () => {
    expect(evaluateFilter('', 'any input')).toBe(true);
  });

  it('whitespace-only filter returns true', () => {
    expect(evaluateFilter('  |  ', 'any input')).toBe(true);
  });

  it('single keyword match', () => {
    expect(evaluateFilter('target', 'hit the target')).toBe(true);
    expect(evaluateFilter('target', 'miss everything')).toBe(false);
  });

  it('works against JSON-stringified input (real-world usage)', () => {
    const hookInput = {
      tool_name: 'Write',
      tool_input: { file_path: '/home/user/code/main.ts', content: 'console.log("hello")' },
      cwd: '/home/user/code',
    };
    const jsonStr = JSON.stringify(hookInput);

    expect(evaluateFilter('Write', jsonStr)).toBe(true);
    expect(evaluateFilter('Read', jsonStr)).toBe(false);
    expect(evaluateFilter('Write|!main.ts', jsonStr)).toBe(false); // negation blocks
    expect(evaluateFilter('Write|Read', jsonStr)).toBe(true);
    expect(evaluateFilter('file_path', jsonStr)).toBe(true);
  });

  it('only negative terms, none matched -> allow', () => {
    expect(evaluateFilter('!bad|!evil', 'perfectly fine text')).toBe(true);
  });

  it('multiple negative terms, one matched -> block', () => {
    expect(evaluateFilter('!bad|!evil', 'this is evil stuff')).toBe(false);
  });
});
