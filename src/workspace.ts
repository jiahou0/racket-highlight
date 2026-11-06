import * as vscode from 'vscode';
import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Worker, Analysis, BackendError, CompletionName, DocumentParameters, Lexical, RacketError, SourceRange } from './protocol';
import { Snapshot, assertNotCancelled, awaitWithCancellation, documentSnapshot, isCancellation, isRacket } from './documents';

export interface SemanticSession { worker: Worker; snapshot: Snapshot; analysis: Analysis; epoch: number }
export interface LexicalSession {
  snapshot: Snapshot;
  data: Lexical;
  assertCurrent(): void;
  request<T>(method: string, params: unknown, token?: vscode.CancellationToken): Promise<T>;
}

export function dependsOnFiles(dependencies: readonly string[] | undefined, changedFiles: Iterable<string>): boolean {
  if (!dependencies?.length) return true;
  const normalize = (path: string) => process.platform === 'linux' ? resolve(path) : resolve(path).toLowerCase();
  const changed = [...changedFiles].map(normalize);
  return dependencies.some(path => {
    const dependency = normalize(path);
    // Directory reads cover descendants; retain the same logical path rules
    // as the source loader rather than resolving symlinks differently here.
    return changed.some(file => dependency === file
      || file.startsWith(dependency.endsWith(sep) ? dependency : dependency + sep)
      || dependency.startsWith(file.endsWith(sep) ? file : file + sep));
  });
}

export function requireSemanticAnalysis(session: SemanticSession | undefined): asserts session is SemanticSession {
  if (!session) throw new Error('No current semantic analysis');
  if (session.analysis.mode === 'syntax') throw new Error('Semantic analysis unavailable: racket/load');
  if (!session.analysis.complete) throw new Error(session.analysis.errors.map(error => error.message).join('\n') || 'Racket analysis is incomplete');
}

interface SemanticEntry {
  worker?: Worker;
  snapshot?: Snapshot;
  session?: SemanticSession;
  pending: boolean;
  failure?: Error;
  promise: Promise<SemanticSession>;
}
interface LexicalEntry { worker: Worker; epoch: number; text: string; stale: boolean; ready: boolean; promise: Promise<Lexical> }
interface DiagnosticEntry { uri: vscode.Uri; diagnostic: vscode.Diagnostic }

