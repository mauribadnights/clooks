// clooks prefetch — shared context pre-fetching for handlers

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import type { PrefetchKey, PrefetchContext, HookInput } from './types.js';

const MAX_TRANSCRIPT_BYTES = 50 * 1024;  // 50KB
const MAX_GIT_DIFF_BYTES = 20 * 1024;    // 20KB

/**
 * Pre-fetch requested context data. Each key is fetched once and cached.
 * Errors are caught per-key (a failed git_status doesn't block transcript).
 */
export async function prefetchContext(
  keys: PrefetchKey[],
  input: HookInput
): Promise<PrefetchContext> {
  const ctx: PrefetchContext = {};

  for (const key of keys) {
    try {
      switch (key) {
        case 'transcript': {
          if (input.transcript_path && existsSync(input.transcript_path)) {
            const raw = readFileSync(input.transcript_path, 'utf-8');
            // Truncate to last 50KB to avoid memory issues
            ctx.transcript = raw.length > MAX_TRANSCRIPT_BYTES
              ? raw.slice(-MAX_TRANSCRIPT_BYTES)
              : raw;
          }
          break;
        }
        case 'git_status': {
          const status = execSync('git status --porcelain', {
            cwd: input.cwd,
            encoding: 'utf-8',
            timeout: 5000,
          });
          ctx.git_status = status;
          break;
        }
        case 'git_diff': {
          const diff = execSync('git diff --no-ext-diff --stat', {
            cwd: input.cwd,
            encoding: 'utf-8',
            timeout: 5000,
          });
          // Truncate to 20KB
          ctx.git_diff = diff.length > MAX_GIT_DIFF_BYTES
            ? diff.slice(0, MAX_GIT_DIFF_BYTES)
            : diff;
          break;
        }
      }
    } catch {
      // Errors are silently caught per-key — a failed git_status doesn't block transcript
    }
  }

  return ctx;
}

/**
 * Render a prompt template by replacing $VARIABLES with actual values.
 * Supported: $TRANSCRIPT, $GIT_STATUS, $GIT_DIFF, $ARGUMENTS, $TOOL_NAME, $PROMPT, $CWD
 */
export function renderPromptTemplate(
  template: string,
  input: HookInput,
  context: PrefetchContext
): string {
  return template
    .replace(/\$TRANSCRIPT/g, context.transcript ?? '')
    .replace(/\$GIT_STATUS/g, context.git_status ?? '')
    .replace(/\$GIT_DIFF/g, context.git_diff ?? '')
    .replace(/\$ARGUMENTS/g, input.tool_input ? JSON.stringify(input.tool_input) : '')
    .replace(/\$TOOL_NAME/g, input.tool_name ?? '')
    .replace(/\$PROMPT/g, input.prompt ?? '')
    .replace(/\$CWD/g, input.cwd ?? '');
}
