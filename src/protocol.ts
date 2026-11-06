import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { homedir } from 'node:os';

export interface SourceRange { source: string | false; start: number; end: number }
export interface BackendError { message: string; locations: SourceRange[] }
export class RacketError extends Error {
  constructor(readonly details: BackendError) { super(details.message); }
}
export interface Annotation {
  kind: string; at?: SourceRange; from?: SourceRange; to?: SourceRange;
  id?: number | false; actual?: boolean; phase?: unknown; require?: boolean | string;
  name?: string; path?: string; submodules?: string[]; phaseSpace?: unknown;
  text?: string; type?: string; style?: string; label?: string;
  tag?: string; prefix?: string; prefixAt?: SourceRange | false;
  form?: string; symbolKind?: 'module' | 'macro' | 'function' | 'variable';
  span?: SourceRange; operatorAt?: SourceRange; definitionAt?: SourceRange;
  definitionPhases?: unknown[];
}
export interface DocumentParameters {
  path: string;
  text: string;
  roots: string[];
  documents: { path: string; text: string }[];
}
export interface ImportBinding {
  name: string; original: string; renamed: boolean; prefix: string;
  phase: unknown; space: unknown; module: string;
  at: SourceRange | false; localAt: SourceRange | false; originalAt: SourceRange | false;
}
export interface Analysis {
  complete: boolean; annotations: Annotation[]; errors: BackendError[];
  mode: 'module' | 'syntax';
  dependencies: string[]; completionIssues: string[];
  imports: ImportBinding[];
  completionNames: CompletionName[];
}
export interface CompletionName { name: string; insert: string }
export interface CompletionCandidate extends CompletionName { kind: string; origin: string; phase: unknown; space: unknown }
export interface LexToken {
  start: number; end: number; attributes: { type: string; 'comment?'?: boolean; [key: string]: unknown };
  paren: string | false; backup: number;
}
export interface ExpressionRange { start: number; end: number; openEnd: number; closeStart: number }
export interface ReaderNode {
  start: number; end: number; kind: 'list' | 'dotted' | 'prefix' | 'atom' | 'opaque';
  name: string | false; children: ReaderNode[];
  atomKind: 'symbol' | 'keyword' | false;
}
export interface Lexical {
  tokens: LexToken[]; ranges: ExpressionRange[];
  comments: { start: number; end: number; bodyStart: number }[];
  structure: { forms: ReaderNode[]; complete: boolean; headerEnd: number | false };
}
export interface BackendEdit { start: number; end: number; text: string }
export interface RenameResult { name: string; text: string; conflicts: number[] }

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  subscription?: vscode.Disposable;
}
type WorkerMessage =
  | { event: 'output'; channel: string; data: string }
  | { id: number; result?: unknown; error?: BackendError; dependencies?: string[] | false };

export class Worker implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, PendingRequest>();
  // Cancelling a caller stops its wait, not the request already sent to Racket.
  private inFlight = new Set<number>();
  private stopReason?: Error;
  private decoders = new Map<string, StringDecoder>();
  readonly exited = new vscode.EventEmitter<Error>();
  readonly dependenciesChanged = new vscode.EventEmitter<string[] | undefined>();
  get running(): boolean { return !this.stopReason; }
  get busy(): boolean { return this.inFlight.size > 0; }

  constructor(context: vscode.ExtensionContext, mode: 'semantic' | 'lexical' | 'organize', resource: vscode.Uri, log: vscode.OutputChannel,
    private documents?: () => DocumentParameters['documents']) {
    const command = vscode.workspace.getConfiguration('racketWorkbench', resource).get<string>('executable', 'racket');
    log.appendLine(`[${mode}] Starting ${command}: ${resource.fsPath}`);
    this.process = spawn(command, [context.asAbsolutePath('dist/backend/main.rkt'), mode], {
      cwd: vscode.workspace.getWorkspaceFolder(resource)?.uri.fsPath || homedir(),
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on('line', line => {
      if (!this.running) return;
      try {
        const message = JSON.parse(line) as WorkerMessage;
        if (!message || typeof message !== 'object') throw new Error('Expected a response object');
        if ('event' in message) {
          if (message.event !== 'output' || typeof message.channel !== 'string' || typeof message.data !== 'string') {
            throw new Error('Invalid output event');
          }
          let decoder = this.decoders.get(message.channel);
          if (!decoder) {
            decoder = new StringDecoder('utf8');
            this.decoders.set(message.channel, decoder);
          }
          log.append(decoder.write(Buffer.from(message.data, 'base64')));
          return;
        }
        if (!this.inFlight.delete(message.id) || !('result' in message || message.error)) {
          throw new Error('Invalid request response');
        }
        this.dependenciesChanged.fire(message.dependencies || undefined);
        const request = this.takeRequest(message.id);
        if (!request) return;
        if (message.error) {
          log.appendLine(`[${mode}] ${message.error.message}`);
          request.reject(new RacketError(message.error));
        } else request.resolve(message.result);
      } catch (error) {
        this.stop(new Error(`Invalid Racket protocol response: ${String(error)}`));
      }
    });
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', text => { if (this.running) log.append(text); });
    this.process.stdin.on('error', error => this.stop(error));
    this.process.on('error', error => this.stop(new Error(`Unable to start Racket: ${error.message}`)));
    this.process.on('close', (code, signal) => {
      lines.close();
      if (this.running) for (const decoder of this.decoders.values()) log.append(decoder.end());
      this.decoders.clear();
      this.stop(new Error(`Racket ${mode} process exited (${signal || code})`));
    });
  }

  async request<T>(method: string, params: unknown = {}, token?: vscode.CancellationToken): Promise<T> {
    if (token?.isCancellationRequested) throw new vscode.CancellationError();
    if (this.stopReason) throw this.stopReason;
    const id = ++this.nextId;
    // Prepared requests own their overlays; later callbacks collect fresh text.
    if (this.documents && params && typeof params === 'object' && !('documents' in params)) {
      params = { ...params, documents: this.documents() };
    }
    const payload = JSON.stringify({ id, method, params }) + '\n';
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest = { resolve: value => resolve(value as T), reject };
      this.pending.set(id, request);
      request.subscription = token?.onCancellationRequested(() => {
        this.takeRequest(id)?.reject(new vscode.CancellationError());
      });
      this.inFlight.add(id);
      this.process.stdin.write(payload, error => {
        if (error) this.stop(error);
      });
    });
  }

  private takeRequest(id: number): PendingRequest | undefined {
    const request = this.pending.get(id);
    this.pending.delete(id);
    request?.subscription?.dispose();
    return request;
  }

  private stop(error: Error): void {
    if (!this.running) return;
    this.stopReason = error;
    this.inFlight.clear();
    for (const id of this.pending.keys()) this.takeRequest(id)?.reject(error);
    this.exited.fire(error);
    this.exited.dispose();
    this.dependenciesChanged.dispose();
    const child = this.process;
    const pid = child.pid;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { child.kill(); }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      }, 1500);
      timer.unref();
    }
  }

  dispose(): void { this.stop(new vscode.CancellationError()); }
}
