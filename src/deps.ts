// clooks dependency resolution — topological ordering of handler execution

import type { HandlerConfig } from './types.js';

/**
 * Build a directed acyclic graph from handler dependencies.
 * Returns handlers grouped into "waves" — each wave contains handlers
 * that can execute in parallel (all their deps are in previous waves).
 *
 * Wave 0: handlers with no deps
 * Wave 1: handlers whose deps are all in wave 0
 * etc.
 *
 * Uses Kahn's algorithm. Throws on cycles.
 */
export function resolveExecutionOrder(handlers: HandlerConfig[]): HandlerConfig[][] {
  if (handlers.length === 0) return [];

  // Build lookup and adjacency
  const handlerMap = new Map<string, HandlerConfig>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // depId → [handlers that depend on it]

  for (const h of handlers) {
    handlerMap.set(h.id, h);
    inDegree.set(h.id, 0);
    if (!dependents.has(h.id)) {
      dependents.set(h.id, []);
    }
  }

  // Only consider deps that reference handlers in this set
  const handlerIds = new Set(handlers.map(h => h.id));

  for (const h of handlers) {
    if (!h.depends || h.depends.length === 0) continue;

    for (const dep of h.depends) {
      if (!handlerIds.has(dep)) {
        // Dependency references a handler not in this event's set — skip silently
        // (cross-event deps are not supported within a single executeHandlers call)
        continue;
      }

      inDegree.set(h.id, (inDegree.get(h.id) ?? 0) + 1);

      const existing = dependents.get(dep) ?? [];
      existing.push(h.id);
      dependents.set(dep, existing);
    }
  }

  // BFS — Kahn's algorithm, collecting waves
  const waves: HandlerConfig[][] = [];
  let queue: string[] = [];

  // Wave 0: all handlers with in-degree 0
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  let processedCount = 0;

  while (queue.length > 0) {
    const wave: HandlerConfig[] = [];
    const nextQueue: string[] = [];

    for (const id of queue) {
      wave.push(handlerMap.get(id)!);
      processedCount++;

      // Decrement in-degree of dependents
      for (const depId of dependents.get(id) ?? []) {
        const newDegree = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, newDegree);
        if (newDegree === 0) {
          nextQueue.push(depId);
        }
      }
    }

    waves.push(wave);
    queue = nextQueue;
  }

  // Cycle detection: if not all handlers were processed, there's a cycle
  if (processedCount < handlers.length) {
    const cycleIds = handlers
      .filter(h => (inDegree.get(h.id) ?? 0) > 0)
      .map(h => h.id);
    throw new Error(
      `Dependency cycle detected among handlers: ${cycleIds.join(', ')}`
    );
  }

  return waves;
}
