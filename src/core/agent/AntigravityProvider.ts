import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findAntigravityCli } from '../antigravity/AntigravityCliResolver';
import { buildProcessEnv, mergePath } from '../settings/env';
import type { AgentEvent, AgentProvider, AgentQuery, ObsigravitySettings } from '../types';

export class AntigravityProvider implements AgentProvider {
  private settings: () => ObsigravitySettings;
  private currentProcess: ChildProcess | null = null;
  private sessionId: string | null = null;

  constructor(settings: () => ObsigravitySettings) {
    this.settings = settings;
  }

  async *query(input: AgentQuery): AsyncGenerator<AgentEvent> {
    const settings = this.settings();
    const env = buildProcessEnv(settings.environmentVariables);
    const agyPath = findAntigravityCli(settings.antigravityCliPath, env.PATH);

    if (!agyPath) {
      yield {
        type: 'error',
        content: 'Antigravity CLI not found. Install Antigravity CLI or set the AGY path in settings.',
      };
      yield { type: 'done' };
      return;
    }

    env.PATH = mergePath(env.PATH, [path.dirname(agyPath)]);
    const prompt = this.buildPrompt(input);
    const runCwd = input.allowWorkspaceAccess ? input.cwd : os.homedir();
    const args = input.allowWorkspaceAccess
      ? ['--add-dir', input.cwd, '--print-timeout', '5m', '--print', prompt]
      : ['--print-timeout', '5m', '--print', prompt];

    if (settings.permissionMode === 'yolo' || settings.permissionMode === 'auto') {
      args.unshift('--dangerously-skip-permissions');
    } else {
      args.unshift('--sandbox');
    }

    yield* this.runProcess(agyPath, args, env, runCwd);
    yield { type: 'done' };
  }

  cancel(): void {
    this.currentProcess?.kill();
    this.currentProcess = null;
  }

  resetSession(): void {
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  setSessionId(id: string | null): void {
    this.sessionId = id;
  }

  private buildPrompt(input: AgentQuery): string {
    const parts: string[] = [];
    parts.push('You are Antigravity CLI running from an Obsidian plugin workflow named Obsigravity.');
    parts.push('Use active note context only when the user asks to analyze, transform, generate from, or otherwise work with the note. For greetings, small talk, or general questions, answer the user directly and briefly without analyzing the active note.');
    parts.push('The active Obsidian note is provided as text context, not as permission to search the vault. Do not grep, list, scan, or recursively inspect the vault unless the user explicitly asks for vault search.');
    parts.push('Be capability-honest: use native Antigravity tools only. Do not fake unsupported video or TTS outputs.');
    parts.push('Lean into Antigravity strengths: agent runtime planning, local file workflow, plugin/extensibility awareness, and clear verification.');

    const preferredModel = this.settings().preferredModel;
    if (preferredModel !== 'default') {
      parts.push(`Preferred Antigravity model: ${preferredModel}. Use this model if the AGY runtime supports model selection in the current session; otherwise continue with the current AGY default.`);
    }

    if (input.activeNotePath && input.activeNoteContent) {
      parts.push(`\n<active_obsidian_note path="${input.activeNotePath}">\n${input.activeNoteContent}\n</active_obsidian_note>`);
    }

    if (input.selectedText) {
      parts.push(`\n<selected_text>\n${input.selectedText}\n</selected_text>`);
    }

    if (input.pinnedNotes && input.pinnedNotes.length > 0) {
      const pinned = input.pinnedNotes
        .map((note) => `<pinned_obsidian_note path="${note.path}">\n${note.content}\n</pinned_obsidian_note>`)
        .join('\n\n---\n\n');
      parts.push(`\n<pinned_context_notes>\n${pinned}\n</pinned_context_notes>`);
    }

    parts.push(`\n<user_request>\n${input.prompt}\n</user_request>`);
    return parts.join('\n\n');
  }

  private async *runProcess(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string
  ): AsyncGenerator<AgentEvent> {
    const child = this.spawnAgy(command, args, env, cwd);
    this.currentProcess = child;

    const queue: AgentEvent[] = [];
    let stdoutBuffer = '';
    let stdoutFull = '';
    let stderrBuffer = '';
    let stderrFull = '';
    let done = false;
    let exitCode: number | null = null;
    const timeout = window.setTimeout(() => {
      queue.push({ type: 'error', content: 'Antigravity CLI timed out after 5 minutes.' });
      child.kill();
    }, 5 * 60 * 1000);

    const stdoutDecoder = new TextDecoder('utf-8');
    const stderrDecoder = new TextDecoder('utf-8');

    child.stdout!.on('data', (chunk: Buffer) => {
      const text = stdoutDecoder.decode(chunk, { stream: true });
      stdoutFull += text;
      stdoutBuffer += text;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const progress = this.formatProgressLine(line);
        if (progress) queue.push({ type: 'progress', content: progress });
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      const text = stderrDecoder.decode(chunk, { stream: true });
      stderrFull += text;
      stderrBuffer += text;
    });
    child.on('error', (error) => {
      queue.push({ type: 'error', content: error.message });
      done = true;
    });
    child.on('close', (code) => {
      stdoutFull += stdoutDecoder.decode();
      stderrFull += stderrDecoder.decode();
      exitCode = code;
      window.clearTimeout(timeout);
      if (code && code !== 0) {
        const details = stderrFull.trim() ? `\n\n${this.cleanOutput(stderrFull).trim()}` : '';
        queue.push({ type: 'error', content: `Antigravity CLI exited with code ${code}.${details}` });
      }
      done = true;
    });

    while (!done || queue.length > 0) {
      const event = queue.shift();
      if (event) {
        yield event;
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 40));
      }
    }

