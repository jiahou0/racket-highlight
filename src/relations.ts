import * as vscode from 'vscode';
import { basename } from 'node:path';
import { Workspace, SemanticSession } from './workspace';
import { Annotation, SourceRange } from './protocol';
import { atPosition, isCancellation, isRacket, rangeKey } from './documents';
import { bindingKeys, connected } from './bindings';

interface Node { label: string; description?: string; location?: SourceRange; children?: Node[]; command?: vscode.Command }
const categories: [string, string[]][] = [
  ['Bindings', ['binding']], ['Tail Positions', ['tail']], ['Definitions', ['definition', 'jump']],
  ['Imports', ['require', 'prefix', 'language']], ['Documentation', ['documentation']],
  ['Unused', ['unusedBinding', 'unusedRequire']], ['Styles', ['style', 'textType', 'identifierKind']],
  ['Messages', ['hover']],
];

export class Relations implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private session?: SemanticSession;
  private subscriptions: vscode.Disposable[] = [];
  private documents = new Map<string, string>();
  private styles = new Map<string, vscode.TextEditorDecorationType>();
  private revision = 0;
  private followCursor = true;
  private readonly view: vscode.TreeView<Node>;
  constructor(private workspace: Workspace) {
    const view = this.view = vscode.window.createTreeView('racket.relations', { treeDataProvider: this, showCollapseAll: true });
    void vscode.commands.executeCommand('setContext', 'racket.relations.followCursor', true);
    const refresh = () => {
      const editor = vscode.window.activeTextEditor;
      this.session = editor && workspace.current(editor.document.uri);
      this.emitter.fire(undefined);
      this.decorate();
    };
    this.subscriptions.push(view,
      view.onDidChangeVisibility(() => {
        if (view.visible) refresh();
        else this.clearDecorations();
      }),
      workspace.ready.event(session => {
        if (session.snapshot.uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) refresh();
      }),
      workspace.changed.event(refresh),
      vscode.window.onDidChangeActiveTextEditor(refresh),
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (!view.visible || event.textEditor !== vscode.window.activeTextEditor) return;
        if (this.followCursor) this.emitter.fire(undefined);
        this.decorate();
      }),
      ...([['racket.relations.followCursor', true], ['racket.relations.showAll', false]] as const).map(([command, follow]) =>
        vscode.commands.registerCommand(command, () => {
          this.followCursor = follow;
          void vscode.commands.executeCommand('setContext', 'racket.relations.followCursor', this.followCursor);
          this.emitter.fire(undefined);
        })),
      vscode.commands.registerCommand('racket.relations', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isRacket(editor.document)) return;
        try {
          const session = await workspace.available(editor.document.uri);
          if (vscode.window.activeTextEditor !== editor) throw new vscode.CancellationError();
          this.session = session;
          this.emitter.fire(undefined);
          this.decorate();
          await vscode.commands.executeCommand('racket.relations.focus');
        } catch (error) { this.report(error); }
      }),
      vscode.commands.registerCommand('racket.openLocation', async (range: SourceRange) => {
        try {
          const location = await workspace.location(range);
          if (!location) throw new Error('Source location is unavailable');
          await vscode.window.showTextDocument(location.uri, { selection: location.range });
        } catch (error) { this.report(error); }
      }),
      vscode.commands.registerCommand('racket.openRelationDefinition', async (range: SourceRange) => {
        try {
          const loc = await workspace.location(range);
          if (!loc) throw new Error('Definition source is unavailable');
          const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>('vscode.executeDefinitionProvider', loc.uri, loc.range.start);
          const targets = definitions?.map(target => 'targetUri' in target ? new vscode.Location(target.targetUri, target.targetSelectionRange || target.targetRange) : target);
          if (!targets?.length) throw new Error('Definition source is unavailable');
          if (targets.length === 1) await vscode.window.showTextDocument(targets[0].uri, { selection: targets[0].range });
          else await vscode.commands.executeCommand('editor.action.peekLocations', loc.uri, loc.range.start, targets);
        } catch (error) { this.report(error); }
      }),
      vscode.commands.registerCommand('racket.openRelationDocumentation', (path: string, tag: string) =>
        vscode.env.openExternal(vscode.Uri.file(path).with({ fragment: tag }))),
      vscode.workspace.registerTextDocumentContentProvider('racket-syntax', { provideTextDocumentContent: uri => this.documents.get(uri.toString()) || '' }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.uri.scheme === 'racket-syntax') this.documents.delete(document.uri.toString());
      }),
      vscode.commands.registerCommand('racket.inspect', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !isRacket(editor.document)) return;
        try {
          const session = await workspace.available(editor.document.uri);
          if (!session) throw new Error('No current semantic analysis');
          const uri = vscode.Uri.from({ scheme: 'racket-syntax', path: `/${basename(editor.document.fileName)}-${++this.revision}.json` });
          this.documents.set(uri.toString(), JSON.stringify({ document: editor.document.uri.toString(), version: session.snapshot.version, ...session.analysis }, null, 2));
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true, viewColumn: vscode.ViewColumn.Beside });
        } catch (error) { this.report(error); }
      }),
    );
  }
  private report(error: unknown): void { if (!isCancellation(error)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  getTreeItem(node: Node): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.children?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.command = node.command || (node.location ? { command: 'racket.openLocation', title: 'Open', arguments: [node.location] } : undefined);
    return item;
  }
  getChildren(node?: Node): Node[] {
    if (node) return node.children || [];
    if (!this.session) return [];
    const session = this.session;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== session.snapshot.uri.toString()
      || editor.document.version !== session.snapshot.version) return [];
    if (!session.analysis.complete) return session.analysis.errors.map(error => ({ label: error.message, location: error.locations[0] }));
    const annotations = this.followCursor ? this.focused(session, session.snapshot.offset(editor.selection.active)) : session.analysis.annotations;
    return categories.map(([label, kinds]) => ({ label: this.followCursor && label === 'Bindings' ? 'References' : label,
      children: annotations.filter(a => kinds.includes(a.kind)).map(a => this.node(a, session)),
    })).filter(group => group.children.length);
  }
  private focused(session: SemanticSession, position: number): Annotation[] {
    const source = this.workspace.sourcePath(session.snapshot.uri);
    const annotations = session.analysis.annotations;
    const seeds = annotations.filter(a => !['application', 'outline', 'sourceForm'].includes(a.kind))
      .flatMap(a => [a.at, a.from, a.to].filter((range): range is SourceRange => !!range && atPosition(range, source, position)))
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    const initial = connected(annotations, seeds.slice(0, 1));
    const initialRanges = new Set(initial.ranges.map(rangeKey));
    const keys = new Set(annotations.filter(a => a.at && initialRanges.has(rangeKey(a.at))).flatMap(bindingKeys));
    const related = annotations.flatMap(a => a.at && bindingKeys(a).some(key => keys.has(key)) ? [a.at] : []);
    const group = connected(annotations, [...initial.ranges, ...related]);
    const selectedRanges = new Set(group.ranges.map(rangeKey));
    const touches = (range: SourceRange | undefined) => !!range && (atPosition(range, source, position)
      || selectedRanges.has(rangeKey(range)));
    const imports = annotations.flatMap(a => a.kind === 'binding' && a.actual && a.require && a.from && touches(a.to) ? [a.from] : []);
    const application = annotations.flatMap(a => a.kind === 'application' && a.at && atPosition(a.at, source, position) ? [a.at] : [])
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    const tailAt = (range: SourceRange | undefined) => !!range && (atPosition(range, source, position)
      || !!application && range.source === application.source && application.start <= range.start && range.start < application.end);
    return annotations.filter(({ kind, at, from, to }) => kind === 'tail' ? tailAt(from) || tailAt(to)
      : touches(at) || touches(from) || touches(to)
        || !!at && imports.some(range => range.source === at.source && range.start <= at.start && at.end <= range.end));
  }
  private node(annotation: Annotation, session: SemanticSession): Node {
    const describe = (range: SourceRange) => {
      if (range.source === this.workspace.sourcePath(session.snapshot.uri) && session.snapshot.contains(range)) {
        const at = session.snapshot.position(range.start);
        const position = `${at.line + 1}:${at.character + 1}`;
        return range.end > range.start ? `${session.snapshot.slice(range.start, range.end).replace(/\s+/g, ' ')} · ${position}` : position;
      }
      return `${range.source ? basename(range.source) : 'Source'}:${range.start}`;
    };
    if (annotation.from && annotation.to) {
      return { label: `${describe(annotation.from)} → ${describe(annotation.to)}`,
        description: annotation.kind === 'tail' ? undefined : [annotation.actual ? 'Binding' : 'Predicted', `phase ${JSON.stringify(annotation.phase)}`, annotation.require === 'module-lang' ? '#lang' : annotation.require ? 'require' : ''].filter(Boolean).join(' · '),
        location: annotation.to,
        children: [{ label: 'From', description: describe(annotation.from), location: annotation.from }, { label: 'To', description: describe(annotation.to), location: annotation.to }],
      };
    }
    const label = annotation.name || annotation.prefix || annotation.text || annotation.style || annotation.type || (annotation.at ? describe(annotation.at) : annotation.kind);
    const children: Node[] = [];
    if (annotation.path) children.push({ label: basename(annotation.path), description: annotation.path, location: { source: annotation.path, start: 0, end: 0 } });
    if (annotation.prefixAt) children.push({ label: 'Prefix', location: annotation.prefixAt });
    return { label, location: annotation.at,
      command: annotation.kind === 'jump' && annotation.at ? { command: 'racket.openRelationDefinition', title: 'Open Definition', arguments: [annotation.at] }
        : annotation.kind === 'documentation' && annotation.path ? { command: 'racket.openRelationDocumentation', title: 'Open Documentation', arguments: [annotation.path, String(annotation.tag || '')] } : undefined,
      description: annotation.phaseSpace !== undefined ? `phase/space ${JSON.stringify(annotation.phaseSpace)}` : annotation.kind,
      children };
  }
  private clearDecorations(): void {
    for (const editor of vscode.window.visibleTextEditors) for (const style of this.styles.values()) editor.setDecorations(style, []);
  }
  private decorate(): void {
    if (!this.view.visible) return;
    this.clearDecorations();
    const editor = vscode.window.activeTextEditor, session = this.session;
    if (!editor || !session || !session.analysis.complete || editor.document.uri.toString() !== session.snapshot.uri.toString()
      || editor.document.version !== session.snapshot.version) return;
    const source = this.workspace.sourcePath(editor.document.uri), position = session.snapshot.offset(editor.selection.active);
    const ranges = new Map<string, vscode.Range[]>();
    for (const a of session.analysis.annotations) {
      if (a.kind !== 'textType' || !a.at || !atPosition(a.at, source, position) || !session.snapshot.contains(a.at)) continue;
      const key = `type:${a.type}`;
      const color = new vscode.ThemeColor(a.type === 'document-identifier' ? 'editor.hoverHighlightBackground' : a.type === 'unused-identifier' ? 'editor.wordHighlightStrongBackground' : 'editor.wordHighlightBackground');
      if (!this.styles.has(key)) this.styles.set(key, vscode.window.createTextEditorDecorationType({ backgroundColor: color, rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed }));
      const list = ranges.get(key) || []; list.push(session.snapshot.range(a.at.start, a.at.end)); ranges.set(key, list);
    }
    for (const [key, entries] of ranges) editor.setDecorations(this.styles.get(key)!, entries);
  }
  dispose(): void {
    for (const item of this.subscriptions) item.dispose();
    for (const style of this.styles.values()) style.dispose();
    this.emitter.dispose();
  }
}
