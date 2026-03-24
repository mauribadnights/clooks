// Minimal hook script for benchmarking — reads stdin JSON, writes JSON to stdout
let data = '';
process.stdin.on('data', (chunk) => { data += chunk; });
process.stdin.on('end', () => {
  JSON.parse(data); // parse to simulate real work
  process.stdout.write(JSON.stringify({ additionalContext: 'ok' }));
});
