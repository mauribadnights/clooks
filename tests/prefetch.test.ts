import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { prefetchContext, renderPromptTemplate } from '../src/prefetch.js';
import type { HookInput, PrefetchContext } from '../src/types.js';

function makeInput(overrides?: Partial<HookInput>): HookInput {
  return {
    session_id: 'test-session',
    transcript_path: '',
    cwd: '/tmp',
    permission_mode: 'default',
    hook_event_name: 'PostToolUse',
    ...overrides,
  };
}

describe('prefetchContext', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clooks-prefetch-'));
    // Safety assertion: ensure we're in a temp directory
    expect(tmpDir).toContain(tmpdir());
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads transcript file when it exists', async () => {
    const transcriptPath = join(tmpDir, 'transcript.txt');
    expect(transcriptPath).toContain(tmpDir); // Safety
    writeFileSync(transcriptPath, 'Hello this is a transcript');

    const ctx = await prefetchContext(
      ['transcript'],
      makeInput({ transcript_path: transcriptPath })
    );

    expect(ctx.transcript).toBe('Hello this is a transcript');
  });

  it('truncates transcript to 50KB max (keeps last 50KB)', async () => {
    const transcriptPath = join(tmpDir, 'big-transcript.txt');
    expect(transcriptPath).toContain(tmpDir); // Safety
    // Create content larger than 50KB
    const bigContent = 'A'.repeat(60 * 1024); // 60KB
    writeFileSync(transcriptPath, bigContent);

    const ctx = await prefetchContext(
      ['transcript'],
      makeInput({ transcript_path: transcriptPath })
    );

    expect(ctx.transcript).toBeDefined();
    expect(ctx.transcript!.length).toBe(50 * 1024);
    // Should be the LAST 50KB (slice from end)
    expect(ctx.transcript).toBe(bigContent.slice(-50 * 1024));
  });

  it('returns empty context when transcript_path does not exist', async () => {
    const ctx = await prefetchContext(
      ['transcript'],
      makeInput({ transcript_path: join(tmpDir, 'nonexistent.txt') })
    );

    expect(ctx.transcript).toBeUndefined();
  });

  it('git_status runs in cwd and returns output', async () => {
    const gitDir = join(tmpDir, 'repo');
    expect(gitDir).toContain(tmpDir); // Safety

    // Initialize a git repo with a file
    execSync(`mkdir -p "${gitDir}" && cd "${gitDir}" && git init && git config user.email "test@test.com" && git config user.name "Test"`, { encoding: 'utf-8' });
    writeFileSync(join(gitDir, 'hello.txt'), 'hello');
    execSync(`cd "${gitDir}" && git add hello.txt && git commit -m "init"`, { encoding: 'utf-8' });

    // Create an untracked file so git status has output
    writeFileSync(join(gitDir, 'new.txt'), 'new file');

    const ctx = await prefetchContext(
      ['git_status'],
      makeInput({ cwd: gitDir })
    );

    expect(ctx.git_status).toBeDefined();
    expect(ctx.git_status).toContain('new.txt');
  });

  it('git_diff returns output', async () => {
    const gitDir = join(tmpDir, 'repo-diff');
    expect(gitDir).toContain(tmpDir); // Safety

    execSync(`mkdir -p "${gitDir}" && cd "${gitDir}" && git init && git config user.email "test@test.com" && git config user.name "Test"`, { encoding: 'utf-8' });
    writeFileSync(join(gitDir, 'file.txt'), 'original');
    execSync(`cd "${gitDir}" && git add file.txt && git commit -m "init"`, { encoding: 'utf-8' });

    // Modify the tracked file
    writeFileSync(join(gitDir, 'file.txt'), 'modified content');

    const ctx = await prefetchContext(
      ['git_diff'],
      makeInput({ cwd: gitDir })
    );

    expect(ctx.git_diff).toBeDefined();
    expect(ctx.git_diff).toContain('file.txt');
  });

  it('errors on individual keys do not crash the whole prefetch', async () => {
    // Use a non-git directory for git_status (will error), but valid transcript
    const transcriptPath = join(tmpDir, 'transcript.txt');
    expect(transcriptPath).toContain(tmpDir); // Safety
    writeFileSync(transcriptPath, 'valid transcript');

    const nonGitDir = join(tmpDir, 'not-a-repo');
    execSync(`mkdir -p "${nonGitDir}"`);

    const ctx = await prefetchContext(
      ['git_status', 'transcript'],
      makeInput({ cwd: nonGitDir, transcript_path: transcriptPath })
    );

    // git_status should have silently failed
    expect(ctx.git_status).toBeUndefined();
    // transcript should still be fetched
    expect(ctx.transcript).toBe('valid transcript');
  });
});

describe('renderPromptTemplate', () => {
  it('replaces $TRANSCRIPT with context.transcript', () => {
    const result = renderPromptTemplate(
      'Transcript: $TRANSCRIPT',
      makeInput(),
      { transcript: 'Hello world' }
    );
    expect(result).toBe('Transcript: Hello world');
  });

  it('replaces $GIT_STATUS and $GIT_DIFF', () => {
    const result = renderPromptTemplate(
      'Status: $GIT_STATUS\nDiff: $GIT_DIFF',
      makeInput(),
      { git_status: 'M file.ts', git_diff: '1 file changed' }
    );
    expect(result).toBe('Status: M file.ts\nDiff: 1 file changed');
  });

  it('replaces $ARGUMENTS with JSON.stringify of tool_input', () => {
    const input = makeInput({ tool_input: { file_path: '/test', content: 'data' } });
    const result = renderPromptTemplate('Args: $ARGUMENTS', input, {});
    expect(result).toBe('Args: {"file_path":"/test","content":"data"}');
  });

  it('replaces $TOOL_NAME, $PROMPT, $CWD from input', () => {
    const input = makeInput({
      tool_name: 'Write',
      prompt: 'Please write a file',
      cwd: '/home/user/project',
    });
    const result = renderPromptTemplate(
      'Tool: $TOOL_NAME, Prompt: $PROMPT, Dir: $CWD',
      input,
      {}
    );
    expect(result).toBe('Tool: Write, Prompt: Please write a file, Dir: /home/user/project');
  });

  it('handles multiple replacements of the same variable in one template', () => {
    const result = renderPromptTemplate(
      '$CWD is the dir. Working in $CWD',
      makeInput({ cwd: '/test' }),
      {}
    );
    expect(result).toBe('/test is the dir. Working in /test');
  });

  it('missing values become empty strings', () => {
    const result = renderPromptTemplate(
      'T:$TRANSCRIPT S:$GIT_STATUS D:$GIT_DIFF A:$ARGUMENTS N:$TOOL_NAME P:$PROMPT',
      makeInput({ tool_input: undefined, tool_name: undefined, prompt: undefined }),
      {}
    );
    expect(result).toBe('T: S: D: A: N: P:');
  });
});
