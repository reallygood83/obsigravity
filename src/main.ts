import { MarkdownView, Notice, Plugin, TFile } from 'obsidian';

import { AntigravityProvider } from './core/agent/AntigravityProvider';
import { findAntigravityCli } from './core/antigravity/AntigravityCliResolver';
import { discoverClaudeTools } from './core/claude/ClaudeToolDiscovery';
import { detectExternalClis } from './core/cli/ExternalCliResolver';
import { draftVisualPrompt, generateVisualAsset } from './core/images/VisualAssetService';
import { buildImagePrompt } from './core/images/ImagePromptBuilder';
import { buildProcessEnv } from './core/settings/env';
import { getBuiltinSkillById } from './core/skills/BuiltinSkills';
import { generateGrokVideoFromNote } from './core/video/GrokVideoService';
import type { ObsigravitySettings } from './core/types';
import { DEFAULT_SETTINGS } from './core/types';
import { ObsigravityView, VIEW_TYPE_OBSIGRAVITY } from './ui/ObsigravityView';
import { GrokVideoGenerationModal } from './ui/modals/GrokVideoGenerationModal';
import { ImageGenerationModal } from './ui/modals/ImageGenerationModal';
import { VisualGenerationProgressModal } from './ui/modals/VisualGenerationProgressModal';
import { VisualPromptPreviewModal } from './ui/modals/VisualPromptPreviewModal';
import { ObsigravitySettingsTab } from './ui/settings/ObsigravitySettingsTab';

export const OBSIGRAVITY_ICON = 'bot';

interface ActiveNoteContext {
  file: TFile;
  path: string;
  content: string;
  selection?: string;
  pinnedNotes: Array<{ path: string; content: string }>;
}

export default class ObsigravityPlugin extends Plugin {
  settings: ObsigravitySettings;
  agent: AntigravityProvider;
  private lastActiveMarkdownFile: TFile | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.autofillAntigravityCliPath();
    this.agent = new AntigravityProvider(() => this.settings);
    this.registerView(VIEW_TYPE_OBSIGRAVITY, (leaf) => new ObsigravityView(leaf, this));

