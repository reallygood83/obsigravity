import { ItemView, MarkdownRenderer, Notice, normalizePath, setIcon, TFile, type WorkspaceLeaf } from 'obsidian';

import ObsigravityPlugin, { OBSIGRAVITY_ICON } from '../main';
import { runExternalCli } from '../core/cli/ExternalCliRunner';
import type { ExternalCliId } from '../core/cli/ExternalCliResolver';
import { BUILTIN_SKILLS, getBuiltinSkillBySlash, type BuiltinSkill } from '../core/skills/BuiltinSkills';
import type { ConversationMessage, ConversationSession, PermissionMode, PreferredModel } from '../core/types';

export const VIEW_TYPE_OBSIGRAVITY = 'obsigravity-view';

interface SlashCommand {
  name: string;
  hint: string;
  description: string;
}

const ANTIGRAVITY_SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', hint: 'Show Antigravity help', description: 'Ask Antigravity CLI for available commands and usage.' },
  { name: '/status', hint: 'Show agent status', description: 'Ask Antigravity to summarize workspace, permissions, and active note context.' },
  { name: '/model', hint: 'Model selector', description: 'Open or request the Antigravity model selector.' },
  { name: '/skills', hint: 'Browse skills', description: 'Browse local and imported Antigravity skills.' },
  { name: '/mcp', hint: 'MCP manager', description: 'Open or request Antigravity MCP configuration.' },
  { name: '/agents', hint: 'Subagents', description: 'Open or request Antigravity subagent controls.' },
  { name: '/permissions', hint: 'Permissions', description: 'Select or inspect Antigravity autonomy level.' },
  { name: '/config', hint: 'Settings', description: 'Open or inspect Antigravity CLI settings.' },
  { name: '/probe', hint: 'Probe media support', description: 'Check native image, video, and TTS capability honesty.' },
  { name: '/image', hint: 'Generate image', description: 'Generate an Antigravity-native image from the active note.' },
  { name: '/grok-video', hint: 'Generate video', description: 'Generate a Grok Build MP4 from the active note and embed it.' },
  { name: '/sukgo', hint: 'Decision thinking', description: 'Run sukgo-style decision frameworks on the active note.' },
  { name: '/diff', hint: 'Review vault changes', description: 'Ask Antigravity to summarize local file changes.' },
  { name: '/claude', hint: 'Claude Code CLI', description: 'Send the request to the local Claude Code CLI with note context.' },
  { name: '/codex', hint: 'Codex CLI', description: 'Send the request to the local Codex CLI with note context.' },
  { name: '/grok', hint: 'Grok Build CLI', description: 'Send the request to the local Grok Build CLI with note context.' },
  { name: '/collab', hint: 'Multi-model panel', description: 'Ask Claude, Codex, and Grok in parallel and compare their answers.' },
];

const BUILTIN_SKILL_SLASH_COMMANDS: SlashCommand[] = BUILTIN_SKILLS.map((skill) => ({
  name: skill.slash,
  hint: skill.hint,
  description: skill.description,
}));

export class ObsigravityView extends ItemView {
  private plugin: ObsigravityPlugin;
  private messagesEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private fileIndicatorEl: HTMLElement | null = null;
  private selectionIndicatorEl: HTMLElement | null = null;
  private slashDropdownEl: HTMLElement | null = null;
  private historyMenuEl: HTMLElement | null = null;
  private welcomeEl: HTMLElement | null = null;
  private messages: ConversationMessage[] = [];
  private discoveredSlashCommands: SlashCommand[] = [];
  private currentConversationId: string | null = null;
  private isRunning = false;
  private isComposingInput = false;
  private selectedSlashCommandIndex = 0;

  constructor(leaf: WorkspaceLeaf, plugin: ObsigravityPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_OBSIGRAVITY;
  }

  getDisplayText(): string {
    return 'Obsigravity';
  }

