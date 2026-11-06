import * as vscode from 'vscode';
import { SemanticSession, Workspace } from './workspace';
import { LexToken, SourceRange } from './protocol';
import { rangeKey } from './documents';

const tokenTypes = ['comment', 'string', 'number', 'keyword', 'regexp', 'operator', 'variable', 'macro', 'parameter', 'function',
  'racketLexical', 'racketImported', 'racketFree', 'racketMutated', 'racketMyObligation',
  'racketTheirObligation', 'racketBothObligations', 'racketUnknownObligation', 'racketDatum', 'racketConstant'];
const tokenModifiers = ['declaration', 'documentation'];
const legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers);
const semanticStyles: Record<string, string> = {
  'drracket:check-syntax:lexically-bound': 'racketLexical', 'drracket:check-syntax:imported': 'racketImported',
  'drracket:check-syntax:free-variable': 'racketFree', 'drracket:check-syntax:set!d': 'racketMutated',
  'drracket:check-syntax:my-obligation-style-pref': 'racketMyObligation',
  'drracket:check-syntax:their-obligation-style-pref': 'racketTheirObligation',
  'drracket:check-syntax:both-obligation-style-pref': 'racketBothObligations',
  'drracket:check-syntax:unk-obligation-style-pref': 'racketUnknownObligation',
};

interface PaintSpan {
  start: number; end: number;
  kind: 'style' | 'macro' | 'parameter' | 'function' | 'datum' | 'declaration' | 'unused';
  type?: string;
}
interface Coloring { text: string; spans: PaintSpan[] }
interface ColoringCache { original: Coloring; current: Coloring }

// Rendering may outlive analysis. Keep only visual styles and UTF-16 ranges here,
// never bindings, callbacks, diagnostics, or a semantic worker.
function coloringFor(session: SemanticSession, source: string): Coloring {
  const { snapshot, analysis } = session;
  const spans: PaintSpan[] = [];
  const add = (at: SourceRange | undefined, kind: PaintSpan['kind'], type?: string) => {
    if (!at || at.source !== source || !snapshot.contains(at) || at.start === at.end) return;
    spans.push({ start: snapshot.rawOffset(at.start), end: snapshot.rawOffset(at.end), kind, type });
  };
  const parameters = new Set<string>();
  const functions = new Set<string>();
  for (const { kind, type, at } of analysis.annotations) {
    if (kind !== 'identifierKind' || !at) continue;
    if (type === 'parameter') parameters.add(rangeKey(at));
    if (type === 'function') functions.add(rangeKey(at));
  }
  for (const a of analysis.annotations) {
    if (a.kind === 'style') {
      const type = semanticStyles[a.style || ''];
      if (type) add(a.at, 'style', type);
    }
    if (a.kind === 'definition') add(a.at, 'declaration');
    if (a.kind === 'unusedBinding' || a.kind === 'unusedRequire') add(a.at, 'unused');
    if (a.kind === 'identifierKind' && a.type === 'datum') add(a.at, 'datum');
    if (a.kind === 'identifierKind' && (a.type === 'parameter' || a.type === 'function')) {
      add(a.at, a.type); add(a.at, 'declaration');
    }
    if (a.kind === 'identifierKind' && a.type === 'macro') add(a.at, 'macro');
    if (a.kind === 'binding' && a.actual && !a.require && a.from) {
      const definition = rangeKey(a.from);
      if (parameters.has(definition)) add(a.to, 'parameter');
      if (functions.has(definition)) add(a.to, 'function');
    }
  }
  return { text: snapshot.original, spans };
}

function moveColoring(coloring: Coloring, changes: readonly vscode.TextDocumentContentChangeEvent[]): Coloring {
  let { text, spans } = coloring;
  // All offsets refer to the old document; apply edits from right to left.
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    const start = change.rangeOffset, end = start + change.rangeLength;
    const delta = change.text.length - change.rangeLength;
    const insertsNonWhitespace = start === end && change.text.trim().length > 0;
    spans = spans.flatMap(span => {
      if (insertsNonWhitespace && span.start <= start && start <= span.end) return [];
      if (end <= span.start) return [{ ...span, start: span.start + delta, end: span.end + delta }];
      if (start >= span.end) return [span];
      return [];
    });
    text = text.slice(0, start) + change.text + text.slice(end);
  }
  return { text, spans };
}

