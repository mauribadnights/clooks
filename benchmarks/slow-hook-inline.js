// Inline handler that takes ~50ms — for concurrency benchmarking
export default function handler(_input) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ additionalContext: 'slow-ok' });
    }, 50);
  });
}
