import * as vscode from 'vscode';
import { LexicalSession, SemanticSession, Workspace } from './workspace';
import { LexToken, SourceRange } from './protocol';
import { isRacket, rangeKey } from './documents';

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

interface PaintRange { start: number; end: number }
interface PaintSpan extends PaintRange {
  kind: 'style' | 'macro' | 'parameter' | 'function' | 'datum' | 'declaration' | 'unused';
  type?: string;
  wholeIdentifier?: boolean;
  growthBounds?: PaintRange;
}
interface Coloring { text: string; spans: PaintSpan[]; lexicalState?: 'pending' | 'confirmed' }
interface ColoringCache { original: Coloring; current: Coloring }
interface Decorations { version: number; parameters: PaintSpan[]; functions: PaintSpan[]; unused: PaintSpan[] }

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

function mapDisplayRange(range: PaintRange, start: number, end: number, insertedLength: number,
  includeBoundaryInsertions = false): (PaintRange & { changed: boolean }) | undefined {
  const delta = insertedLength - (end - start);
  if (includeBoundaryInsertions && start === end && range.start <= start && start <= range.end) {
    return { start: range.start, end: range.end + insertedLength, changed: insertedLength > 0 };
  }
  if (end <= range.start) return { start: range.start + delta, end: range.end + delta, changed: false };
  if (start >= range.end) return { start: range.start, end: range.end, changed: false };
  // Keep an anchor in the old identifier. Whole replacements and edits crossing
  // its boundaries cannot establish continuity with that identifier.
  if (start < range.start || end > range.end || start === range.start && end === range.end) return;
  return { start: range.start, end: range.end + delta, changed: true };
}

function canInheritColor(span: PaintSpan): boolean {
  return ['style', 'macro', 'parameter', 'function'].includes(span.kind);
}

function movePaintSpan(span: PaintSpan, change: vscode.TextDocumentContentChangeEvent): PaintSpan | undefined {
  const start = change.rangeOffset, end = start + change.rangeLength;
  const mapped = mapDisplayRange(span, start, end, change.text.length);
  if (!mapped || mapped.changed && (!span.wholeIdentifier || !canInheritColor(span))) return;
  const bounds = span.wholeIdentifier
    ? mapDisplayRange(span.growthBounds || span, start, end, change.text.length, true) : undefined;
  return { ...span, start: mapped.start, end: mapped.end,
    growthBounds: bounds ? { start: bounds.start, end: bounds.end } : undefined };
}