function lexicalType(token: LexToken): string | undefined {
  if (token.attributes['comment?']) return 'comment';
  switch (token.attributes.type) {
    case 'comment': case 'sexp-comment': return 'comment';
    case 'string': return 'string';
    case 'constant': case 'hash-colon-keyword': return 'racketConstant';
    case 'keyword': return 'keyword';
    default: return undefined;
  }
}

export function registerHighlighting(workspace: Workspace): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { language: 'racket' };
  const changed = new vscode.EventEmitter<void>();
  const colors = new Map<string, ColoringCache>();
  const bindingRanges = new Map<string, { version: number; parameters: vscode.Range[]; functions: vscode.Range[] }>();
  // Keep the font reset in theme CSS: top-level fontStyle can route the whole
  // decoration through VS Code's font handling and lose its foreground color.
  const parameterStyle = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('racketWorkbench.parameterForeground'),
    light: { fontStyle: 'normal' }, dark: { fontStyle: 'normal' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const functionStyle = vscode.window.createTextEditorDecorationType({
    color: new vscode.ThemeColor('racketWorkbench.functionForeground'),
    light: { fontStyle: 'normal' }, dark: { fontStyle: 'normal' },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  // The same inline style owns fresh and retained fading. Its explicit priority
  // overrides native Unnecessary opacity while the diagnostic is still present.
  const faded = vscode.window.createTextEditorDecorationType({
    opacity: '0.667 !important', rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const refreshDecorations = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const document = editor.document;
      const config = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId });
      const coloring = colors.get(document.uri.toString())?.current;
      const ranges = new Map<string, vscode.Range>();
      if (vscode.workspace.isTrusted && document.languageId === 'racket' && coloring && coloring.text === document.getText()
        && config.get<boolean>('showUnused', true)) {
        for (const span of coloring.spans) if (span.kind === 'unused') {
          ranges.set(`${span.start}:${span.end}`, new vscode.Range(document.positionAt(span.start), document.positionAt(span.end)));
        }
      }
      editor.setDecorations(faded, [...ranges.values()]);
      const bindings = bindingRanges.get(document.uri.toString());
      const semanticEnabled = config.get<boolean | string>('semanticHighlighting.enabled') !== false;
      const current = vscode.workspace.isTrusted && semanticEnabled && bindings?.version === document.version ? bindings : undefined;
      editor.setDecorations(parameterStyle, current?.parameters || []);
      editor.setDecorations(functionStyle, current?.functions || []);
    }
  };
  const subscriptions: vscode.Disposable[] = [changed, faded, parameterStyle, functionStyle,
    workspace.changed.event(() => changed.fire()),
    workspace.ready.event(session => {
      const uri = session.snapshot.uri;
      if (session.analysis.complete && vscode.workspace.textDocuments.some(doc => !doc.isClosed && doc.uri.toString() === uri.toString())) {
        const coloring = coloringFor(session, workspace.sourcePath(uri));
        colors.set(uri.toString(), { original: coloring, current: coloring });
      }
      refreshDecorations();
      changed.fire();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length) return;
      const cached = colors.get(event.document.uri.toString());
      if (!cached) return;
      const text = event.document.getText();
      if (text === cached.original.text) cached.current = cached.original;
      else {
        const next = moveColoring(cached.current, event.contentChanges);
        cached.current = next.text === text ? next : { text, spans: [] };
      }
      refreshDecorations();
      changed.fire();
    }),
    vscode.workspace.onDidOpenTextDocument(document => {
      const cached = colors.get(document.uri.toString());
      if (!cached) return;
      const text = document.getText();
      if (text === cached.original.text) cached.current = cached.original;
      else if (text !== cached.current.text) cached.current = { text, spans: [] };
      refreshDecorations();
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme !== 'file') colors.delete(document.uri.toString());
      bindingRanges.delete(document.uri.toString());
    }),
    vscode.window.onDidChangeVisibleTextEditors(refreshDecorations),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('editor.showUnused') || event.affectsConfiguration('editor.semanticHighlighting.enabled')) {
        refreshDecorations();
      }
    }),
  ];
  subscriptions.push(vscode.languages.registerDocumentSemanticTokensProvider(selector, {
    onDidChangeSemanticTokens: changed.event,
    async provideDocumentSemanticTokens(document, token) {
      const builder = new vscode.SemanticTokensBuilder(legend);
      if (!vscode.workspace.isTrusted) return builder.build();
      const lexical = await workspace.lexical(document, token);
      const coloring = colors.get(document.uri.toString())?.current;
      const spans = coloring?.text === lexical.snapshot.original ? coloring.spans : [];
      const parameters: vscode.Range[] = [];
      const functions: vscode.Range[] = [];
      const literals = new Set(spans.filter(span => span.kind === 'datum').map(span => `${span.start}:${span.end}`));
      const ordered = spans.map((span, priority) => ({ ...span, priority }))
        .filter(span => ['style', 'declaration', 'macro', 'parameter', 'function'].includes(span.kind))
        .sort((a, b) => a.start - b.start || a.priority - b.priority);
      let next = 0;
      let active: typeof ordered = [];
      for (const item of lexical.data.tokens) {
        const itemStart = lexical.snapshot.rawOffset(item.start), itemEnd = lexical.snapshot.rawOffset(item.end);
        active = active.filter(span => span.end > itemStart);
        while (next < ordered.length && ordered[next].start < itemEnd) {
          const span = ordered[next++];
          if (span.end > itemStart) active.push(span);
        }
        const boundaries = new Set([itemStart, itemEnd]);
        for (const span of active) {
          boundaries.add(Math.max(itemStart, span.start)); boundaries.add(Math.min(itemEnd, span.end));
        }
        const cuts = [...boundaries].sort((a, b) => a - b);
        for (let i = 0; i < cuts.length - 1; i++) {
          const start = cuts[i], end = cuts[i + 1];
          if (end <= start) continue;
          const covering = active.filter(span => span.start <= start && span.end >= end);
          let kind = lexicalType(item);
          if (kind !== 'comment' && kind !== 'string') {
            // Match complete reader tokens: a macro may reuse a wider source
            // span for a generated literal, which must not recolor nearby code.
            if (literals.has(`${itemStart}:${itemEnd}`)) kind = 'racketDatum';
            // Sorting by position must not change Check Syntax's style precedence.
            let style: (typeof ordered)[number] | undefined;
            for (const span of covering) if (span.kind === 'style'
              && (!style || span.priority > style.priority)) style = span;
            if (style) kind = style.type;
            const localBindingStyle = !style || style.type === 'racketLexical' || style.type === 'racketMutated';
            if (localBindingStyle && covering.some(span => span.kind === 'function')) {
              kind = 'function';
            }
            if (localBindingStyle && covering.some(span => span.kind === 'parameter')) {
              kind = 'parameter';
            }
            if (covering.some(span => span.kind === 'macro')
              && (!style || kind === 'racketLexical' || kind === 'racketImported')) {
              kind = 'macro';
            }
          }
          if (!kind) continue;
          const flags: string[] = [];
          if (covering.some(span => span.kind === 'declaration')) flags.push('declaration');
          const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
          if (kind === 'parameter') parameters.push(range);
          if (kind === 'function') functions.push(range);
          for (let line = range.start.line; line <= range.end.line; line++) {
            const from = line === range.start.line ? range.start.character : 0;
            const to = line === range.end.line ? range.end.character : document.lineAt(line).text.length;
            if (to > from) builder.push(new vscode.Range(line, from, line, to), kind, flags);
          }
        }
      }
      lexical.assertCurrent();
      bindingRanges.set(document.uri.toString(), { version: document.version, parameters, functions });
      refreshDecorations();
      return builder.build();
    },
  }, legend));

  return subscriptions;
}