export class Workspace implements vscode.Disposable {
  private epoch = 0;
  private revision = 0;
  private disposed = false;
  private reportedErrors = new WeakSet<Error>();
  private semanticEntries = new Map<string, SemanticEntry>();
  private lastCompletionNames = new Map<string, CompletionName[]>();
  private lexicalEntries = new Map<string, LexicalEntry>();
  private recentlyClosed = new Map<string, vscode.Uri>();
  private activeQueries = new Map<string, number>();
  private dependencyWatchers = new Map<string, vscode.Disposable>();
  private workerDependencies = new Map<Worker, string[] | undefined>();
  private disposables: vscode.Disposable[] = [];
  private diagnosticContributions = new Map<string, DiagnosticEntry[]>();
  readonly changed = new vscode.EventEmitter<void>();
  readonly ready = new vscode.EventEmitter<SemanticSession>();
  readonly diagnostics = vscode.languages.createDiagnosticCollection('Racket');
  readonly log = vscode.window.createOutputChannel('Racket Workbench');
  readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);

  constructor(readonly context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const changedFile = (uri: vscode.Uri) => {
      if (/(?:^|[\\/])(?:\.git|node_modules|compiled)(?:[\\/]|$)/.test(uri.fsPath)) return;
      void this.changedFile(uri).catch(error => this.report(error, uri));
    };
    this.disposables.push(watcher, watcher.onDidChange(changedFile), watcher.onDidCreate(changedFile), watcher.onDidDelete(changedFile));
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => {
        if (!event.contentChanges.length || !['file', 'untitled'].includes(event.document.uri.scheme)) return;
        this.invalidateEdit(event.document.uri);
      }),
      vscode.workspace.onDidOpenTextDocument(document => this.openDocument(document)),
      vscode.workspace.onDidSaveTextDocument(document => {
        this.invalidate(document.uri);
        if (isRacket(document)) this.check(document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        void this.closeDocument(document).catch(error => this.report(error, document.uri));
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('racketWorkbench.executable')) {
          this.lastCompletionNames.clear();
          this.invalidate();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.reanalyze()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
    );
    this.updateStatus();
  }

  private updateStatus(text?: string): void {
    const active = vscode.window.activeTextEditor;
    void vscode.commands.executeCommand('setContext', 'racket.active', !!active && isRacket(active.document));
    const pending = !!active && !!this.semanticEntries.get(active.document.uri.toString())?.pending;
    void vscode.commands.executeCommand('setContext', 'racket.checking', pending);
    if (!active || !isRacket(active.document)) { this.status.hide(); return; }
    const session = this.current(active.document.uri);
    this.status.command = pending ? 'racket.cancelCheck' : 'racket.checkCurrentFile';
    this.status.text = text || (!vscode.workspace.isTrusted ? 'Racket: Restricted'
      : pending ? '$(sync~spin) Racket: Analyzing' : session ? this.analysisStatus(session) : 'Racket: Unchecked');
    this.status.show();
  }

  private analysisStatus(session: SemanticSession): string {
    if (!session.analysis.complete) return '$(error) Racket: Analysis failed';
    if (session.analysis.mode === 'syntax') return 'Racket: Syntax';
    const source = this.sourcePath(session.snapshot.uri);
    const bindings = session.analysis.annotations.filter(a => a.kind === 'binding' && a.actual && a.to?.source === source).length;
    return `Racket: ${bindings} bindings`;
  }

  assertTrusted(): void {
    if (this.disposed) throw new vscode.CancellationError();
    if (!vscode.workspace.isTrusted) throw new Error('Racket analysis requires a trusted workspace');
  }

  invalidate(edited?: vscode.Uri): void {
    if (this.disposed) return;
    this.epoch++;
    this.revision++;
    this.clearCaches(edited);
    this.diagnostics.clear();
    this.changed.fire();
    this.updateStatus();
  }

  private invalidateEdit(uri: vscode.Uri): void {
    if (this.disposed) return;
    this.revision++;
    const key = uri.toString();
    const dependsOnEdit = (worker: Worker | undefined) => {
      const paths = worker && this.workerDependencies.get(worker);
      if (!worker || worker.busy || !paths) return true;
      return dependsOnFiles(paths, [this.sourcePath(uri)]);
    };
    for (const [owner, entry] of this.semanticEntries) {
      if (owner !== key && (uri.scheme !== 'file' || !entry.pending && entry.session?.analysis.complete && !dependsOnEdit(entry.worker))) continue;
      this.semanticEntries.delete(owner);
      entry.worker?.dispose();
      this.diagnosticContributions.delete(`semantic:${owner}`);
    }
    for (const [owner, entry] of this.lexicalEntries) {
      if (owner !== key && (uri.scheme !== 'file' || entry.ready && !entry.stale && !dependsOnEdit(entry.worker))) continue;
      if (owner === key) entry.stale = true;
      else { this.lexicalEntries.delete(owner); entry.worker.dispose(); }
      this.diagnosticContributions.delete(`reader:${owner}`);
    }
    for (const owner of this.recentlyClosed.keys()) {
      if (!this.semanticEntries.has(owner) && !this.lexicalEntries.has(owner)) this.recentlyClosed.delete(owner);
    }
    this.syncDependencies();
    this.refreshDiagnostics();
    this.changed.fire();
    this.updateStatus();
  }

  private clearCaches(edited?: vscode.Uri): void {
    for (const entry of this.semanticEntries.values()) entry.worker?.dispose();
    // Keep the edited document's process, but its data still expires with the
    // epoch. Configuration and external dependency changes restart all workers.
    for (const [key, entry] of this.lexicalEntries) if (key !== edited?.toString()) {
      entry.worker.dispose();
      this.lexicalEntries.delete(key);
    }
    for (const watcher of this.dependencyWatchers.values()) watcher.dispose();
    this.semanticEntries.clear();
    this.recentlyClosed.clear();
    this.dependencyWatchers.clear();
    this.diagnosticContributions.clear();
  }

  reanalyze(): void {
    this.invalidate();
    for (const document of vscode.workspace.textDocuments) if (isRacket(document)) this.check(document);
  }

  checkCurrentFile(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isRacket(document) || !vscode.workspace.isTrusted || this.disposed) return;
    this.discardAnalysis(document.uri);
    this.check(document);
  }

  cancelCheck(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (document && this.semanticEntries.get(document.uri.toString())?.pending) this.discardAnalysis(document.uri);
  }

  private discardAnalysis(uri: vscode.Uri): void {
    this.revision++;
    const key = uri.toString(), entry = this.semanticEntries.get(key);
    this.semanticEntries.delete(key);
    entry?.worker?.dispose();
    this.syncDependencies();
    this.setDiagnostics(`semantic:${key}`, []);
    this.changed.fire();
    this.updateStatus();
  }

  private check(document: vscode.TextDocument): void {
    if (this.disposed || document.isClosed || !vscode.workspace.isTrusted) return;
    void this.analyze(document.uri).catch(error => this.report(error, document.uri));
  }

  private async changedFile(uri: vscode.Uri): Promise<void> {
    if (this.disposed) return;
    const epoch = this.epoch;
    const document = this.findDocument(uri);
    if (document) {
      const disk = await fs.readFile(uri.fsPath, 'utf8').catch(() => undefined);
      if (epoch !== this.epoch) return;
      // Save already invalidates and checks the editor snapshot. Its matching
      // filesystem event must not cancel that newly requested analysis.
      if (!document.isClosed && disk === document.getText()) return;
    }
    this.invalidate();
  }

  private openDocument(document: vscode.TextDocument): void {
    if (!isRacket(document)) {
      // Restored unsaved overlays can change a macro's non-Racket inputs too.
      if (document.uri.scheme === 'file' && document.isDirty) this.invalidate();
      return;
    }
    const key = document.uri.toString();
    this.recentlyClosed.delete(key);
    const cached = this.semanticEntries.get(key);
    const lexical = this.lexicalEntries.get(key);
    const text = document.getText();
    if ((cached?.snapshot && cached.snapshot.original !== text) || (!cached && document.isDirty && document.uri.scheme === 'file')
      || (lexical && lexical.text !== text)) {
      if (document.uri.scheme === 'file') this.invalidate();
      else this.invalidateEdit(document.uri);
      this.check(document);
      return;
    }
    if (!cached) { this.check(document); return; }
    void this.available(document.uri).then(async session => {
      if (!session || document.isClosed) return;
      await this.publish(session);
      this.assertCurrent(session);
      if (document.isClosed) return;
      this.log.appendLine(`[cache] Reusing analysis: ${document.uri.fsPath}`);
      this.ready.fire(session);
      this.updateStatus();
    }).catch(error => this.report(error, document.uri));
  }

  private async closeDocument(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    this.lastCompletionNames.delete(key);
    this.diagnosticContributions.delete(`semantic:${key}`);
    this.diagnosticContributions.delete(`reader:${key}`);
    this.refreshDiagnostics();
    if (document.uri.scheme !== 'file') {
      this.invalidateEdit(document.uri);
      this.recentlyClosed.delete(key);
      this.lexicalEntries.get(key)?.worker.dispose(); this.lexicalEntries.delete(key);
      this.releaseClosed(document.uri);
      return;
    }
    if (document.isDirty) { this.invalidate(); return; }
    // A discarded editor buffer must not survive as a cached module or as an
    // unsaved dependency in another worker. Closing an unchanged file is free.
    const epoch = this.epoch;
    const previousText = document.getText();
    const text = await fs.readFile(document.uri.fsPath, 'utf8').catch(() => undefined);
    if (this.disposed || epoch !== this.epoch) return;
    if (text !== previousText) { this.invalidate(); return; }
    if (this.findDocument(document.uri) || !this.semanticEntries.has(key) && !this.lexicalEntries.has(key)) return;
    this.recentlyClosed.delete(key);
    this.recentlyClosed.set(key, document.uri);
    this.trimClosed();
  }

  start(): void {
    // Restored buffers are already present in every request's overlay. Do not
    // invalidate earlier startup checks when another restored buffer is dirty.
    for (const document of vscode.workspace.textDocuments) if (isRacket(document)) {
      this.check(document);
    }
  }

  sourcePath(uri: vscode.Uri): string {
    if (uri.scheme === 'file') return uri.fsPath;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    return join(root, `.racket-workbench-${encodeURIComponent(uri.toString())}.rkt`);
  }

  private findDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
    const key = uri.toString();
    return vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === key);
  }

  async snapshot(uri: vscode.Uri): Promise<Snapshot> {
    const open = this.findDocument(uri);
    if (open) return documentSnapshot(open);
    return new Snapshot(uri, await fs.readFile(uri.fsPath, 'utf8'));
  }

  private openSources(): DocumentParameters['documents'] {
    return vscode.workspace.textDocuments.filter(doc => !doc.isClosed && doc.uri.scheme === 'file')
      .map(doc => ({ path: doc.uri.fsPath, text: doc.getText().replace(/\r\n?/g, '\n') }));
  }

  parameters(snapshot: Snapshot): DocumentParameters {
    return {
      path: this.sourcePath(snapshot.uri), text: snapshot.text,
      roots: (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
      documents: this.openSources(),
    };
  }

  assertCurrent(session: SemanticSession): void {
    if (session.epoch !== this.epoch || !session.worker.running) throw new vscode.CancellationError();
  }

  current(uri: vscode.Uri): SemanticSession | undefined {
    const entry = this.semanticEntries.get(uri.toString());
    if (!entry?.session) return;
    const session = entry.session;
    if (!session.worker.running || session.epoch !== this.epoch) return;
    const document = this.findDocument(uri);
    if (!document) return session;
    const snapshot = documentSnapshot(document);
    if (snapshot.original !== session.snapshot.original) return;
    if (snapshot === session.snapshot) return session;
    entry.session = { ...session, snapshot };
    return entry.session;
  }

  completionNames(uri: vscode.Uri): CompletionName[] {
    return this.lastCompletionNames.get(uri.toString()) || [];
  }
  get generation(): number { return this.revision; }

  assertGeneration(generation: number, token?: vscode.CancellationToken): void {
    assertNotCancelled(token);
    if (this.disposed || generation !== this.revision) throw new vscode.CancellationError();
  }

  cachedFiles(): SemanticSession[] {
    const sessions: SemanticSession[] = [];
    for (const entry of this.semanticEntries.values()) {
      if (!entry.session) continue;
      const uri = entry.session.snapshot.uri;
      if (uri.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(uri) && !this.findDocument(uri)) continue;
      const session = this.current(uri);
      if (session?.analysis.complete && session.analysis.mode === 'module') sessions.push(session);
    }
    return sessions;
  }

  // Providers may wait for a requested check, but never start one themselves.
  async available(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<SemanticSession | undefined> {
    assertNotCancelled(token);
    const cached = this.semanticEntries.get(uri.toString());
    if (!cached) return;
    const session = await awaitWithCancellation(cached.promise, token);
    this.assertCurrent(session);
    assertNotCancelled(token);
    return this.current(uri);
  }

  private createWorker(mode: 'semantic' | 'lexical', uri: vscode.Uri): Worker {
    const worker = new Worker(this.context, mode, uri, this.log, () => this.openSources());
    const key = uri.toString();
    const cache = mode === 'semantic' ? this.semanticEntries : this.lexicalEntries;
    worker.dependenciesChanged.event(paths => {
      if (cache.get(key)?.worker !== worker) return;
      this.workerDependencies.set(worker, paths);
      if (mode === 'semantic') {
        const analysis = this.semanticEntries.get(key)?.session?.analysis;
        // Later callbacks can read more sources. Keep that evidence even after
        // the bounded cache evicts the worker but a rename retains its baseline.
        if (analysis) analysis.dependencies = paths || [];
      }
      this.syncDependencies();
    });
    worker.exited.event(error => {
      this.workerDependencies.delete(worker);
      if (isCancellation(error) || this.disposed) return;
      if (cache.get(key)?.worker !== worker) return;
      // Pending requests own cleanup and error delivery. Removing their entry
      // here would make their catch handlers mistake a crash for cancellation.
      if (mode === 'semantic') {
        const entry = this.semanticEntries.get(key)!;
        if (entry.pending) { entry.failure = error; return; }
      } else if (!this.lexicalEntries.get(key)!.ready) return;
      cache.delete(key);
      if (!this.semanticEntries.has(key) && !this.lexicalEntries.has(key)) this.recentlyClosed.delete(key);
      this.syncDependencies();
      if (mode === 'semantic') {
        this.setDiagnostics(`semantic:${key}`, []);
        this.changed.fire();
        this.updateStatus();
      }
      this.report(error, uri);
    });
    return worker;
  }

  // Explicit cross-file commands may check expired sources, including buffers
  // that were opened before. Passive editor providers only use available().
  async withSemantic<T>(uri: vscode.Uri, token: vscode.CancellationToken | undefined,
    use: (session: SemanticSession) => T | Promise<T>): Promise<T> {
    this.assertTrusted(); assertNotCancelled(token);
    const key = uri.toString();
    this.activeQueries.set(key, (this.activeQueries.get(key) || 0) + 1);
    try {
      return await use(await this.analyze(uri, token));
    } finally {
      const remaining = this.activeQueries.get(key)! - 1;
      if (remaining) this.activeQueries.set(key, remaining);
      else {
        this.activeQueries.delete(key);
        if (uri.scheme === 'file' && !this.findDocument(uri) && this.current(uri)?.analysis.complete) {
          this.recentlyClosed.delete(key);
          this.recentlyClosed.set(key, uri);
        }
        this.releaseClosed(uri);
        this.trimClosed();
      }
    }
  }

  private async analyze(uri: vscode.Uri, token?: vscode.CancellationToken): Promise<SemanticSession> {
    this.assertTrusted(); assertNotCancelled(token);
    const key = uri.toString();
    const cached = this.semanticEntries.get(key);
    if (cached) {
      const session = await awaitWithCancellation(cached.promise, token);
      this.assertCurrent(session);
      assertNotCancelled(token);
      const snapshot = await this.snapshot(uri);
      this.assertCurrent(session);
      assertNotCancelled(token);
      if (snapshot.original !== session.snapshot.original) {
        this.invalidate();
        throw new vscode.CancellationError();
      }
      const rebound = { ...session, snapshot };
      cached.session = rebound;
      return rebound;
    }
    const epoch = this.epoch;
    // Register before reading the snapshot so a check can be cancelled even
    // before its worker starts. Entry identity also excludes replaced requests.
    const entry: SemanticEntry = {
      pending: true,
      promise: Promise.resolve().then(async () => {
        try {
          const snapshot = await this.snapshot(uri);
          if (epoch !== this.epoch || this.semanticEntries.get(key) !== entry) throw new vscode.CancellationError();
          entry.snapshot = snapshot;
          const worker = this.createWorker('semantic', uri);
          entry.worker = worker;
          const analysis = await worker.request<Analysis>('analyze', this.parameters(snapshot));
          const session = { worker, snapshot, analysis, epoch };
          this.assertCurrent(session);
          this.log.appendLine(`[semantic] ${uri.fsPath}: ${analysis.complete ? 'complete' : 'failed'}, ${analysis.annotations.length} annotations, ${analysis.annotations.filter(a => a.kind === 'binding' && a.actual).length} actual binding edges`);
          for (const error of analysis.errors) this.log.appendLine(`[semantic] ${error.message}`);
          for (const issue of analysis.completionIssues) this.log.appendLine(`[completion] ${issue}`);
          entry.session = session;
          await this.publish(session);
          this.assertCurrent(session);
          entry.pending = false;
          this.ready.fire(session);
          this.updateStatus();
          return session;
        } catch (error) {
          const current = this.semanticEntries.get(key) === entry;
          if (current) {
            this.semanticEntries.delete(key);
            this.setDiagnostics(`semantic:${key}`, []);
            this.changed.fire();
            this.updateStatus();
          }
          entry.worker?.dispose();
          if (!this.disposed) this.syncDependencies();
          throw current ? entry.failure || error : new vscode.CancellationError();
        }
      }),
    };
    this.semanticEntries.set(key, entry);
    this.updateStatus();
    const session = await awaitWithCancellation(entry.promise, token);
    this.assertCurrent(session);
    assertNotCancelled(token);
    return this.current(uri) || session;
  }

  async lexical(document: vscode.TextDocument, token?: vscode.CancellationToken): Promise<LexicalSession> {
    this.assertTrusted(); assertNotCancelled(token);
    const key = document.uri.toString();
    const epoch = this.epoch;
    const snapshot = documentSnapshot(document);
    let entry = this.lexicalEntries.get(key);
    if (!entry || entry.epoch !== epoch || entry.stale || entry.text !== snapshot.original) {
      const previous = entry;
      const worker = previous?.worker.running ? previous.worker : this.createWorker('lexical', document.uri);
      const assertQueuedCurrent = () => {
        if (epoch !== this.epoch || next.stale || this.lexicalEntries.get(key) !== next) throw new vscode.CancellationError();
      };
      const next: LexicalEntry = {
        worker, epoch, text: snapshot.original, stale: false, ready: false,
        promise: (previous?.promise.catch(() => undefined) || Promise.resolve()).then(async () => {
          // Wait for the preceding document update, then skip superseded text.
          // Only the latest queued snapshot needs to reach the Racket process.
          assertQueuedCurrent();
          return worker.request<Lexical>('document', this.parameters(snapshot));
        }).then(data => {
          assertQueuedCurrent();
          next.ready = true;
          this.log.appendLine(`[lexical] ${document.uri.fsPath}: ${data.tokens.length} tokens, ${data.ranges.length} balanced ranges`);
          this.setDiagnostics(`reader:${key}`, []);
          return data;
        }).catch(async error => {
          // A failed or cancelled old request must not close a reused worker.
          assertQueuedCurrent();
          this.lexicalEntries.delete(key);
          worker.dispose();
          this.syncDependencies();
          if (!isCancellation(error)) {
            const entries = error instanceof RacketError ? await this.locateErrors([error.details], 'Racket Reader') : [];
            if (epoch !== this.epoch || document.version !== snapshot.version || document.isClosed || this.lexicalEntries.has(key)) {
              throw new vscode.CancellationError();
            }
            this.setDiagnostics(`reader:${key}`, entries);
            this.report(error, document.uri);
          }
          throw error;
        }),
      };
      this.lexicalEntries.set(key, next);
      entry = next;
    }
    const current = entry;
    const assertCurrent = () => {
      if (epoch !== this.epoch || document.isClosed || document.version !== snapshot.version
        || current.stale || this.lexicalEntries.get(key) !== current || !current.worker.running) throw new vscode.CancellationError();
    };
    const data = await current.promise;
    assertCurrent(); assertNotCancelled(token);
    return {
      snapshot, data, assertCurrent,
      // Never expose the mutable worker: every operation belongs to this exact
      // document version, both when it is queued and when its result arrives.
      request: async <T>(method: string, params: unknown, cancellationToken?: vscode.CancellationToken): Promise<T> => {
        assertCurrent(); assertNotCancelled(cancellationToken);
        const result = await current.worker.request<T>(method, params, cancellationToken);
        assertCurrent(); assertNotCancelled(cancellationToken);
        return result;
      },
    };
  }

  private syncDependencies(): void {
    const paths = new Set([...this.workerDependencies.values()].flatMap(paths => paths || []));
    for (const [path, watcher] of this.dependencyWatchers) if (!paths.has(path)) {
      watcher.dispose(); this.dependencyWatchers.delete(path);
    }
    for (const path of paths) {
      if (this.dependencyWatchers.has(path) || path.startsWith('racket-source:')) continue;
      if (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))) continue;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirname(path), basename(path)));
      const changed = (uri: vscode.Uri) => { void this.changedFile(uri).catch(error => this.report(error, uri)); };
      this.dependencyWatchers.set(path, vscode.Disposable.from(watcher,
        watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed)));
    }
  }

  private async locateErrors(errors: BackendError[], source = 'Racket'): Promise<DiagnosticEntry[]> {
    const entries: DiagnosticEntry[] = [];
    for (const error of errors) for (const range of error.locations) {
      const location = await this.location(range);
      if (!location) continue;
      const diagnostic = new vscode.Diagnostic(location.range, error.message, vscode.DiagnosticSeverity.Error);
      diagnostic.source = source;
      entries.push({ uri: location.uri, diagnostic });
    }
    return entries;
  }

  private setDiagnostics(owner: string, entries: DiagnosticEntry[]): void {
    if (entries.length) this.diagnosticContributions.set(owner, entries);
    else this.diagnosticContributions.delete(owner);
    this.refreshDiagnostics();
  }

  private refreshDiagnostics(): void {
    // Several open modules can report the same dependency error. Retain each
    // owner's contribution so closing one editor cannot clear another's error.
    const files = new Map<string, { uri: vscode.Uri; diagnostics: Map<string, vscode.Diagnostic> }>();
    for (const contribution of this.diagnosticContributions.values()) for (const { uri, diagnostic } of contribution) {
      let file = files.get(uri.toString());
      if (!file) { file = { uri, diagnostics: new Map() }; files.set(uri.toString(), file); }
      const key = JSON.stringify([diagnostic.range, diagnostic.message, diagnostic.source, diagnostic.severity]);
      file.diagnostics.set(key, diagnostic);
    }
    this.diagnostics.clear();
    this.diagnostics.set([...files.values()].map(file => [file.uri, [...file.diagnostics.values()]]));
  }

  private async publish(session: SemanticSession): Promise<void> {
    const { snapshot, analysis } = session;
    if (!this.findDocument(snapshot.uri)) return;
    const entries = await this.locateErrors(analysis.errors);
    this.assertCurrent(session);
    if (!this.findDocument(snapshot.uri)) return;
    const key = snapshot.uri.toString();
    if (analysis.complete) {
      this.lastCompletionNames.set(key, analysis.completionNames);
      const source = this.sourcePath(snapshot.uri);
      for (const { kind, at } of analysis.annotations) {
        if (!['unusedBinding', 'unusedRequire'].includes(kind) || at?.source !== source || !snapshot.contains(at)) continue;
        const diagnostic = new vscode.Diagnostic(snapshot.range(at.start, at.end),
          kind === 'unusedBinding' ? 'Unused binding' : 'Unused require', vscode.DiagnosticSeverity.Hint);
        diagnostic.source = 'Check Syntax';
        diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
        entries.push({ uri: snapshot.uri, diagnostic });
      }
    }
    this.setDiagnostics(`semantic:${key}`, entries);
  }

  async location(range: SourceRange): Promise<vscode.Location | undefined> {
    if (!range.source || range.source.startsWith('racket-source:')) return;
    const existing = vscode.workspace.textDocuments.find(doc => !doc.isClosed && this.sourcePath(doc.uri) === range.source);
    const uri = existing?.uri || vscode.Uri.file(range.source);
    try {
      const snapshot = await this.snapshot(uri);
      if (!snapshot.contains(range)) return;
      return new vscode.Location(uri, snapshot.range(range.start, range.end));
    } catch { return; }
  }

  async sourceFiles(token?: vscode.CancellationToken): Promise<vscode.Uri[]> {
    const files = await vscode.workspace.findFiles('**/*', '**/{.git,node_modules,compiled}/**', undefined, token);
    const result = new Map<string, vscode.Uri>();
    const header = Buffer.alloc(4096);
    for (const file of files) {
      assertNotCancelled(token);
      if (/\.(?:rkt|rktl|ss|scm|scrbl|rhm)$/i.test(file.path)) {
        result.set(file.toString(), file);
        continue;
      }
      if (/\.(?:rktd|vsix|zo|dep|png|jpe?g|gif|pdf|zip|woff2?|ttf|mp[34])$/i.test(file.path)) continue;
      const document = this.findDocument(file);
      let text: string;
      if (document) text = document.getText(new vscode.Range(new vscode.Position(0, 0), document.positionAt(header.length)));
      else {
        const handle = await fs.open(file.fsPath, 'r');
        try {
          const { bytesRead } = await handle.read(header, 0, header.length, 0);
          text = header.toString('utf8', 0, bytesRead);
        } finally { await handle.close(); }
      }
      if (!text.includes('\0') && /^\s*(?:(?:;[^\n]*|#![^\n]*)(?:\n|$)\s*)*(?:#(?:lang|reader)\b|\(module\b)/.test(text)) {
        result.set(file.toString(), file);
      }
    }
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isClosed && isRacket(doc) && doc.uri.scheme === 'file' && !/\.rktd$/i.test(doc.fileName)) {
        result.set(doc.uri.toString(), doc.uri);
      }
    }
    assertNotCancelled(token);
    return [...result.values()];
  }

  private releaseClosed(uri: vscode.Uri): void {
    const key = uri.toString();
    if (this.recentlyClosed.has(key) || this.activeQueries.has(key) || this.findDocument(uri)) return;
    this.semanticEntries.get(key)?.worker?.dispose();
    this.semanticEntries.delete(key);
    this.lexicalEntries.get(key)?.worker.dispose();
    this.lexicalEntries.delete(key);
    this.syncDependencies();
  }

  private trimClosed(): void {
    // Keep a small recent-file cache without retaining a process pair for every
    // file visited during a long session. Active cross-file queries pin theirs.
    for (const [key, uri] of this.recentlyClosed) {
      if (this.recentlyClosed.size <= 8) break;
      if (this.activeQueries.has(key)) continue;
      this.recentlyClosed.delete(key);
      this.releaseClosed(uri);
    }
  }

  report(error: unknown, uri?: vscode.Uri): void {
    if (this.disposed || isCancellation(error)) return;
    if (error instanceof Error) {
      if (this.reportedErrors.has(error)) return;
      this.reportedErrors.add(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    this.log.appendLine(uri ? `${uri.fsPath}: ${message}` : message);
    if (!uri || uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) {
      this.updateStatus('$(error) Racket: Error');
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.revision++;
    this.clearCaches();
    this.lastCompletionNames.clear();
    for (const item of this.disposables) item.dispose();
    this.changed.dispose(); this.ready.dispose(); this.diagnostics.dispose(); this.log.dispose(); this.status.dispose();
  }
}