function moveDecorations(decorations: Decorations, changes: readonly vscode.TextDocumentContentChangeEvent[], version: number): Decorations {
  const ordered = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset);
  const move = (ranges: PaintSpan[]) => {
    for (const change of ordered) {
      const start = change.rangeOffset, end = start + change.rangeLength;
      ranges = ranges.flatMap(range => {
        const touches = start <= range.end && end >= range.start;
        if (touches) {
          const separated = start === end &&
            (start === range.start && /[\s()[\]{}]$/u.test(change.text)
              || start === range.end && /^[\s()[\]{}]/u.test(change.text));
          if (!canInheritColor(range) && !separated) return [];
          // Removing a boundary may merge existing tokens. Insertions inside a
          // name that introduce reader syntax also await lexical confirmation.
          if (start !== end && (end === range.start || start === range.end)) return [];
          if (start < range.end && end > range.start && /[\s()[\]{};"'`,|\\]/u.test(change.text)) return [];
        }
        const moved = movePaintSpan(range, change);
        // Keep the surviving anchor colored. Do not paint the wider growth
        // bounds until the lexer identifies the new token within those bounds.
        return moved ? [moved] : [];
      });
    }
    return ranges;
  };
  return { version, parameters: move(decorations.parameters), functions: move(decorations.functions), unused: move(decorations.unused) };
}

function moveColoring(coloring: Coloring, changes: readonly vscode.TextDocumentContentChangeEvent[]): Coloring {
  let { text, spans } = coloring;
  // All offsets refer to the old document; apply edits from right to left.
  for (const change of [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
    const start = change.rangeOffset, end = start + change.rangeLength;
    spans = spans.flatMap(span => {
      const moved = movePaintSpan(span, change);
      return moved ? [moved] : [];
    });
    text = text.slice(0, start) + change.text + text.slice(end);
  }
  return { text, spans, lexicalState: 'pending' };
}

function confirmColoring(coloring: Coloring, lexical: LexicalSession): void {
  if (coloring.lexicalState === 'confirmed') return;
  const tokens = lexical.data.tokens.map(token => ({
    start: lexical.snapshot.rawOffset(token.start), end: lexical.snapshot.rawOffset(token.end),
    identifier: token.attributes.type === 'symbol' && !token.attributes['comment?'],
  }));
  const starts = new Set(tokens.map(token => token.start));
  const ends = new Set(tokens.map(token => token.end));
  coloring.spans = coloring.spans.flatMap(span => {
    let low = 0, high = tokens.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tokens[middle].start <= span.start) low = middle + 1;
      else high = middle;
    }
    const token = tokens[low - 1];
    const exactIdentifier = !!token?.identifier && token.start === span.start && token.end === span.end;
    if (coloring.lexicalState !== 'pending') return [{ ...span, wholeIdentifier: exactIdentifier }];
    if (!span.wholeIdentifier) {
      // Fresh native annotations may cover sub-token or multi-token ranges.
      // After editing, retain these only at current lexer-token boundaries.
      return starts.has(span.start) && ends.has(span.end) ? [{ ...span, wholeIdentifier: exactIdentifier }] : [];
    }
    const bounds = span.growthBounds || span;
    // Only inserted boundary text may enlarge the old range. Deleting a
    // separator must not absorb an existing neighboring identifier.
    if (!token?.identifier || token.start > span.start || token.end < span.end
      || token.start < bounds.start || token.end > bounds.end) return [];
    const extended = token.start !== span.start || token.end !== span.end;
    if (extended && !canInheritColor(span)) return [];
    return [{ ...span, start: token.start, end: token.end, wholeIdentifier: true, growthBounds: undefined }];
  });
  coloring.lexicalState = 'confirmed';
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
  const decorations = new Map<string, Decorations>();
  const rendered = new Map<string, { version: number; coloring?: Coloring; data: LexicalSession['data']; tokens: vscode.SemanticTokens }>();
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
      const cached = decorations.get(document.uri.toString());
      const current = vscode.workspace.isTrusted && document.languageId === 'racket' && cached?.version === document.version ? cached : undefined;
      const ranges = (spans: PaintRange[] = []) => [...new Map(spans.map(span =>
        [`${span.start}:${span.end}`, new vscode.Range(document.positionAt(span.start), document.positionAt(span.end))])).values()];
      editor.setDecorations(faded, config.get<boolean>('showUnused', true) ? ranges(current?.unused) : []);
      const semanticEnabled = config.get<boolean | string>('semanticHighlighting.enabled') !== false;
      editor.setDecorations(parameterStyle, semanticEnabled ? ranges(current?.parameters) : []);
      editor.setDecorations(functionStyle, semanticEnabled ? ranges(current?.functions) : []);
    }
  };
  const render = (document: vscode.TextDocument, lexical: LexicalSession): vscode.SemanticTokens => {
    lexical.assertCurrent();
    if (!isRacket(document) || !vscode.workspace.isTrusted) throw new vscode.CancellationError();
    const key = document.uri.toString();
    const builder = new vscode.SemanticTokensBuilder(legend);
    const coloring = colors.get(document.uri.toString())?.current;
    const cached = rendered.get(key);
    if (cached?.version === document.version && cached.coloring === coloring && cached.data === lexical.data) return cached.tokens;
    if (coloring?.text === lexical.snapshot.original) confirmColoring(coloring, lexical);
    const spans = coloring?.text === lexical.snapshot.original ? coloring.spans : [];
    const parameters: PaintSpan[] = [];
    const functions: PaintSpan[] = [];
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
        const wholeIdentifier = item.attributes.type === 'symbol' && !item.attributes['comment?'] && start === itemStart && end === itemEnd;
        if (kind === 'parameter') parameters.push({ start, end, kind, wholeIdentifier });
        if (kind === 'function') functions.push({ start, end, kind, wholeIdentifier });
        for (let line = range.start.line; line <= range.end.line; line++) {
          const from = line === range.start.line ? range.start.character : 0;
          const to = line === range.end.line ? range.end.character : document.lineAt(line).text.length;
          if (to > from) builder.push(new vscode.Range(line, from, line, to), kind, flags);
        }
      }
    }
    lexical.assertCurrent();
    const unused = spans.filter(span => span.kind === 'unused');
    decorations.set(key, { version: document.version, parameters, functions, unused });
    const tokens = builder.build();
    rendered.set(key, { version: document.version, coloring, data: lexical.data, tokens });
    refreshDecorations();
    return tokens;
  };
  const updateRendering = async (document: vscode.TextDocument, token?: vscode.CancellationToken) => {
    if (document.isClosed || !isRacket(document) || !vscode.workspace.isTrusted) throw new vscode.CancellationError();
    return render(document, await workspace.lexical(document, token));
  };
  const refreshAfterEdit = (document: vscode.TextDocument) => {
    if (document.isClosed || !isRacket(document) || !vscode.workspace.isTrusted) return;
    void updateRendering(document).then(() => changed.fire()).catch(error => workspace.report(error, document.uri));
  };
  const subscriptions: vscode.Disposable[] = [changed, faded, parameterStyle, functionStyle,
    workspace.changed.event(() => changed.fire()),
    workspace.ready.event(session => {
      const uri = session.snapshot.uri;
      const document = vscode.workspace.textDocuments.find(doc => !doc.isClosed && doc.uri.toString() === uri.toString());
      if (session.analysis.complete && document && isRacket(document) && vscode.workspace.isTrusted) {
        // Publish only after confirming the original token boundaries. Rendering
        // may be delayed or never requested for an editor that is not visible.
        void workspace.lexical(document).then(lexical => {
          lexical.assertCurrent();
          workspace.assertCurrent(session);
          if (lexical.snapshot.original !== session.snapshot.original) throw new vscode.CancellationError();
          const coloring = coloringFor(session, workspace.sourcePath(uri));
          confirmColoring(coloring, lexical);
          colors.set(uri.toString(), { original: coloring, current: coloring });
          render(document, lexical);
          changed.fire();
        }).catch(error => workspace.report(error, uri));
        return;
      }
      refreshDecorations();
      changed.fire();
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!event.contentChanges.length) return;
      const key = event.document.uri.toString();
      const cached = colors.get(key);
      if (!cached) return;
      const text = event.document.getText();
      if (text === cached.original.text) cached.current = cached.original;
      else {
        const next = moveColoring(cached.current, event.contentChanges);
        cached.current = next.text === text ? next : { text, spans: [] };
      }
      const previous = decorations.get(key);
      if (previous) decorations.set(key, moveDecorations(previous, event.contentChanges, event.document.version));
      rendered.delete(key);
      refreshDecorations();
      changed.fire();
      refreshAfterEdit(event.document);
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      colors.delete(document.uri.toString());
      decorations.delete(document.uri.toString());
      rendered.delete(document.uri.toString());
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
    provideDocumentSemanticTokens(document, token) {
      return vscode.workspace.isTrusted ? updateRendering(document, token) : new vscode.SemanticTokensBuilder(legend).build();
    },
  }, legend));

  return subscriptions;
}