    if (exitCode === 0) {
      const finalText = this.cleanFinalText(stdoutFull, stderrFull);
      if (finalText) yield { type: 'text', content: finalText };
    }

    this.currentProcess = null;
  }

  private formatProgressLine(line: string): string {
    const cleaned = this.cleanOutput(line).trim();
    if (!cleaned) return '';
    if (/^(generating|creating|copying|writing|verifying|saved|status=|output=|evidence=)/i.test(cleaned)) {
      return cleaned.slice(0, 240);
    }
    if (/^(•|-|\*) /i.test(cleaned)) return cleaned.slice(0, 240);
    return '';
  }

  private cleanFinalText(stdout: string, stderr: string): string {
    const cleanedStdout = this.cleanOutput(stdout).trim();
    const cleanedStderr = this.cleanOutput(stderr)
      .split(/\r?\n/)
      .filter((line) => !/^\d{4}-\d{2}-\d{2}T.*\bWARN\b/.test(line.trim()))
      .join('\n')
      .trim();

    return [cleanedStdout, cleanedStderr].filter(Boolean).join('\n\n').trim();
  }

  private cleanOutput(text: string): string {
    return text
      .replace(/\][^]*/g, '')
      .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/[A-PR-Z\_]/g, '');
  }

  private spawnAgy(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
    if (process.platform !== 'win32') {
      return spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    }

    // Windows: agy --print silently drops stdout when not attached to a TTY
    // (upstream bug google-antigravity/antigravity-cli#76). Wrap with
    // conhost.exe --headless so AGY runs inside a real pseudo-console; the
    // TUI escape sequences it emits are stripped later in cleanOutput().
    // stdin MUST be a pipe (not 'ignore'): when stdin is mapped to NUL,
    // conhost --headless exits ~immediately and AGY produces no output.
    const conhost = this.findConhost();
    const lower = command.toLowerCase();
    let target = command;
    let targetArgs = args;
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const exeSibling = command.replace(/\.(cmd|bat)$/i, '.exe');
      try {
        if (fs.existsSync(exeSibling) && fs.statSync(exeSibling).isFile()) {
          target = exeSibling;
        } else {
          target = 'cmd.exe';
          targetArgs = ['/d', '/s', '/c', command, ...args];
        }
      } catch {
        target = 'cmd.exe';
        targetArgs = ['/d', '/s', '/c', command, ...args];
      }
    }

    if (conhost) {
      // Leave stdin OPEN until AGY exits. conhost --headless tears down the
      // ConPTY as soon as stdin closes, which makes AGY exit instantly with
      // no model output. We never write to stdin; we just keep the pipe alive.
      return spawn(conhost, ['--headless', '--', target, ...targetArgs], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    }

    if (target.toLowerCase().endsWith('.exe')) {
      return spawn(target, targetArgs, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    }
    return spawn(target, targetArgs, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });
  }

  private findConhost(): string | null {
    const candidates = [
      process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'conhost.exe') : '',
      'C:\\Windows\\System32\\conhost.exe',
      'C:\\WINDOWS\\System32\\conhost.exe',
    ].filter(Boolean);
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Try next candidate.
      }
    }
    return null;
  }
}