  getIcon(): string {
    return OBSIGRAVITY_ICON;
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('oc-container');

    const header = container.createDiv({ cls: 'oc-header' });
    this.buildHeader(header);

    this.messagesEl = container.createDiv({ cls: 'oc-messages' });
    this.restoreActiveConversation();

    const inputContainerEl = container.createDiv({ cls: 'oc-input-container' });
    this.buildInputArea(inputContainerEl);

    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderFileChips()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.renderFileChips()));
    this.registerDomEvent(document, 'click', () => this.hideHistoryMenu());
    this.renderFileChips();
    this.refreshDiscoveredSlashCommands();
  }

  async onClose(): Promise<void> {
    this.plugin.agent.cancel();
  }

  refreshContextChips(): void {
    this.renderFileChips();
  }

  private buildHeader(header: HTMLElement): void {
    const titleContainer = header.createDiv({ cls: 'oc-title' });
    const logoEl = titleContainer.createSpan({ cls: 'oc-logo' });
    setIcon(logoEl, OBSIGRAVITY_ICON);
    titleContainer.createEl('h4', { text: 'Obsigravity' });

    const headerActions = header.createDiv({ cls: 'oc-header-actions' });

    const historyContainer = headerActions.createDiv({ cls: 'oc-history-container' });
    const historyBtn = historyContainer.createDiv({ cls: 'oc-header-btn' });
    setIcon(historyBtn, 'history');
    historyBtn.setAttribute('aria-label', 'Show conversation history');
    historyBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleHistoryMenu();
    });
    this.historyMenuEl = historyContainer.createDiv({ cls: 'oc-history-menu' });
    this.historyMenuEl.addEventListener('click', (event) => event.stopPropagation());
    this.renderHistoryMenu();

    const visualBtn = headerActions.createDiv({ cls: 'oc-header-btn' });
    setIcon(visualBtn, 'image');
    visualBtn.setAttribute('aria-label', 'Generate Obsigravity image from note');
    visualBtn.addEventListener('click', () => void this.plugin.generateImageFromActiveNote());

    const videoBtn = headerActions.createDiv({ cls: 'oc-header-btn' });
    setIcon(videoBtn, 'video');
    videoBtn.setAttribute('aria-label', 'Generate Grok video from note');
    videoBtn.addEventListener('click', () => void this.plugin.generateGrokVideoFromActiveNote());

    const newBtn = headerActions.createDiv({ cls: 'oc-header-btn' });
    setIcon(newBtn, 'plus');
    newBtn.setAttribute('aria-label', 'New conversation');
    newBtn.addEventListener('click', () => this.createNewConversation());
  }

  private buildInputArea(inputContainerEl: HTMLElement): void {
    const inputWrapper = inputContainerEl.createDiv({ cls: 'oc-input-wrapper' });

    this.selectionIndicatorEl = inputWrapper.createDiv({ cls: 'oc-selection-indicator' });
    this.selectionIndicatorEl.style.display = 'none';

    this.fileIndicatorEl = inputWrapper.createDiv({ cls: 'oc-file-indicator' });

    this.inputEl = inputWrapper.createEl('textarea', {
      cls: 'oc-input',
      attr: {
        placeholder: 'Ask Antigravity about this vault...',
        rows: '3',
      },
    });
    this.inputEl.addEventListener('keydown', (event) => {
      if (this.handleSlashKeydown(event)) return;
      if (this.isComposingInput || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void this.submit();
      }
    });
    this.inputEl.addEventListener('compositionstart', () => {
      this.isComposingInput = true;
    });
    this.inputEl.addEventListener('compositionend', () => {
      window.setTimeout(() => {
        this.isComposingInput = false;
      }, 0);
    });
    this.inputEl.addEventListener('input', () => {
      this.autoResizeInput();
      this.renderSlashCommands();
    });
    this.inputEl.addEventListener('blur', () => {
      window.setTimeout(() => this.hideSlashCommands(), 120);
    });

    this.slashDropdownEl = inputWrapper.createDiv({ cls: 'oc-slash-dropdown' });
    this.slashDropdownEl.addEventListener('wheel', (event) => event.stopPropagation());

    const toolbar = inputWrapper.createDiv({ cls: 'oc-input-toolbar' });
    this.buildModelSelector(toolbar);
    this.buildPermissionToggle(toolbar);

    const sendBtn = toolbar.createDiv({ cls: 'oc-header-btn oc-send-btn', attr: { 'aria-label': 'Send message' } });
    setIcon(sendBtn, 'send');
    sendBtn.addEventListener('click', () => void this.submit());
  }

  private buildModelSelector(parent: HTMLElement): void {
    const selector = parent.createDiv({ cls: 'oc-model-selector' });
    const button = selector.createDiv({ cls: 'oc-model-btn' });
    const label = button.createSpan({ cls: 'oc-model-label', text: this.modelLabel(this.plugin.settings.preferredModel) });

    const dropdown = selector.createDiv({ cls: 'oc-model-dropdown' });
    const models: Array<{ value: PreferredModel; label: string; desc: string }> = [
      { value: 'default', label: 'Default', desc: 'Use AGY current default' },
      { value: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro High', desc: 'Highest Gemini reasoning' },
      { value: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro Low', desc: 'Lower-latency Gemini Pro' },
      { value: 'gemini-3-flash', label: 'Gemini 3 Flash', desc: 'Fast general work' },
      { value: 'claude-sonnet-4.6-thinking', label: 'Claude Sonnet 4.6', desc: 'Thinking model' },
      { value: 'claude-opus-4.6-thinking', label: 'Claude Opus 4.6', desc: 'Thinking model' },
      { value: 'gpt-oss-120b', label: 'GPT-OSS-120b', desc: 'Open model lane' },
    ];

    for (const model of models) {
      const option = dropdown.createDiv({ cls: 'oc-model-option' });
      if (model.value === this.plugin.settings.preferredModel) option.addClass('selected');
      option.createSpan({ text: model.label });
      option.createDiv({ cls: 'oc-model-desc', text: model.desc });
      option.addEventListener('click', async () => {
        this.plugin.settings.preferredModel = model.value;
        await this.plugin.saveSettings();
        label.setText(model.label);
        for (const item of Array.from(dropdown.children)) item.removeClass('selected');
        option.addClass('selected');
      });
    }
  }

  private modelLabel(model: PreferredModel): string {
    const labels: Record<PreferredModel, string> = {
      default: 'Default',
      'gemini-3.1-pro-high': 'Gemini 3.1 Pro High',
      'gemini-3.1-pro-low': 'Gemini 3.1 Pro Low',
      'gemini-3-flash': 'Gemini 3 Flash',
      'claude-sonnet-4.6-thinking': 'Claude Sonnet 4.6',
      'claude-opus-4.6-thinking': 'Claude Opus 4.6',
      'gpt-oss-120b': 'GPT-OSS-120b',
    };
    return labels[model];
  }

  private buildPermissionToggle(parent: HTMLElement): void {
    const toggle = parent.createDiv({ cls: 'oc-permission-toggle' });
    const label = toggle.createSpan({ cls: 'oc-permission-label' });
    const switchEl = toggle.createDiv({ cls: 'oc-toggle-switch' });
    this.updatePermissionToggle(label, switchEl);
    toggle.addEventListener('click', async () => {
      this.plugin.settings.permissionMode = this.nextPermissionMode(this.plugin.settings.permissionMode);
      await this.plugin.saveSettings();
      this.updatePermissionToggle(label, switchEl);
    });
  }

  private updatePermissionToggle(label: HTMLElement, switchEl: HTMLElement): void {
    const mode = this.plugin.settings.permissionMode;
    switchEl.toggleClass('active', mode === 'auto' || mode === 'yolo');
    label.setText(mode === 'review' ? 'Safe' : mode === 'auto' ? 'AUTO' : 'Yolo');
  }

  private nextPermissionMode(mode: PermissionMode): PermissionMode {
    if (mode === 'review') return 'auto';
    if (mode === 'auto') return 'yolo';
    return 'review';
  }

  private renderWelcome(): void {
    if (!this.welcomeEl) return;
    this.welcomeEl.empty();
    this.welcomeEl.createDiv({ cls: 'oc-welcome-greeting', text: 'How can I help you today?' });
  }

  private renderFileChips(): void {
    if (!this.fileIndicatorEl) return;
    this.fileIndicatorEl.empty();

    const activeFile = this.plugin.getActiveMarkdownFile();
    if (activeFile && !this.plugin.isNoteExcluded(activeFile.path)) {
      this.createFileChip(activeFile.path, {
        current: this.plugin.settings.autoIncludeActiveNote,
        pinned: this.plugin.isNotePinned(activeFile.path),
      });
    }

    for (const pinnedPath of this.plugin.settings.pinnedNotePaths) {
      if (pinnedPath === activeFile?.path) continue;
      if (this.plugin.isNoteExcluded(pinnedPath)) continue;
      this.createFileChip(pinnedPath, { pinned: true });
    }

    const hasChips = this.fileIndicatorEl.children.length > 0;
    this.fileIndicatorEl.style.display = hasChips ? 'flex' : 'none';
  }

  private createFileChip(filePath: string, options: { current?: boolean; pinned?: boolean }): void {
    if (!this.fileIndicatorEl) return;
    const chip = this.fileIndicatorEl.createDiv({ cls: 'oc-file-chip' });
    if (options.pinned) {
      chip.addClass('oc-file-chip-pinned');
    } else if (options.current) {
      chip.addClass('oc-file-chip-current');
    } else {
      chip.addClass('oc-file-chip-attached');
    }

    const icon = chip.createSpan({ cls: 'oc-file-chip-icon' });
    setIcon(icon, 'file-text');
    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const name = chip.createSpan({ cls: 'oc-file-chip-name', text: filename });
    name.setAttribute('title', options.current ? `Current: ${filePath}` : filePath);

    const pin = chip.createSpan({ cls: 'oc-file-chip-pin' });
    setIcon(pin, options.pinned ? 'pin-off' : 'pin');
    pin.setAttribute('aria-label', options.pinned ? 'Unpin note' : 'Pin note');
    pin.setAttribute('title', options.pinned ? 'Pinned - click to unpin' : 'Click to pin this note');
    pin.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (this.plugin.isNotePinned(filePath)) await this.plugin.unpinNote(filePath);
      else await this.plugin.pinNote(filePath);
      this.renderFileChips();
    });

    const remove = chip.createSpan({ cls: 'oc-file-chip-remove' });
    setIcon(remove, 'x');
    remove.setAttribute('aria-label', 'Remove note from Obsigravity context');
    remove.setAttribute('title', 'Remove this note from the chat context');
    remove.addEventListener('click', async (event) => {
      event.stopPropagation();
      await this.plugin.excludeNote(filePath);
      this.renderFileChips();
    });

    chip.addEventListener('click', () => void this.openNote(filePath));
  }

  private async openNote(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!file || !('extension' in file)) return;
    await this.app.workspace.getLeaf(false).openFile(file as TFile);
  }

  private async openRenderedLink(rawTarget: string, label: string): Promise<boolean> {
    const target = this.normalizeRenderedLinkTarget(rawTarget, label);
    if (!target) return false;

    if (/^(https?:\/\/|mailto:|obsidian:\/\/)/i.test(target)) {
      window.open(target, '_blank', 'noopener');
      return true;
    }

    const activePath = this.plugin.getActiveMarkdownFile()?.path || '';
    const notePath = this.stripHeadingOrBlock(target);
    const exactFile = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
    if (exactFile instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(exactFile);
      return true;
    }

    const linkText = target.replace(/^\[\[|\]\]$/g, '');
    const resolved = this.app.metadataCache.getFirstLinkpathDest(this.stripHeadingOrBlock(linkText).replace(/\.md$/i, ''), activePath);
    if (resolved) {
      await this.app.workspace.openLinkText(linkText, activePath, false);
      return true;
    }

    if (target.endsWith('.md') || target.includes('/')) {
      new Notice(`Obsigravity could not find note: ${target}`);
      return true;
    }

    return false;
  }

  private normalizeRenderedLinkTarget(rawTarget: string, label: string): string {
    const raw = (rawTarget || label || '').trim();
    if (!raw) return '';
    try {
      return decodeURI(raw);
    } catch {
      return raw;
    }
  }

  private stripHeadingOrBlock(target: string): string {
    return target.split('#')[0].split('^')[0].split('?')[0].replace(/^\/+/, '');
  }

  private createNewConversation(): void {
    this.plugin.agent.cancel();
    this.plugin.agent.resetSession();
    this.messages = [];
    this.currentConversationId = null;
    this.plugin.settings.activeConversationId = null;
    void this.plugin.saveSettings();
    this.messagesEl?.empty();
    this.welcomeEl = this.messagesEl?.createDiv({ cls: 'oc-welcome' }) || null;
    this.renderWelcome();
    this.renderHistoryMenu();
  }

  private reopen(): void {
    const leaf = this.leaf;
    void leaf.setViewState({ type: VIEW_TYPE_OBSIGRAVITY, active: true });
  }

  private autoResizeInput(): void {
    if (!this.inputEl) return;
    this.inputEl.style.height = 'auto';
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 200)}px`;
  }

  private handleSlashKeydown(event: KeyboardEvent): boolean {
    if (!this.slashDropdownEl?.hasClass('visible')) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedSlashCommandIndex = Math.min(this.selectedSlashCommandIndex + 1, this.getFilteredSlashCommands().length - 1);
      this.renderSlashCommands();
      return true;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedSlashCommandIndex = Math.max(this.selectedSlashCommandIndex - 1, 0);
      this.renderSlashCommands();
      return true;
    }

    if (event.key === 'Tab' || event.key === 'Enter') {
      const command = this.getFilteredSlashCommands()[this.selectedSlashCommandIndex];
      if (command) {
        event.preventDefault();
        this.insertSlashCommand(command.name);
        return true;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.hideSlashCommands();
      return true;
    }

    return false;
  }

  private getSlashQuery(): string | null {
    if (!this.inputEl) return null;
    const value = this.inputEl.value;
    const cursor = this.inputEl.selectionStart ?? value.length;
    const beforeCursor = value.slice(0, cursor);
    if (!beforeCursor.startsWith('/')) return null;
    if (beforeCursor.includes('\n')) return null;
    if (beforeCursor.includes(' ')) return null;
    return beforeCursor.toLowerCase();
  }

  private getAllSlashCommands(): SlashCommand[] {
    const commands = new Map<string, SlashCommand>();
    for (const command of BUILTIN_SKILL_SLASH_COMMANDS) commands.set(command.name, command);
    for (const command of ANTIGRAVITY_SLASH_COMMANDS) commands.set(command.name, command);
    for (const command of this.discoveredSlashCommands) {
      if (!commands.has(command.name)) commands.set(command.name, command);
    }
    return [...commands.values()];
  }

  refreshDiscoveredSlashCommands(): void {
    const tools = this.plugin.getClaudeTools();
    this.discoveredSlashCommands = tools.map((tool) => ({
      name: `/${tool.name}`,
      hint: tool.kind === 'command' ? 'Claude command' : 'Claude skill',
      description: `${tool.description} (${tool.kind})`,
    }));
  }

  private getFilteredSlashCommands(): SlashCommand[] {
    const query = this.getSlashQuery();
    if (query === null) return [];
    return this.getAllSlashCommands().filter((command) => command.name.startsWith(query));
  }

  private renderSlashCommands(): void {
    if (!this.slashDropdownEl) return;
    const commands = this.getFilteredSlashCommands();
    this.slashDropdownEl.empty();

    if (commands.length === 0) {
      this.hideSlashCommands();
      return;
    }

    this.selectedSlashCommandIndex = Math.min(this.selectedSlashCommandIndex, commands.length - 1);
    this.slashDropdownEl.addClass('visible');

    for (const [index, command] of commands.entries()) {
      const item = this.slashDropdownEl.createDiv({ cls: 'oc-slash-item' });
      if (index === this.selectedSlashCommandIndex) {
        item.addClass('selected');
        window.requestAnimationFrame(() => item.scrollIntoView({ block: 'nearest' }));
      }
      item.createSpan({ cls: 'oc-slash-name', text: command.name });
      item.createSpan({ cls: 'oc-slash-hint', text: command.hint });
      item.createDiv({ cls: 'oc-slash-desc', text: command.description });
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        this.insertSlashCommand(command.name);
      });
    }
  }

  private insertSlashCommand(command: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = `${command} `;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(this.inputEl.value.length, this.inputEl.value.length);
    this.autoResizeInput();
    this.hideSlashCommands();
  }

  private hideSlashCommands(): void {
    this.slashDropdownEl?.removeClass('visible');
    this.selectedSlashCommandIndex = 0;
  }

  private async submit(): Promise<void> {
    if (!this.inputEl || this.isRunning) return;
    const prompt = this.inputEl.value.trim();
    if (!prompt) return;

    this.inputEl.value = '';
    this.autoResizeInput();

    if (this.handleCasualPrompt(prompt)) return;
    if (await this.handleLocalSlashCommand(prompt)) return;

    this.isRunning = true;
    this.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });

    try {
      const context = await this.plugin.getActiveNoteContext();
      let assistantBuffer = '';
      const assistantEl = this.createMessageEl('assistant');
      const progressEl = this.createProgressTimeline(assistantEl);
      const progressListEl = progressEl.querySelector('.oc-progress-list') as HTMLElement;
      this.appendProgressStep(progressListEl, 'Antigravity process started');
      const contentEl = assistantEl.createDiv({ cls: 'oc-message-content' });

      for await (const event of this.plugin.agent.query({
        prompt,
        cwd: this.plugin.getVaultPath(),
        activeNotePath: context?.path,
        activeNoteContent: context?.content,
        selectedText: context?.selection,
        pinnedNotes: context?.pinnedNotes,
      })) {
        if (event.type === 'text') {
          assistantBuffer += event.content;
          progressEl.addClass('is-complete');
          this.appendProgressStep(progressListEl, 'Final response received');
          await this.renderMarkdown(assistantBuffer, contentEl);
        } else if (event.type === 'progress') {
          this.appendProgressStep(progressListEl, event.content);
        } else if (event.type === 'error') {
          progressEl.addClass('is-error');
          this.appendProgressStep(progressListEl, `Error: ${event.content}`);
          this.appendMessage({ role: 'error', content: event.content, timestamp: Date.now() });
        }
      }

      progressEl.addClass('is-complete');

      if (assistantBuffer.trim()) {
        this.messages.push({ role: 'assistant', content: assistantBuffer, timestamp: Date.now() });
        this.saveCurrentConversation();
        this.renderHistoryMenu();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(message);
      this.appendMessage({ role: 'error', content: message, timestamp: Date.now() });
    } finally {
      this.isRunning = false;
    }
  }

  private handleCasualPrompt(prompt: string): boolean {
    const normalized = prompt
      .trim()
      .toLowerCase()
      .replace(/[!！?.。~～\s]+$/g, '');
    const casualResponses: Record<string, string> = {
      안녕: '안녕하세요! 무엇을 도와드릴까요?',
      하이: '하이! 무엇을 해볼까요?',
      hello: 'Hello! What would you like to work on?',
      hi: 'Hi! What would you like to do?',
      hey: 'Hey! What can I help with?',
    };
    const response = casualResponses[normalized];
    if (!response) return false;

    this.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
    this.appendMessage({ role: 'assistant', content: response, timestamp: Date.now() });
    return true;
  }

  private async handleLocalSlashCommand(prompt: string): Promise<boolean> {
    if (prompt === '/skills') {
      this.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
      const tools = this.plugin.getClaudeTools();
      const commands = tools.filter((tool) => tool.kind === 'command').slice(0, 40);
      const skills = tools.filter((tool) => tool.kind === 'skill').slice(0, 40);
      const lines = [
        `Found ${BUILTIN_SKILLS.length} built-in Obsigravity skills and ${tools.length} local Claude tools.`,
        '',
        '## Built-in Obsigravity skills',
        BUILTIN_SKILLS.map((skill) => `- \`${skill.slash}\` - ${skill.description}`).join('\n'),
        '',
        '## Claude commands',
        commands.length ? commands.map((tool) => `- \`/${tool.name}\` - ${tool.description}`).join('\n') : '- None detected',
        '',
        '## Claude skills',
        skills.length ? skills.map((tool) => `- \`/${tool.name}\` - ${tool.description}`).join('\n') : '- None detected',
        '',
        'Built-in skills run directly through Obsigravity with active-note context. Claude tools are shown in the slash picker when discovered locally.',
      ];
      this.appendMessage({ role: 'assistant', content: lines.join('\n'), timestamp: Date.now() });
      return true;
    }

    if (prompt === '/help') {
      this.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
      this.appendMessage({
        role: 'assistant',
        content: [
          'Obsigravity slash commands:',
          '',
          '- `/note-surgeon <optional direction>` cleans and restructures the active note.',
          '- `/atomic-split <optional direction>` splits the active note into linked atomic notes.',
          '- `/vault-cartographer <optional scope>` maps the active note neighborhood or selected folder.',
          '- `/skill-forge <workflow idea>` designs a reusable Obsidian-native slash skill.',
          '- `/sukgo <framework or question>` applies sukgo-style decision frameworks to the active note.',
          '- `/skills` lists local Claude commands and skills.',
          '- `/image` starts image-generation prompting from the active note.',
          '- `/grok-video <direction>` asks Grok Build to generate and embed an MP4 from the active note.',
          '- `/model` shows model preference guidance.',
          '- `/claude <task>` runs local Claude Code CLI.',
          '- `/codex <task>` runs local Codex CLI.',
          '- `/grok <task>` runs local Grok Build CLI.',
          '- `/collab <task>` asks Claude, Codex, and Grok in parallel.',
          '',
          'You can also type normal text and press Enter to send it to Antigravity.',
        ].join('\n'),
        timestamp: Date.now(),
      });
      return true;
    }

    if (prompt === '/model') {
      this.appendMessage({ role: 'user', content: prompt, timestamp: Date.now() });
      this.appendMessage({
        role: 'assistant',
        content: `Current model preference: \`${this.plugin.settings.preferredModel}\`.\n\nUse the model selector in the input toolbar or settings to change it.`,
        timestamp: Date.now(),
      });
      return true;
    }

    const builtin = getBuiltinSkillBySlash(prompt);
    if (builtin) {
      await this.runBuiltinSkill(builtin.skill, builtin.request, prompt);
      return true;
    }

    const videoMatch = prompt.match(/^\/grok-video(?:\s+([\s\S]+))?$/);
    if (videoMatch) {
      await this.plugin.generateGrokVideoFromActiveNote((videoMatch[1] || '').trim());
      return true;
    }

    const external = this.parseExternalSlashCommand(prompt);
    if (external) {
      await this.runExternalSlashCommand(external.ids, external.request, prompt);
      return true;
    }

    return false;
  }

  /**
   * Public for Vault Pulse and other same-author integrations.
   * @param forcedNotePath When set, use this note as context instead of whatever leaf is active
   *   (avoids race where Obsigravity sidebar steals focus / wrong last-active file).
   */
  async runBuiltinSkill(
    skill: BuiltinSkill,
    request: string,
    originalPrompt: string,
    forcedNotePath?: string,
  ): Promise<void> {
    if (this.isRunning) {
      new Notice('Obsigravity is already running a request. Wait for it to finish.');
      return;
    }
    this.isRunning = true;
    this.appendMessage({ role: 'user', content: originalPrompt, timestamp: Date.now() });

    const assistantEl = this.createMessageEl('assistant');
    const progressEl = this.createProgressTimeline(assistantEl);
    const progressListEl = progressEl.querySelector('.oc-progress-list') as HTMLElement;
    const contentEl = assistantEl.createDiv({ cls: 'oc-message-content' });
    this.appendProgressStep(progressListEl, `${skill.name} started`);

    try {
      const context = forcedNotePath
        ? await this.plugin.getNoteContextByPath(forcedNotePath)
        : await this.plugin.getActiveNoteContext();
      if (!context?.path && !context?.pinnedNotes?.length) {
        throw new Error(`${skill.name} needs an active or pinned Obsidian note.`);
      }

      this.appendProgressStep(
        progressListEl,
        `Using note context: ${context.path || '(pinned only)'}`,
      );

      let assistantBuffer = '';
      for await (const event of this.plugin.agent.query({
        prompt: skill.buildPrompt(request),
        cwd: this.plugin.getVaultPath(),
        allowWorkspaceAccess: true,
        activeNotePath: context.path,
        activeNoteContent: context.content,
        selectedText: context.selection,
        pinnedNotes: context.pinnedNotes,
      })) {
        if (event.type === 'text') {
          assistantBuffer += event.content;
          progressEl.addClass('is-complete');
          this.appendProgressStep(progressListEl, `${skill.name} response received`);
          await this.renderMarkdown(assistantBuffer, contentEl);
        } else if (event.type === 'progress') {
          this.appendProgressStep(progressListEl, event.content);
        } else if (event.type === 'error') {
          progressEl.addClass('is-error');
          this.appendProgressStep(progressListEl, `Error: ${event.content}`);
          this.appendMessage({ role: 'error', content: event.content, timestamp: Date.now() });
        }
      }

      progressEl.addClass('is-complete');
      if (assistantBuffer.trim()) {
        this.messages.push({ role: 'assistant', content: assistantBuffer, timestamp: Date.now() });
        this.saveCurrentConversation();
        this.renderHistoryMenu();
      }
    } catch (error) {
      progressEl.addClass('is-error');
      const message = error instanceof Error ? error.message : String(error);
      this.appendProgressStep(progressListEl, `Error: ${message}`);
      this.appendMessage({ role: 'error', content: message, timestamp: Date.now() });
    } finally {
      this.isRunning = false;
    }
  }

  private parseExternalSlashCommand(prompt: string): { ids: ExternalCliId[]; request: string } | null {
    const match = prompt.match(/^\/(claude|codex|grok|collab)(?:\s+([\s\S]+))?$/);
    if (!match) return null;
    const command = match[1];
    const request = (match[2] || '').trim();
    if (!request) {
      return {
        ids: command === 'collab' ? ['claude', 'codex', 'grok'] : [command as ExternalCliId],
        request: 'Summarize what you can do from Obsigravity in one concise paragraph.',
      };
    }
    return {
      ids: command === 'collab' ? ['claude', 'codex', 'grok'] : [command as ExternalCliId],
      request,
    };
  }

  private async runExternalSlashCommand(ids: ExternalCliId[], request: string, originalPrompt: string): Promise<void> {
    this.isRunning = true;
    this.appendMessage({ role: 'user', content: originalPrompt, timestamp: Date.now() });

    const assistantEl = this.createMessageEl('assistant');
    const progressEl = this.createProgressTimeline(assistantEl);
    const progressListEl = progressEl.querySelector('.oc-progress-list') as HTMLElement;
    const contentEl = assistantEl.createDiv({ cls: 'oc-message-content' });
    this.appendProgressStep(progressListEl, `Launching ${ids.map((id) => id.toUpperCase()).join(' + ')} CLI`);

    try {
      const context = await this.plugin.getActiveNoteContext();
      const runs = ids.map(async (id) => {
        this.appendProgressStep(progressListEl, `${id} process started`);
        const result = await runExternalCli({
          id,
          prompt: request,
          cwd: this.plugin.getVaultPath(),
          settings: this.plugin.settings,
          activeNotePath: context?.path,
          activeNoteContent: context?.content,
          selectedText: context?.selection,
          pinnedNotes: context?.pinnedNotes,
        });
        this.appendProgressStep(progressListEl, `${id} response received`);
        return result;
      });

      const settled = await Promise.allSettled(runs);
      const sections = settled.map((result, index) => {
        const id = ids[index];
        if (result.status === 'rejected') {
          return `## ${id.toUpperCase()}\n\nERROR: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`;
        }
        return [
          `## ${id.toUpperCase()}`,
          '',
          `Command: \`${result.value.command}\``,
          '',
          result.value.output,
        ].join('\n');
      });

      const content = ids.length > 1
        ? ['# Multi-model collaboration', '', ...sections].join('\n')
        : sections.join('\n');
      progressEl.addClass('is-complete');
      this.appendProgressStep(progressListEl, 'External CLI response rendered');
      await this.renderMarkdown(content, contentEl);
      this.messages.push({ role: 'assistant', content, timestamp: Date.now() });
      this.saveCurrentConversation();
      this.renderHistoryMenu();
    } catch (error) {
      progressEl.addClass('is-error');
      const message = error instanceof Error ? error.message : String(error);
      this.appendProgressStep(progressListEl, `Error: ${message}`);
      this.appendMessage({ role: 'error', content: message, timestamp: Date.now() });
    } finally {
      this.isRunning = false;
    }
  }

  private appendMessage(message: ConversationMessage): void {
    this.messages.push(message);
    this.saveCurrentConversation();
    this.renderHistoryMenu();
    const el = this.createMessageEl(message.role);
    const content = el.createDiv({ cls: 'oc-message-content' });
    if (message.role === 'assistant') {
      void this.renderMarkdown(message.content, content);
    } else {
      content.setText(message.content);
    }
  }

  private restoreActiveConversation(): void {
    const active = this.plugin.settings.conversationHistory.find((session) => session.id === this.plugin.settings.activeConversationId);
    if (!active) {
      this.messages = [];
      this.currentConversationId = null;
      this.welcomeEl = this.messagesEl?.createDiv({ cls: 'oc-welcome' }) || null;
      this.renderWelcome();
      return;
    }

    this.currentConversationId = active.id;
    this.messages = [...active.messages];
    this.renderConversationMessages();
  }

  private renderConversationMessages(): void {
    if (!this.messagesEl) return;
    this.messagesEl.empty();
    if (this.messages.length === 0) {
      this.welcomeEl = this.messagesEl.createDiv({ cls: 'oc-welcome' });
      this.renderWelcome();
      return;
    }

    this.welcomeEl = null;
    for (const message of this.messages) {
      const el = this.createMessageEl(message.role);
      const content = el.createDiv({ cls: 'oc-message-content' });
      if (message.role === 'assistant') {
        void this.renderMarkdown(message.content, content);
      } else {
        content.setText(message.content);
      }
    }
  }

  private saveCurrentConversation(): void {
    if (this.messages.length === 0) return;
    const now = Date.now();
    if (!this.currentConversationId) {
      this.currentConversationId = `conv-${now}-${Math.random().toString(36).slice(2, 8)}`;
    }

    const existing = this.plugin.settings.conversationHistory.filter((session) => session.id !== this.currentConversationId);
    const createdAt = this.plugin.settings.conversationHistory.find((session) => session.id === this.currentConversationId)?.createdAt || now;
    const session: ConversationSession = {
      id: this.currentConversationId,
      title: this.buildConversationTitle(this.messages),
      createdAt,
      updatedAt: now,
      messages: [...this.messages],
    };

    this.plugin.settings.conversationHistory = [session, ...existing]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30);
    this.plugin.settings.activeConversationId = session.id;
    void this.plugin.saveSettings();
  }

  private buildConversationTitle(messages: ConversationMessage[]): string {
    const firstUserMessage = messages.find((message) => message.role === 'user')?.content.trim();
    if (!firstUserMessage) return 'Untitled conversation';
    return firstUserMessage.replace(/\s+/g, ' ').slice(0, 72);
  }

  private toggleHistoryMenu(): void {
    if (!this.historyMenuEl) return;
    this.renderHistoryMenu();
    this.historyMenuEl.toggleClass('visible', !this.historyMenuEl.hasClass('visible'));
  }

  private hideHistoryMenu(): void {
    this.historyMenuEl?.removeClass('visible');
  }

  private renderHistoryMenu(): void {
    if (!this.historyMenuEl) return;
    this.historyMenuEl.empty();
    this.historyMenuEl.createDiv({ cls: 'oc-history-header', text: 'Conversation History' });
    const list = this.historyMenuEl.createDiv({ cls: 'oc-history-list' });

    if (this.plugin.settings.conversationHistory.length === 0) {
      list.createDiv({ cls: 'oc-history-empty', text: 'No conversations yet.' });
      return;
    }

    for (const session of this.plugin.settings.conversationHistory) {
      const item = list.createDiv({ cls: 'oc-history-item' });
      item.toggleClass('active', session.id === this.currentConversationId);
      const icon = item.createSpan({ cls: 'oc-history-item-icon' });
      setIcon(icon, 'message-square');

      const content = item.createDiv({ cls: 'oc-history-item-content' });
      content.setAttribute('role', 'button');
      content.setAttribute('tabindex', '0');
      content.createDiv({ cls: 'oc-history-item-title', text: session.title });
      content.createDiv({ cls: 'oc-history-item-date', text: this.formatHistoryDate(session.updatedAt) });
      content.addEventListener('click', () => this.restoreConversation(session.id));
      content.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          this.restoreConversation(session.id);
        }
      });

      const actions = item.createDiv({ cls: 'oc-history-item-actions' });
      const deleteBtn = actions.createEl('button', { cls: 'oc-action-btn oc-delete-btn', attr: { 'aria-label': 'Delete conversation' } });
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', async (event) => {
        event.stopPropagation();
        await this.deleteConversation(session.id);
      });
    }
  }

  private restoreConversation(sessionId: string): void {
    const session = this.plugin.settings.conversationHistory.find((item) => item.id === sessionId);
    if (!session) return;
    this.currentConversationId = session.id;
    this.messages = [...session.messages];
    this.plugin.settings.activeConversationId = session.id;
    void this.plugin.saveSettings();
    this.renderConversationMessages();
    this.renderHistoryMenu();
    this.hideHistoryMenu();
  }

  private async deleteConversation(sessionId: string): Promise<void> {
    this.plugin.settings.conversationHistory = this.plugin.settings.conversationHistory.filter((session) => session.id !== sessionId);
    if (this.currentConversationId === sessionId) {
      this.currentConversationId = null;
      this.messages = [];
      this.plugin.settings.activeConversationId = null;
      this.messagesEl?.empty();
      this.welcomeEl = this.messagesEl?.createDiv({ cls: 'oc-welcome' }) || null;
      this.renderWelcome();
    }
    await this.plugin.saveSettings();
    this.renderHistoryMenu();
  }

  private formatHistoryDate(timestamp: number): string {
    return new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  private createMessageEl(role: ConversationMessage['role']): HTMLElement {
    if (this.welcomeEl) {
      this.welcomeEl.remove();
      this.welcomeEl = null;
    }
    const className = role === 'user'
      ? 'oc-message oc-message-user'
      : role === 'error'
        ? 'oc-message oc-message-assistant oc-message-error'
        : 'oc-message oc-message-assistant';
    const el = this.messagesEl!.createDiv({ cls: className });
    this.messagesEl!.scrollTop = this.messagesEl!.scrollHeight;
    return el;
  }

  private createProgressTimeline(parent: HTMLElement): HTMLElement {
    const wrapper = parent.createDiv({ cls: 'oc-progress-timeline' });
    const header = wrapper.createDiv({ cls: 'oc-progress-header' });
    header.createSpan({ cls: 'oc-progress-dot' });
    header.createSpan({ cls: 'oc-progress-title', text: 'Antigravity working steps' });
    wrapper.createDiv({ cls: 'oc-progress-list' });
    return wrapper;
  }

  private appendProgressStep(listEl: HTMLElement, message: string): void {
    const previous = listEl.lastElementChild;
    if (previous?.textContent === message) return;
    const item = listEl.createDiv({ cls: 'oc-progress-step' });
    item.setText(message);
    const maxItems = 24;
    while (listEl.children.length > maxItems) {
      listEl.firstElementChild?.remove();
    }
    item.scrollIntoView({ block: 'nearest' });
    if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private async renderMarkdown(markdown: string, el: HTMLElement): Promise<void> {
    el.empty();
    await MarkdownRenderer.renderMarkdown(markdown, el, '', this);
    this.enableRenderedLinks(el);
    if (this.messagesEl) this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private enableRenderedLinks(el: HTMLElement): void {
    for (const anchor of Array.from(el.querySelectorAll('a'))) {
      anchor.addClass('oc-rendered-link');
      anchor.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rawTarget = anchor.getAttribute('data-href') || anchor.getAttribute('href') || '';
        const label = anchor.textContent || '';
        void this.openRenderedLink(rawTarget, label);
      });
    }
  }
}