    this.addRibbonIcon(OBSIGRAVITY_ICON, 'Open Obsigravity', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-obsigravity',
      name: 'Open Obsigravity',
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: 'generate-image-from-note',
      name: 'Generate Obsigravity image from active note',
      callback: () => void this.generateImageFromActiveNote(),
    });

    this.addCommand({
      id: 'generate-grok-video-from-note',
      name: 'Generate Grok video from active note',
      callback: () => void this.generateGrokVideoFromActiveNote(),
    });

    this.addCommand({
      id: 'probe-antigravity-capabilities',
      name: 'Probe Antigravity media capabilities',
      callback: () => void this.probeAntigravityCapabilities(),
    });

    this.addCommand({
      id: 'attach-current-note',
      name: 'Attach current note to chat',
      checkCallback: (checking: boolean) => {
        const activeFile = this.getActiveMarkdownFile();
        if (!activeFile) return false;
        if (checking) return true;

        void this.attachCurrentNoteToChat();
        return true;
      },
    });

    this.addCommand({
      id: 'update-note-from-pulse',
      name: 'Update note from Vault Pulse request',
      callback: () => void this.consumePendingPulseUpdate(),
    });

    this.addSettingTab(new ObsigravitySettingsTab(this));
  }

  /**
   * Public API for Vault Pulse (and similar plugins).
   * Opens the note, opens Obsigravity, runs Note Surgeon with the user request.
   */
  async startNoteUpdateFromPulse(notePath: string, userPrompt: string): Promise<void> {
    const path = notePath.replace(/\\/g, '/');
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!file || !(file instanceof TFile) || file.extension !== 'md') {
      new Notice(`Obsigravity: note not found (${path})`);
      return;
    }

    await this.app.workspace.getLeaf(false).openFile(file);
    this.lastActiveMarkdownFile = file;
    await this.activateView();

    if (!getBuiltinSkillById('note-surgeon')) {
      new Notice('Obsigravity: note-surgeon skill missing');
      return;
    }

    const direction = [
      'Vault Pulse info-update request. Read the active note carefully, then update it so facts, structure, and clarity match the user request.',
      'Prefer editing the active note when safe file editing is available. Preserve original meaning unless the user asks otherwise.',
      '',
      'User request:',
      userPrompt.trim() || 'Refresh and improve this note with clearer structure and up-to-date framing based on its content.',
    ].join('\n');

    // Let the view mount, then run skill
    window.setTimeout(() => {
      void this.runNoteSurgeonOnOpenViews(direction);
    }, 350);

    new Notice('Obsigravity: Note Surgeon started for Vault Pulse update');
  }

  private pendingPulseUpdate: { path: string; prompt: string } | null = null;

  /** Soft bridge: queue a request then run command */
  queuePulseUpdate(path: string, prompt: string): void {
    this.pendingPulseUpdate = { path, prompt };
  }

  async consumePendingPulseUpdate(): Promise<void> {
    const pending = this.pendingPulseUpdate;
    this.pendingPulseUpdate = null;
    if (!pending) {
      new Notice('No pending Vault Pulse update request.');
      return;
    }
    await this.startNoteUpdateFromPulse(pending.path, pending.prompt);
  }

  private async runNoteSurgeonOnOpenViews(direction: string, attempt = 0): Promise<void> {
    const skill = getBuiltinSkillById('note-surgeon');
    if (!skill) return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIGRAVITY);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof ObsigravityView) {
        await view.runBuiltinSkill(skill, direction, `/note-surgeon ${direction}`);
        return;
      }
    }
    if (attempt >= 3) {
      new Notice('Obsigravity: could not start Note Surgeon view. Open Obsigravity and run /note-surgeon manually.');
      return;
    }
    await this.activateView();
    window.setTimeout(() => {
      void this.runNoteSurgeonOnOpenViews(direction, attempt + 1);
    }, 400);
  }

  onunload(): void {
    this.agent?.cancel();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_OBSIGRAVITY);
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      externalCliPaths: {
        ...DEFAULT_SETTINGS.externalCliPaths,
        ...data?.externalCliPaths,
      },
      preferredModel: typeof data?.preferredModel === 'string' ? data.preferredModel : DEFAULT_SETTINGS.preferredModel,
      pinnedNotePaths: Array.isArray(data?.pinnedNotePaths) ? data.pinnedNotePaths : DEFAULT_SETTINGS.pinnedNotePaths,
      excludedNotePaths: Array.isArray(data?.excludedNotePaths) ? data.excludedNotePaths : DEFAULT_SETTINGS.excludedNotePaths,
      omx: {
        ...DEFAULT_SETTINGS.omx,
        ...data?.omx,
      },
      blockedCommands: {
        ...DEFAULT_SETTINGS.blockedCommands,
        ...data?.blockedCommands,
      },
      allowedExportPaths: Array.isArray(data?.allowedExportPaths) ? data.allowedExportPaths : DEFAULT_SETTINGS.allowedExportPaths,
      conversationHistory: Array.isArray(data?.conversationHistory) ? data.conversationHistory : DEFAULT_SETTINGS.conversationHistory,
      activeConversationId: typeof data?.activeConversationId === 'string' ? data.activeConversationId : DEFAULT_SETTINGS.activeConversationId,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async autofillAntigravityCliPath(): Promise<void> {
    let changed = false;
    const envPath = buildProcessEnv(this.settings.environmentVariables).PATH;

    if (!this.settings.antigravityCliPath.trim()) {
      const detected = findAntigravityCli('', envPath);
      if (detected) {
        this.settings.antigravityCliPath = detected;
        changed = true;
      }
    }

    const detectedExternal = detectExternalClis(this.settings.externalCliPaths, envPath);
    for (const id of ['claude', 'codex', 'grok'] as const) {
      if (!this.settings.externalCliPaths[id].trim() && detectedExternal[id]) {
        this.settings.externalCliPaths[id] = detectedExternal[id] || '';
        changed = true;
      }
    }

    if (changed) await this.saveSettings();
  }

  async autodetectExternalClis(): Promise<void> {
    const envPath = buildProcessEnv(this.settings.environmentVariables).PATH;
    const detectedExternal = detectExternalClis(this.settings.externalCliPaths, envPath);
    let changed = false;

    for (const id of ['claude', 'codex', 'grok'] as const) {
      if (detectedExternal[id] && this.settings.externalCliPaths[id] !== detectedExternal[id]) {
        this.settings.externalCliPaths[id] = detectedExternal[id] || '';
        changed = true;
      }
    }

    if (changed) await this.saveSettings();
  }

  getClaudeTools(): ReturnType<typeof discoverClaudeTools> {
    return discoverClaudeTools();
  }

  refreshObsigravityViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIGRAVITY)) {
      const view = leaf.view;
      if (view instanceof ObsigravityView) view.refreshDiscoveredSlashCommands();
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_OBSIGRAVITY)[0];
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      leaf = rightLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_OBSIGRAVITY, active: true });
    }
    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string };
    return adapter.basePath || '/';
  }

  async getActiveNoteContext(): Promise<ActiveNoteContext | null> {
    const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = this.getActiveMarkdownFile();
    const includeActiveFile = Boolean(
      file
      && this.settings.autoIncludeActiveNote
      && !this.isNoteExcluded(file.path),
    );
    const pinnedNotes = await this.getPinnedNoteContents(file?.path);
    if (!file && pinnedNotes.length === 0) return null;

    const content = file && includeActiveFile ? await this.app.vault.read(file) : '';
    const selection = includeActiveFile && markdownView?.file?.path === file?.path
      ? markdownView?.editor?.getSelection()?.trim() || undefined
      : undefined;
    return {
      file: file!,
      path: file?.path || '',
      content,
      selection,
      pinnedNotes,
    };
  }

  async getPinnedNoteContents(excludePath?: string): Promise<Array<{ path: string; content: string }>> {
    const notes: Array<{ path: string; content: string }> = [];
    for (const notePath of this.settings.pinnedNotePaths) {
      if (notePath === excludePath) continue;
      if (this.isNoteExcluded(notePath)) continue;
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!file || !('extension' in file)) continue;
      try {
        notes.push({ path: notePath, content: await this.app.vault.read(file as TFile) });
      } catch {
        // Ignore stale pinned files; the UI still exposes the stored path.
      }
    }
    return notes;
  }

  getActiveMarkdownFile(): TFile | null {
    const markdownViewFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const activeFile = this.app.workspace.getActiveFile();
    const file = markdownViewFile || activeFile || this.lastActiveMarkdownFile;

    if (file && file.extension === 'md') {
      this.lastActiveMarkdownFile = file;
      return file;
    }

    return this.lastActiveMarkdownFile;
  }

  isNotePinned(path: string): boolean {
    const normalizedPath = path.replace(/\\/g, '/');
    return this.settings.pinnedNotePaths.includes(normalizedPath);
  }

  isNoteExcluded(path: string): boolean {
    const normalizedPath = path.replace(/\\/g, '/');
    return this.settings.excludedNotePaths.includes(normalizedPath);
  }

  async pinNote(path: string): Promise<void> {
    const normalizedPath = path.replace(/\\/g, '/');
    await this.includeNote(normalizedPath);
    if (!this.settings.pinnedNotePaths.includes(normalizedPath)) {
      this.settings.pinnedNotePaths.push(normalizedPath);
      await this.saveSettings();
    }
  }

  async attachCurrentNoteToChat(): Promise<void> {
    const activeFile = this.getActiveMarkdownFile();
    if (!activeFile) {
      new Notice('Open a markdown note before attaching it.');
      return;
    }

    await this.pinNote(activeFile.path.replace(/\\/g, '/'));
    await this.activateView();
    this.refreshOpenViews();
    new Notice(`Attached: ${activeFile.name}`);
  }

  refreshOpenViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_OBSIGRAVITY)) {
      const view = leaf.view;
      if (view instanceof ObsigravityView) {
        view.refreshContextChips();
      }
    }
  }

  async unpinNote(path: string): Promise<void> {
    const normalizedPath = path.replace(/\\/g, '/');
    const next = this.settings.pinnedNotePaths.filter((item) => item !== normalizedPath);
    if (next.length !== this.settings.pinnedNotePaths.length) {
      this.settings.pinnedNotePaths = next;
      await this.saveSettings();
    }
  }

  async excludeNote(path: string): Promise<void> {
    const normalizedPath = path.replace(/\\/g, '/');
    this.settings.pinnedNotePaths = this.settings.pinnedNotePaths.filter((item) => item !== normalizedPath);
    if (!this.settings.excludedNotePaths.includes(normalizedPath)) {
      this.settings.excludedNotePaths.push(normalizedPath);
    }
    await this.saveSettings();
  }

  async includeNote(path: string): Promise<void> {
    const normalizedPath = path.replace(/\\/g, '/');
    const next = this.settings.excludedNotePaths.filter((item) => item !== normalizedPath);
    if (next.length !== this.settings.excludedNotePaths.length) {
      this.settings.excludedNotePaths = next;
      await this.saveSettings();
    }
  }

  async generateImageFromActiveNote(): Promise<void> {
    const activeFile = this.getActiveMarkdownFile();
    const context = await this.getActiveNoteContext();
    if (!context || !activeFile) {
      new Notice('Open a markdown note before generating an Obsigravity image.');
      return;
    }

    const input = await new ImageGenerationModal(this.app).openAndWait();
    if (!input) return;

    const progressModal = new VisualGenerationProgressModal(this.app, 'Generating Obsigravity image');
    progressModal.open();
    progressModal.addStep(`Obsigravity source note: ${activeFile.path}`);
    progressModal.addStep(`Antigravity format: ${input.mode}`);
    progressModal.addStep('Capability gate: image enabled, video/TTS skipped until native Antigravity support exists.');

    let activeProgressModal = progressModal;
    try {
      const noteContent = context.content || await this.app.vault.read(activeFile);
      progressModal.addStep('Using Antigravity agent runtime to draft an image prompt...');
      const draftedPrompt = await draftVisualPrompt({
        app: this.app,
        agent: this.agent,
        vaultPath: this.getVaultPath(),
        file: activeFile,
        mediaFolder: this.settings.mediaFolder,
        mode: input.mode,
        outputType: 'png',
        userPrompt: buildObsigravityDirection(input.prompt),
        noteContent,
        selection: context.selection,
        onProgress: (message) => progressModal.addStep(message),
      });
      progressModal.close();

      const promptForReview = draftedPrompt || buildImagePrompt({
        mode: input.mode,
        outputType: 'png',
        userPrompt: buildObsigravityDirection(input.prompt),
        noteTitle: activeFile.basename,
        noteContent,
        selection: context.selection,
      });
      const reviewedPrompt = await new VisualPromptPreviewModal(this.app, promptForReview, 'png').openAndWait();
      if (!reviewedPrompt) return;

      const generationProgressModal = new VisualGenerationProgressModal(this.app, 'Generating Obsigravity image');
      activeProgressModal = generationProgressModal;
      generationProgressModal.open();
      generationProgressModal.addStep('Generating Antigravity-native image and embedding it in the note...');
      const generated = await generateVisualAsset({
        app: this.app,
        agent: this.agent,
        vaultPath: this.getVaultPath(),
        file: activeFile,
        mediaFolder: this.settings.mediaFolder,
        mode: input.mode,
        outputType: 'png',
        userPrompt: buildObsigravityDirection(input.prompt),
        generatedPrompt: reviewedPrompt,
        noteContent,
        selection: context.selection,
        onProgress: (message) => generationProgressModal.addStep(message),
      });

      generationProgressModal.finish(`Obsigravity image embedded: ${generated.path}`, 'success');
      new Notice(`Obsigravity image embedded: ${generated.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      activeProgressModal.finish(`Error: ${message}`, 'error');
      console.error('[Obsigravity] Image generation failed:', error);
      new Notice(`Obsigravity image generation failed: ${message}`);
    }
  }

  async generateGrokVideoFromActiveNote(direction = ''): Promise<void> {
    const activeFile = this.getActiveMarkdownFile();
    const context = await this.getActiveNoteContext();
    if (!context || !activeFile) {
      new Notice('Open a markdown note before generating a Grok video.');
      return;
    }

    const input = direction.trim()
      ? { prompt: direction }
      : await new GrokVideoGenerationModal(this.app).openAndWait();
    if (!input) return;

    const progressModal = new VisualGenerationProgressModal(this.app, 'Generating Grok video');
    progressModal.open();
    progressModal.addStep(`Grok video source note: ${activeFile.path}`);
    progressModal.addStep('Capability gate: Grok Build must create a real MP4, or report NOT_AVAILABLE.');

    try {
      const noteContent = context.content || await this.app.vault.read(activeFile);
      const generated = await generateGrokVideoFromNote({
        app: this.app,
        settings: this.settings,
        vaultPath: this.getVaultPath(),
        file: activeFile,
        mediaFolder: this.settings.mediaFolder,
        noteContent,
        selectedText: context.selection,
        pinnedNotes: context.pinnedNotes,
        userPrompt: input.prompt,
        onProgress: (message) => progressModal.addStep(message),
      });

      progressModal.finish(`Grok video embedded: ${generated.path}`, 'success');
      new Notice(`Grok video embedded: ${generated.path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.finish(`Grok video failed: ${message}`, 'error');
      new Notice(`Grok video failed: ${message}`);
    }
  }

  async probeAntigravityCapabilities(): Promise<void> {
    const progressModal = new VisualGenerationProgressModal(this.app, 'Probing Antigravity capabilities');
    progressModal.open();
    progressModal.addStep('Probing Antigravity native media capabilities...');
    let transcript = '';
    try {
      for await (const event of this.agent.query({
        cwd: this.getVaultPath(),
        allowWorkspaceAccess: false,
        prompt: [
          'Probe native Antigravity media capabilities for Obsigravity.',
          'Report whether native raster image generation, native generative video, and native TTS/audio narration are available.',
          'Do not create placeholder files or use external fallback APIs.',
          'Return a compact Markdown table with capability, status, and evidence.',
        ].join('\n'),
      })) {
        if (event.type === 'progress') progressModal.addStep(event.content);
        if (event.type === 'text') transcript += event.content;
        if (event.type === 'error') transcript += `\nERROR: ${event.content}`;
      }
      progressModal.finish(transcript.trim() || 'Capability probe completed.', 'success');
      new Notice('Antigravity capability probe completed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      progressModal.finish(`Error: ${message}`, 'error');
      new Notice(`Antigravity capability probe failed: ${message}`);
    }
  }
}

function buildObsigravityDirection(userPrompt: string): string {
  return [
    userPrompt,
    '',
    'Obsigravity direction:',
    '- Treat this as an Obsidian-native Antigravity image pack generated from the current note.',
    '- Make the visual useful as a note header, concept card, or knowledge artifact.',
    '- Reflect local-note context rather than generic stock imagery.',
    '- Leave room for future content-pack expansion; do not mention unsupported video or TTS inside the image.',
  ].join('\n').trim();
}
