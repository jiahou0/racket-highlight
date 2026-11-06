import * as vscode from 'vscode';
import { basename, dirname, resolve } from 'node:path';
import { Workspace } from './workspace';
import { isCancellation, isRacket } from './documents';
import { expressionAt } from './structural';

interface ReplSession {
  uri: vscode.Uri;
  terminal: vscode.Terminal;
  sourceText: string;
}

function shellArgument(value: string, powershell: boolean): string {
  if (!powershell && /^[a-zA-Z0-9_./:@,+-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, powershell ? "''" : "'\\''") + "'";
}

async function shellIntegration(terminal: vscode.Terminal): Promise<vscode.TerminalShellIntegration> {
  if (terminal.shellIntegration) return terminal.shellIntegration;
  return new Promise((resolve, reject) => {
    const finish = (result: vscode.TerminalShellIntegration | Error) => {
      clearTimeout(timeout); ready.dispose(); closed.dispose();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const ready = vscode.window.onDidChangeTerminalShellIntegration(event => {
      if (event.terminal === terminal) finish(event.shellIntegration);
    });
    const closed = vscode.window.onDidCloseTerminal(other => {
      if (other === terminal) finish(new vscode.CancellationError());
    });
    const timeout = setTimeout(() => finish(new Error('Shell integration is unavailable in the run terminal')), 5000);
  });
}

export class Runtime implements vscode.Disposable {
  private sessions = new Map<string, ReplSession>();
  private active?: ReplSession;
  private runTerminal?: vscode.Terminal;
  private runExecution?: vscode.TerminalShellExecution;
  private pendingRun = false;
  private subscriptions: vscode.Disposable[] = [];

  constructor(private workspace: Workspace) {
    const command = (name: string, action: (uri?: vscode.Uri) => unknown) => {
      this.subscriptions.push(vscode.commands.registerCommand(name, async (uri?: vscode.Uri) => {
        try {
          await action(uri);
        } catch (error) {
          if (!isCancellation(error)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
      }));
    };
    command('racket.run', uri => this.runInTerminal(uri));
    command('racket.loadFileInRepl', uri => this.loadInRepl(uri));
    command('racket.restart', uri => this.loadInRepl(uri || this.selectedSession()?.uri));
    command('racket.evaluate', () => this.evaluate());
    command('racket.interrupt', () => this.selectedSession()?.terminal.sendText('\x03', false));
    command('racket.stop', () => { const session = this.selectedSession(); if (session) this.close(session); });
    this.subscriptions.push(vscode.window.onDidCloseTerminal(terminal => {
      for (const [key, session] of this.sessions) if (session.terminal === terminal) this.sessions.delete(key);
      if (this.active?.terminal === terminal) this.active = undefined;
      if (this.runTerminal === terminal) { this.runTerminal = undefined; this.runExecution = undefined; }
    }));
    this.subscriptions.push(
      vscode.window.onDidStartTerminalShellExecution(event => {
        if (event.terminal === this.runTerminal) this.runExecution = event.execution;
      }),
      vscode.window.onDidEndTerminalShellExecution(event => {
        if (event.execution === this.runExecution) this.runExecution = undefined;
      }),
    );
  }

  private selectedSession(): ReplSession | undefined {
    return [...this.sessions.values()].find(session => session.terminal === vscode.window.activeTerminal)
      || this.sessions.get(vscode.window.activeTextEditor?.document.uri.toString() || '') || this.active;
  }

  private close(session: ReplSession): void {
    this.sessions.delete(session.uri.toString());
    if (this.active === session) this.active = undefined;
    session.terminal.dispose();
  }

  private async fileDocument(uri?: vscode.Uri): Promise<vscode.TextDocument> {
    this.workspace.assertTrusted();
    let document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !isRacket(document)) throw new Error('No Racket document selected');
    if (document.uri.scheme !== 'file') {
      if (!document.isUntitled) throw new Error('File has no local filesystem path');
      await vscode.window.showTextDocument(document, { preview: false });
      if (!await document.save()) throw new vscode.CancellationError();
      document = vscode.window.activeTextEditor?.document;
      if (!document || document.uri.scheme !== 'file' || !isRacket(document)) throw new Error('Module has no file path');
    }
    this.workspace.assertTrusted();
    return document;
  }

  private async runInTerminal(uri?: vscode.Uri): Promise<void> {
    const document = await this.fileDocument(uri);
    if (document.isDirty && !await document.save()) throw new vscode.CancellationError();
    this.workspace.assertTrusted();
    const config = vscode.workspace.getConfiguration('racketWorkbench', document.uri);
    const executable = config.get<string>('executable', 'racket');
    const args = [document.uri.fsPath, ...config.get<string[]>('arguments', [])];
    const cwd = resolve(dirname(document.uri.fsPath), config.get<string>('workingDirectory', ''));
    if (this.pendingRun || this.runExecution) {
      this.runTerminal?.show();
      throw new Error('The run terminal is busy');
    }
    this.pendingRun = true;
    try {
      const powershell = process.platform === 'win32';
      if (!this.runTerminal || this.runTerminal.exitStatus) {
        // Own a regular shell so repeated runs return to its prompt. An explicit
        // shell also makes argument quoting independent of the default profile.
        this.runTerminal = vscode.window.createTerminal({
          name: 'Racket Run', cwd,
          shellPath: powershell ? 'powershell.exe' : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
          shellArgs: powershell ? ['-NoLogo'] : ['-l'],
          location: vscode.TerminalLocation.Panel,
          isTransient: true,
        });
      }
      const terminal = this.runTerminal;
      terminal.show();
      const integration = await shellIntegration(terminal);
      this.workspace.assertTrusted();
      if (this.runTerminal !== terminal) throw new vscode.CancellationError();
      // Do not interrupt a program or send a command to its standard input.
      if (this.runExecution) throw new Error('The run terminal is busy');
      const invocation = (powershell ? '& ' : '') + [executable, ...args].map(value => shellArgument(value, powershell)).join(' ');
      const sameDirectory = integration.cwd?.scheme === 'file' && integration.cwd.fsPath === cwd;
      let commandLine = invocation;
      if (!sameDirectory) {
        commandLine = powershell
          ? `Set-Location -LiteralPath ${shellArgument(cwd, true)}; if ($?) { ${invocation} }`
          : `cd -- ${shellArgument(cwd, false)} && ${invocation}`;
      }
      this.runExecution = integration.executeCommand(commandLine);
    } finally { this.pendingRun = false; }
  }

  private async loadInRepl(uri?: vscode.Uri): Promise<void> {
    const document = await this.fileDocument(uri);
    if (document.isDirty && !await document.save()) throw new vscode.CancellationError();
    this.workspace.assertTrusted();
    const config = vscode.workspace.getConfiguration('racketWorkbench', document.uri);
    // Quote the file path as a Racket string literal. The expression is passed
    // as one argv, never interpolated into a shell command.
    const expression = `(enter! (file ${JSON.stringify(document.uri.fsPath)}))`;
    const programArgs = config.get<string[]>('arguments', []);
    const previous = this.sessions.get(document.uri.toString());
    if (previous) this.close(previous);
    const terminal = vscode.window.createTerminal({
      name: `Racket REPL: ${basename(document.uri.fsPath)}`,
      shellPath: config.get<string>('executable', 'racket'),
      shellArgs: ['--repl', '--eval', expression, ...(programArgs.length ? ['--', ...programArgs] : [])],
      cwd: resolve(dirname(document.uri.fsPath), config.get<string>('workingDirectory', '')),
      location: vscode.TerminalLocation.Panel,
      isTransient: true,
    });
    const session = { uri: document.uri, terminal, sourceText: document.getText() };
    this.sessions.set(document.uri.toString(), session);
    this.active = session;
    terminal.show();
  }

  private async evaluate(): Promise<void> {
    this.workspace.assertTrusted();
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isRacket(editor.document)) throw new Error('No Racket document selected');
    const document = editor.document;
    const selection = editor.selection;
    const session = this.sessions.get(document.uri.toString());
    if (!session || session.terminal.exitStatus) throw new Error('Load the file in the REPL first');
    if (session.sourceText !== document.getText()) throw new Error('Reload the edited file in the REPL first');
    const lexical = await this.workspace.lexical(document);
    const expression = selection.isEmpty ? await expressionAt(lexical, lexical.snapshot.offset(selection.active)) : undefined;
    lexical.assertCurrent();
    if (vscode.window.activeTextEditor !== editor
      || !editor.selection.isEqual(selection) || this.sessions.get(document.uri.toString()) !== session
      || session.terminal.exitStatus) throw new vscode.CancellationError();
    const range = expression ? lexical.snapshot.range(expression.start, expression.end) : selection;
    if (range.isEmpty) return;
    session.terminal.show(true);
    this.active = session;
    session.terminal.sendText(document.getText(range));
  }

  dispose(): void {
    this.runTerminal?.dispose();
    for (const session of this.sessions.values()) session.terminal.dispose();
    this.runTerminal = undefined;
    this.runExecution = undefined;
    this.active = undefined;
    this.sessions.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}
