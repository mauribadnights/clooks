// Hook that takes ~50ms — for concurrency benchmarking
let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  JSON.parse(data);
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ additionalContext: 'slow-ok' }));
  }, 50);
});
