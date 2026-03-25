import { describe, it, expect } from 'vitest';
import { resolveExecutionOrder } from '../src/deps.js';
import type { HandlerConfig } from '../src/types.js';

function makeHandler(id: string, depends?: string[]): HandlerConfig {
  return { id, type: 'script', command: 'true', depends };
}

describe('resolveExecutionOrder', () => {
  it('returns empty array for empty input', () => {
    expect(resolveExecutionOrder([])).toEqual([]);
  });

  it('returns single wave when no dependencies', () => {
    const handlers = [makeHandler('a'), makeHandler('b'), makeHandler('c')];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(3);
    const ids = waves[0].map(h => h.id).sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('creates two waves for a simple dependency', () => {
    const handlers = [
      makeHandler('a'),
      makeHandler('b', ['a']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(2);
    expect(waves[0].map(h => h.id)).toEqual(['a']);
    expect(waves[1].map(h => h.id)).toEqual(['b']);
  });

  it('creates correct waves for a diamond dependency', () => {
    // A → B, A → C, B → D, C → D
    const handlers = [
      makeHandler('a'),
      makeHandler('b', ['a']),
      makeHandler('c', ['a']),
      makeHandler('d', ['b', 'c']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(3);
    expect(waves[0].map(h => h.id)).toEqual(['a']);
    expect(waves[1].map(h => h.id).sort()).toEqual(['b', 'c']);
    expect(waves[2].map(h => h.id)).toEqual(['d']);
  });

  it('creates correct waves for a chain', () => {
    const handlers = [
      makeHandler('c', ['b']),
      makeHandler('a'),
      makeHandler('b', ['a']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(3);
    expect(waves[0].map(h => h.id)).toEqual(['a']);
    expect(waves[1].map(h => h.id)).toEqual(['b']);
    expect(waves[2].map(h => h.id)).toEqual(['c']);
  });

  it('throws on cycle', () => {
    const handlers = [
      makeHandler('a', ['b']),
      makeHandler('b', ['a']),
    ];

    expect(() => resolveExecutionOrder(handlers)).toThrow('Dependency cycle detected');
    expect(() => resolveExecutionOrder(handlers)).toThrow('a');
    expect(() => resolveExecutionOrder(handlers)).toThrow('b');
  });

  it('throws on self-referencing handler', () => {
    const handlers = [makeHandler('x', ['x'])];
    expect(() => resolveExecutionOrder(handlers)).toThrow('Dependency cycle detected');
  });

  it('throws on three-node cycle', () => {
    const handlers = [
      makeHandler('a', ['c']),
      makeHandler('b', ['a']),
      makeHandler('c', ['b']),
    ];
    expect(() => resolveExecutionOrder(handlers)).toThrow('Dependency cycle detected');
  });

  it('ignores dependencies on handlers not in this set', () => {
    // b depends on 'external' which isn't in our handler list — should be ignored
    const handlers = [
      makeHandler('a'),
      makeHandler('b', ['external']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  it('handles mixed deps and no-deps in same wave correctly', () => {
    const handlers = [
      makeHandler('a'),
      makeHandler('b'),
      makeHandler('c', ['a']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(2);
    expect(waves[0].map(h => h.id).sort()).toEqual(['a', 'b']);
    expect(waves[1].map(h => h.id)).toEqual(['c']);
  });

  it('handles complex multi-wave graph', () => {
    // wave 0: a, b
    // wave 1: c (depends on a), d (depends on b)
    // wave 2: e (depends on c, d)
    const handlers = [
      makeHandler('a'),
      makeHandler('b'),
      makeHandler('c', ['a']),
      makeHandler('d', ['b']),
      makeHandler('e', ['c', 'd']),
    ];
    const waves = resolveExecutionOrder(handlers);

    expect(waves).toHaveLength(3);
    expect(waves[0].map(h => h.id).sort()).toEqual(['a', 'b']);
    expect(waves[1].map(h => h.id).sort()).toEqual(['c', 'd']);
    expect(waves[2].map(h => h.id)).toEqual(['e']);
  });
});
