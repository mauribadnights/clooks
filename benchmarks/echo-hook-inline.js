// Inline handler module for benchmarking — already loaded in memory, no process spawn
export default function handler(_input) {
  return { additionalContext: 'ok' };
}
