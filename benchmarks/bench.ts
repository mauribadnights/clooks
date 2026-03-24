/**
 * clooks performance benchmarks
 *
 * Measures the performance advantage of clooks (persistent HTTP daemon)
 * vs raw command hooks (fresh process per invocation).
 *
 * clooks uses inline handlers (JS modules loaded once, executed in-process)
 * while command hooks spawn a fresh Node.js process for every invocation.
 *
 * Run: npm run bench
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { request } from 'http';
import { performance } from 'perf_hooks';

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const BENCH_DIR = dirname(__filename);
const CODE_DIR = resolve(BENCH_DIR, '..');
const ECHO_HOOK = join(BENCH_DIR, 'echo-hook.js');
const ECHO_INLINE = join(BENCH_DIR, 'echo-hook-inline.js');
const SLOW_HOOK = join(BENCH_DIR, 'slow-hook.js');
const BENCH_PORT = 17890;

const HOOK_PAYLOAD = JSON.stringify({
  session_id: 'bench-session',
  transcript_path: '/tmp/bench-transcript',
  cwd: '/tmp',
  permission_mode: 'default',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo hello' },
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

interface Stats {
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  p99: number;
  samples: number[];
}

function computeStats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean: samples.reduce((a, b) => a + b, 0) / n,
    median: n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
    samples,
  };
}

function fmt(ms: number): string {
  if (ms < 1) return `${ms.toFixed(3)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtStats(s: Stats): string {
  return `mean ${fmt(s.mean)}  median ${fmt(s.median)}  p95 ${fmt(s.p95)}  p99 ${fmt(s.p99)}`;
}

// ---------------------------------------------------------------------------
// Command hook execution (fresh process per invocation — the baseline)
// ---------------------------------------------------------------------------

function runCommandHook(scriptPath: string): Promise<number> {
  return new Promise((res, rej) => {
    const start = performance.now();
    const child = spawn('node', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stdin.write(HOOK_PAYLOAD);
    child.stdin.end();
    child.on('close', (code) => {
      if (code !== 0) return rej(new Error(`Hook exited ${code}`));
      JSON.parse(stdout);
      res(performance.now() - start);
    });
    child.on('error', rej);
  });
}

// ---------------------------------------------------------------------------
// HTTP hook execution (POST to clooks daemon)
// ---------------------------------------------------------------------------

function runHttpHook(event: string = 'PostToolUse'): Promise<number> {
  return new Promise((res, rej) => {
    const start = performance.now();
    const req = request(
      {
        hostname: '127.0.0.1',
        port: BENCH_PORT,
        path: `/hooks/${event}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(HOOK_PAYLOAD) },
      },
      (resp) => {
        let body = '';
        resp.on('data', (d: Buffer) => { body += d.toString(); });
        resp.on('end', () => {
          if (resp.statusCode !== 200) return rej(new Error(`HTTP ${resp.statusCode}: ${body}`));
          JSON.parse(body);
          res(performance.now() - start);
        });
      }
    );
    req.on('error', rej);
    req.write(HOOK_PAYLOAD);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Daemon lifecycle (in-process, using server module directly)
// ---------------------------------------------------------------------------

async function startDaemonDirect(manifestHandlers: Record<string, any[]>): Promise<{ close: () => void }> {
  const { createServer: createClooksServer } = await import(join(CODE_DIR, 'dist', 'server.js'));
  const { MetricsCollector } = await import(join(CODE_DIR, 'dist', 'metrics.js'));

  const manifest = {
    handlers: manifestHandlers,
    settings: { port: BENCH_PORT, logLevel: 'error' as const },
  };

  const metrics = new MetricsCollector('/dev/null');
  const ctx = createClooksServer(manifest, metrics);

  await new Promise<void>((resolve, reject) => {
    ctx.server.on('error', reject);
    ctx.server.listen(BENCH_PORT, '127.0.0.1', () => resolve());
  });

  return { close: () => ctx.server.close() };
}

// ---------------------------------------------------------------------------
// Benchmark 1: Cold Start — Single Hook Invocation
// ---------------------------------------------------------------------------

async function benchColdStart(iterations: number): Promise<{ command: Stats; http: Stats }> {
  process.stdout.write(`\n  Running cold start benchmark (${iterations} iterations)...`);

  // Warmup
  for (let i = 0; i < 5; i++) {
    await runCommandHook(ECHO_HOOK);
    await runHttpHook();
  }

  const commandTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    commandTimes.push(await runCommandHook(ECHO_HOOK));
  }

  const httpTimes: number[] = [];
  for (let i = 0; i < iterations; i++) {
    httpTimes.push(await runHttpHook());
  }

  console.log(' done');
  return { command: computeStats(commandTimes), http: computeStats(httpTimes) };
}

// ---------------------------------------------------------------------------
// Benchmark 2: Simulated Session
// ---------------------------------------------------------------------------

async function benchSession(): Promise<{ commandMs: number; httpMs: number }> {
  process.stdout.write('  Running simulated session benchmark...');

  // Session shape:
  //   1  SessionStart      x 3 handlers =   3 invocations
  //  15  UserPromptSubmit   x 1 handler  =  15 invocations
  //  50  PostToolUse        x 2 handlers = 100 invocations
  //   1  Stop               x 2 handlers =   2 invocations
  //                                        ─── ───────────
  //  67  event fires          120 total handler invocations

  const sessionEvents = [
    ...Array(1).fill({ event: 'SessionStart', handlerCount: 3 }),
    ...Array(15).fill({ event: 'UserPromptSubmit', handlerCount: 1 }),
    ...Array(50).fill({ event: 'PostToolUse', handlerCount: 2 }),
    ...Array(1).fill({ event: 'Stop', handlerCount: 2 }),
  ];

  // Without clooks: one process spawn per handler invocation (120 spawns, sequential)
  const cmdStart = performance.now();
  for (const { handlerCount } of sessionEvents) {
    for (let h = 0; h < handlerCount; h++) {
      await runCommandHook(ECHO_HOOK);
    }
  }
  const commandMs = performance.now() - cmdStart;

  // With clooks: one HTTP POST per event fire (67 posts, daemon handles parallelism)
  const httpStart = performance.now();
  for (const { event } of sessionEvents) {
    await runHttpHook(event);
  }
  const httpMs = performance.now() - httpStart;

  console.log(' done');
  return { commandMs, httpMs };
}

// ---------------------------------------------------------------------------
// Benchmark 3: Concurrent Handler Execution
// ---------------------------------------------------------------------------

async function benchConcurrent(): Promise<{ sequentialMs: number; parallelMs: number }> {
  process.stdout.write('  Running concurrent handler benchmark...');

  // Sequential: 5 slow hooks spawned one after another
  const seqStart = performance.now();
  for (let i = 0; i < 5; i++) {
    await runCommandHook(SLOW_HOOK);
  }
  const sequentialMs = performance.now() - seqStart;

  // Parallel via clooks: single POST, daemon dispatches 5 handlers concurrently
  const parStart = performance.now();
  await runHttpHook('PreToolUse');
  const parallelMs = performance.now() - parStart;

  console.log(' done');
  return { sequentialMs, parallelMs };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('=== clooks v0.1.0 Benchmark Results ===');
  console.log(`Node ${process.version} | ${process.platform} ${process.arch}`);
  console.log(`Date: ${new Date().toISOString()}`);

  // --- Build manifest with inline handlers (the clooks advantage) ---

  const inlineEcho = (id: string) => ({
    id,
    type: 'inline' as const,
    module: ECHO_INLINE,
    timeout: 5000,
  });

  // Script handlers for concurrency test — spawn-based but dispatched in parallel by daemon
  const scriptSlow = (id: string) => ({
    id,
    type: 'script' as const,
    command: `node ${SLOW_HOOK}`,
    timeout: 5000,
  });

  const manifestHandlers: Record<string, any[]> = {
    SessionStart: [inlineEcho('session-1'), inlineEcho('session-2'), inlineEcho('session-3')],
    UserPromptSubmit: [inlineEcho('prompt-1')],
    PostToolUse: [inlineEcho('post-tool-1'), inlineEcho('post-tool-2')],
    Stop: [inlineEcho('stop-1'), inlineEcho('stop-2')],
    PreToolUse: [scriptSlow('slow-1'), scriptSlow('slow-2'), scriptSlow('slow-3'), scriptSlow('slow-4'), scriptSlow('slow-5')],
  };

  let daemon: { close: () => void } | null = null;
  try {
    daemon = await startDaemonDirect(manifestHandlers);
    console.log(`Daemon listening on 127.0.0.1:${BENCH_PORT}\n`);

    // ── Benchmark 1 ──────────────────────────────────────────────────────
    const coldStart = await benchColdStart(50);
    const speedup1 = coldStart.command.mean / coldStart.http.mean;

    console.log('');
    console.log('─'.repeat(72));
    console.log(' Cold Start: Single Hook Invocation (50 iterations)');
    console.log('─'.repeat(72));
    console.log(`  Command hook (process spawn):  ${fmtStats(coldStart.command)}`);
    console.log(`  HTTP hook (clooks daemon):     ${fmtStats(coldStart.http)}`);
    console.log(`  Speedup: ${speedup1.toFixed(1)}x faster`);

    // ── Benchmark 2 ──────────────────────────────────────────────────────
    const session = await benchSession();
    const timeSaved = session.commandMs - session.httpMs;
    const pctSaved = (timeSaved / session.commandMs) * 100;

    console.log('');
    console.log('─'.repeat(72));
    console.log(' Simulated Session (120 handler invocations)');
    console.log('─'.repeat(72));
    console.log(`  Without clooks (120 spawns):   ${fmt(session.commandMs)}`);
    console.log(`  With clooks (67 HTTP posts):   ${fmt(session.httpMs)}`);
    console.log(`  Time saved: ${fmt(timeSaved)} (${pctSaved.toFixed(0)}%)`);

    // ── Benchmark 3 ──────────────────────────────────────────────────────
    const concurrent = await benchConcurrent();
    const speedup3 = concurrent.sequentialMs / concurrent.parallelMs;

    console.log('');
    console.log('─'.repeat(72));
    console.log(' Concurrent Handlers (5 parallel, each ~50ms)');
    console.log('─'.repeat(72));
    console.log(`  Sequential spawns:             ${fmt(concurrent.sequentialMs)}`);
    console.log(`  clooks parallel dispatch:      ${fmt(concurrent.parallelMs)}`);
    console.log(`  Speedup: ${speedup3.toFixed(1)}x faster`);

    console.log('');
    console.log('='.repeat(72));

    // ── Save results ─────────────────────────────────────────────────────
    const results = {
      meta: {
        version: '0.1.0',
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        date: new Date().toISOString(),
      },
      coldStart: {
        iterations: 50,
        command: {
          mean: +coldStart.command.mean.toFixed(2),
          median: +coldStart.command.median.toFixed(2),
          p95: +coldStart.command.p95.toFixed(2),
          p99: +coldStart.command.p99.toFixed(2),
          min: +coldStart.command.min.toFixed(2),
          max: +coldStart.command.max.toFixed(2),
        },
        http: {
          mean: +coldStart.http.mean.toFixed(2),
          median: +coldStart.http.median.toFixed(2),
          p95: +coldStart.http.p95.toFixed(2),
          p99: +coldStart.http.p99.toFixed(2),
          min: +coldStart.http.min.toFixed(2),
          max: +coldStart.http.max.toFixed(2),
        },
        speedup: +speedup1.toFixed(1),
      },
      simulatedSession: {
        totalHandlerInvocations: 120,
        totalEventFires: 67,
        commandMs: +session.commandMs.toFixed(1),
        httpMs: +session.httpMs.toFixed(1),
        timeSavedMs: +timeSaved.toFixed(1),
        pctSaved: +pctSaved.toFixed(0),
      },
      concurrentHandlers: {
        handlerCount: 5,
        delayPerHandlerMs: 50,
        sequentialMs: +concurrent.sequentialMs.toFixed(1),
        parallelMs: +concurrent.parallelMs.toFixed(1),
        speedup: +speedup3.toFixed(1),
      },
    };

    const resultsPath = join(BENCH_DIR, 'results.json');
    writeFileSync(resultsPath, JSON.stringify(results, null, 2), 'utf-8');
    console.log(`\nResults saved to benchmarks/results.json`);
  } catch (err) {
    console.error('Benchmark failed:', err);
    process.exit(1);
  } finally {
    if (daemon) daemon.close();
  }
}

main();
