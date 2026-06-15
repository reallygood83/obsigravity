import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findExternalCli, type ExternalCliId } from './ExternalCliResolver';
import { buildProcessEnv, mergePath } from '../settings/env';
import type { ObsigravitySettings, PermissionMode, PreferredModel } from '../types';

export interface ExternalCliRunInput {
  id: ExternalCliId;
  prompt: string;
  cwd: string;
  settings: ObsigravitySettings;
  timeoutMs?: number;
  alwaysApprove?: boolean;
  permissionModeOverride?: PermissionMode;
  activeNotePath?: string;
  activeNoteContent?: string;
  selectedText?: string;
  pinnedNotes?: Array<{ path: string; content: string }>;
}

export interface ExternalCliRunResult {
  id: ExternalCliId;
  command: string;
  output: string;
}

export async function runExternalCli(input: ExternalCliRunInput): Promise<ExternalCliRunResult> {
  const env = buildProcessEnv(input.settings.environmentVariables);
  const command = findExternalCli(input.id, input.settings.externalCliPaths[input.id], env.PATH);
  if (!command) {
    throw new Error(`${input.id} CLI was not detected. Open Obsigravity settings and run Auto-detect all.`);
  }

  env.PATH = mergePath(env.PATH, [path.dirname(command)]);
  const prompt = buildExternalPrompt(input);
  const shouldAlwaysApprove = input.alwaysApprove || (input.id === 'grok' && isFreshSearchRequest(input.prompt));
  const invocation = buildInvocation(
    input.id,
    input.permissionModeOverride || input.settings.permissionMode,
    input.settings.preferredModel,
    input.cwd,
    prompt,
    shouldAlwaysApprove
  );
  let output = '';
  try {
    output = await runProcess(command, invocation.args, env, input.cwd, invocation.stdin, input.timeoutMs);
  } finally {
    invocation.cleanup?.();
  }
  return {
    id: input.id,
    command: `${path.basename(command)} ${invocation.args.map(shellDisplay).join(' ')}`,
    output: output.trim() || '(no output)',
  };
}

function buildInvocation(
  id: ExternalCliId,
  permissionMode: PermissionMode,
  preferredModel: PreferredModel,
  cwd: string,
  prompt: string,
  alwaysApprove = false
): { args: string[]; stdin?: string; cleanup?: () => void } {
  if (id === 'claude') {
    const args = ['--print', '--output-format', 'text', '--permission-mode', claudePermissionMode(permissionMode)];
    const model = claudeModel(preferredModel);
    if (model) args.push('--model', model);
    return { args, stdin: prompt };
  }

  if (id === 'codex') {
    const args = ['exec', '-C', cwd, '--skip-git-repo-check', '--color', 'never', '-s', codexSandbox(permissionMode)];
    const model = codexModel(preferredModel);
    if (model) args.push('-m', model);
    args.push('-');
    return { args, stdin: prompt };
  }

  const promptFile = path.join(getExternalCliRunDirectory(), `grok-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');
  const args = ['--cwd', cwd, '--prompt-file', promptFile, '--output-format', 'plain', '--permission-mode', grokPermissionMode(permissionMode)];
  if (alwaysApprove) args.push('--always-approve');
  const model = grokModel(preferredModel);
  if (model) args.push('--model', model);
  return {
    args,
    cleanup: () => {
      try {
        fs.rmSync(promptFile, { force: true });
      } catch {
        // Best-effort cleanup only.
      }
    },
  };
}

function buildExternalPrompt(input: ExternalCliRunInput): string {
  const parts = [
    'You are being called from the Obsigravity Obsidian plugin as a collaborating local CLI agent.',
    'Answer the user directly. Use the active note context only when it is relevant.',
    'The active Obsidian note is provided as text context, not as permission to list, grep, scan, or recursively inspect the vault. Do not inspect local vault files unless the user explicitly asks for vault search or file operations.',
  ];

  if (input.id === 'grok' && isFreshSearchRequest(input.prompt)) {
    parts.push(
      'This request needs fresh external search.',
      'Use Grok web search or web fetch capabilities for current public information. For X/Twitter requests, search public X/Twitter/web results and include handles, dates, and source URLs when available.',
      'If native X search is unavailable in this Grok CLI session, say so plainly and use web search constrained to public x.com/twitter.com results instead.',
      'Do not use local filesystem tools to satisfy external search requests. The active note may only be used to derive the search query.'
    );
  }

  parts.push('', `User request:\n${input.prompt}`);

  if (input.selectedText) {
    parts.push('', `Selected text from the active note:\n${input.selectedText}`);
  }

  if (input.activeNotePath && input.activeNoteContent) {
    parts.push('', `Active note path: ${input.activeNotePath}`, 'Active note content:', input.activeNoteContent);
  }

  if (input.pinnedNotes?.length) {
    parts.push('', 'Pinned notes:');
    for (const note of input.pinnedNotes) {
      parts.push('', `--- ${note.path} ---`, note.content);
    }
  }

  return parts.join('\n');
}

function isFreshSearchRequest(prompt: string): boolean {
  return /(?:\bsearch\b|\bweb\b|\blatest\b|\brecent\b|\bnews\b|\btweet\w*\b|\btwitter\b|\bx\.com\b|검색|최신|최근|뉴스|트윗|트위터|엑스|X에서|x에서)/i.test(prompt);
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, stdin?: string, timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: stdin ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: false,
    });

    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');

    const timeout = globalThis.setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${path.basename(command)} timed out after ${Math.round(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += stdoutDecoder.decode(chunk, { stream: true });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += stderrDecoder.decode(chunk, { stream: true });
    });
    child.on('error', (error) => {
      globalThis.clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      stdout += stdoutDecoder.decode();
      stderr += stderrDecoder.decode();
      globalThis.clearTimeout(timeout);
      if (code && code !== 0) {
        reject(new Error(`${path.basename(command)} exited with code ${code}\n${stderr || stdout}`.trim()));
        return;
      }
      resolve(stdout || stderr);
    });
    if (stdin) {
      child.stdin?.write(stdin);
      child.stdin?.end();
    }
  });
}

function claudePermissionMode(mode: PermissionMode): string {
  if (mode === 'yolo') return 'bypassPermissions';
  if (mode === 'auto') return 'auto';
  return 'default';
}

function codexSandbox(mode: PermissionMode): string {
  if (mode === 'yolo') return 'danger-full-access';
  if (mode === 'auto') return 'workspace-write';
  return 'read-only';
}

function grokPermissionMode(mode: PermissionMode): string {
  if (mode === 'yolo') return 'bypassPermissions';
  if (mode === 'auto') return 'auto';
  return 'default';
}

function claudeModel(model: PreferredModel): string | null {
  if (model === 'claude-sonnet-4.6-thinking') return 'sonnet';
  if (model === 'claude-opus-4.6-thinking') return 'opus';
  return null;
}

function codexModel(model: PreferredModel): string | null {
  if (model === 'gpt-oss-120b') return 'gpt-oss-120b';
  return null;
}

function grokModel(_model: PreferredModel): string | null {
  return null;
}

function shellDisplay(value: string): string {
  if (!/[\s"'\\]/.test(value)) return value;
  const shortened = value.length > 80 ? `${value.slice(0, 77)}...` : value;
  return JSON.stringify(shortened);
}

export function getExternalCliRunDirectory(): string {
  const dir = path.join(os.tmpdir(), 'obsigravity-cli-runs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
