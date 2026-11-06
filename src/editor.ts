import * as vscode from 'vscode';
import { SemanticSession, Workspace } from './workspace';
import { Annotation, BackendEdit, CompletionCandidate } from './protocol';
import { assertNotCancelled, atPosition, isCancellation, sameRange } from './documents';
import { completionContext, localSignatureHelp } from './source';
import { expressionRanges, surrounding } from './structural';

function documentationAt(session: SemanticSession, source: string, offset: number): Annotation[] {
  return session.analysis.annotations.filter(annotation => annotation.kind === 'documentation' && atPosition(annotation.at, source, offset));
}

async function readDocumentation(session: SemanticSession, source: string, offset: number, token?: vscode.CancellationToken): Promise<{ annotation: Annotation; strings: string[] }[]> {
  const result: { annotation: Annotation; strings: string[] }[] = [];
  for (const annotation of documentationAt(session, source, offset)) {
    const strings = await session.worker.request<string[]>('documentation', { id: annotation.id }, token);
    result.push({ annotation, strings });
  }
  return result;
}

export function registerEditor(workspace: Workspace): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { language: 'racket' };
  const subscriptions: vscode.Disposable[] = [];

  subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    async provideHover(document, position, token) {
      if (!vscode.workspace.isTrusted) return;
      const session = await workspace.available(document.uri, token);
      if (!session?.analysis.complete || session.analysis.mode !== 'module') return;
      const source = workspace.sourcePath(document.uri), offset = session.snapshot.offset(position);
      const entries = session.analysis.annotations.filter(a => atPosition(a.at, source, offset));
      const contents: vscode.MarkdownString[] = [];
      const messages = new Set<string>();
      for (const entry of entries) if (entry.kind === 'hover' && entry.text && !messages.has(entry.text)) {
        messages.add(entry.text); contents.push(new vscode.MarkdownString().appendText(entry.text));
      }
      for (const { annotation, strings } of await readDocumentation(session, source, offset, token)) {
        const markdown = new vscode.MarkdownString();
        if (strings.length) markdown.appendCodeblock(strings.slice(1).join('\n') || strings[0], 'racket');
        if (annotation.path) {
          const uri = vscode.Uri.file(annotation.path).with({ fragment: String(annotation.tag || '') });
          markdown.appendMarkdown(`\n[${(annotation.name || 'Documentation').replace(/[\[\]]/g, '')}](${uri.toString()})`);
        }
        if (markdown.value) contents.push(markdown);
      }
      workspace.assertCurrent(session);
      return contents.length ? new vscode.Hover(contents) : undefined;
    },
  }));

  subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position, token) {
      if (!vscode.workspace.isTrusted) return [];
      const lexical = await workspace.lexical(document, token);
      const { snapshot, data: { tokens } } = lexical;
      const offset = snapshot.offset(position);
      const at = tokens.find(t => t.start <= offset && offset < t.end);
      const previous = tokens.find(t => t.end === offset);
      const active = at || previous;
      if (active && (active.attributes['comment?'] || ['comment', 'sexp-comment'].includes(active.attributes.type))) return [];
      if (previous?.attributes.type === 'comment' && snapshot.slice(previous.start, previous.end).startsWith(';')) return [];
      const word = [at, previous].find(t => t && !t.attributes['comment?'] && ['symbol', 'keyword', 'string', 'error'].includes(t.attributes.type));
      if (!word && active && active.start < offset && offset < active.end && active.attributes.type !== 'white-space') return [];
      const wordStart = word?.start ?? offset, wordEnd = word?.end ?? offset;
      const prefix = snapshot.slice(wordStart, offset);
      const full = snapshot.slice(wordStart, wordEnd);
      const quotedPath = full.startsWith('"');
      const outsideString = quotedPath && (offset === wordStart || (word?.attributes.type === 'string' && offset === wordEnd));
      if (outsideString || prefix.includes('\n')) return [];
      // Do not wait for an in-flight expansion: the previous name pool is
      // already usable while the user is typing or a check is running.
      const session = workspace.current(document.uri);
      const context = completionContext(lexical, wordStart);
      const source = workspace.sourcePath(document.uri);
      const moduleForm = word && session?.analysis.complete && session.analysis.annotations.some(a =>
        a.kind === 'require' && a.at?.source === source && a.at.start <= word.start && word.end <= a.at.end);
      if (context?.modulePath || moduleForm) {
        // Escaped or multiline paths need more than segment replacement. Leave
        // those intact rather than interpreting a partial string escape.
        if (/[\\\n\r]/.test(full) || !quotedPath && !/^[A-Za-z0-9_+/-]*$/.test(prefix)) return [];
        const found = await lexical.request<{ name: string; path: string; directory: boolean }[]>('modules', { prefix, path: source }, token);
        const segment = prefix.slice(prefix.lastIndexOf('/') + 1).replace(/^"/, '');
        const start = offset - Array.from(segment).length;
        const suffix = snapshot.slice(offset, wordEnd);
        const end = offset + Array.from(suffix.split(/[\/"\r\n]/, 1)[0]).length;
        const hasSlash = snapshot.slice(end, Math.min(end + 1, snapshot.length)) === '/';
        const range = snapshot.range(start, end);
        const seen = new Set<string>();
        const items: vscode.CompletionItem[] = [];
        for (const entry of found) {
          if (/[\\/]/.test(entry.name)) continue;
          if (!quotedPath && !entry.directory && !/\.(rkt|ss)$/.test(entry.name)) continue;
          const name = quotedPath || entry.directory ? entry.name : entry.name.replace(/\.(rkt|ss)$/, '');
          if ((!quotedPath && !/^[A-Za-z0-9_+-]+$/.test(name)) || (hasSlash && !entry.directory)) continue;
          const key = `${name}:${entry.directory}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const item = new vscode.CompletionItem(name, entry.directory ? vscode.CompletionItemKind.Folder : vscode.CompletionItemKind.Module);
          const continuePath = entry.directory && !hasSlash;
          item.range = range;
          item.insertText = (quotedPath ? JSON.stringify(name).slice(1, -1) : name) + (continuePath ? '/' : '');
          item.detail = entry.path;
          if (continuePath) item.command = { command: 'editor.action.triggerSuggest', title: 'Suggest' };
          items.push(item);
        }
        return new vscode.CompletionList(items, true);
      }
      if (word && !['symbol', 'keyword'].includes(word.attributes.type)) return [];
      if (session?.analysis.mode === 'syntax') return [];
      const range = word ? snapshot.range(wordStart, wordEnd) : undefined;
      if (!session?.analysis.complete) {
        if (lexical.data.structure.headerEnd === false || offset < lexical.data.structure.headerEnd
          || context?.literal || context?.inRequire) return [];
        lexical.assertCurrent();
        assertNotCancelled(token);
        const items = workspace.completionNames(document.uri).filter(candidate => candidate.insert.startsWith(prefix)).map(candidate => {
          const item = new vscode.CompletionItem(candidate.name, vscode.CompletionItemKind.Text);
          item.insertText = candidate.insert;
          item.filterText = candidate.insert;
          item.range = range;
          return item;
        });
        return new vscode.CompletionList(items, true);
      }
      const candidates = await session.worker.request<CompletionCandidate[]>('complete',
        { position: offset, start: wordStart, end: wordEnd, prefix }, token);
      lexical.assertCurrent();
      workspace.assertCurrent(session);
      if (session.snapshot.version !== snapshot.version) throw new vscode.CancellationError();
      const items = candidates.map(candidate => {
        const item = new vscode.CompletionItem(candidate.name, candidate.kind === 'macro' ? vscode.CompletionItemKind.Keyword
          : candidate.kind === 'function' ? vscode.CompletionItemKind.Function
          : candidate.kind === 'variable' ? vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Text);
        item.insertText = candidate.insert;
        item.filterText = candidate.insert;
        item.range = range;
        item.detail = [candidate.origin, candidate.space ? `space ${candidate.space}` : '', candidate.phase !== 0 ? `phase ${candidate.phase}` : ''].filter(Boolean).join(' · ');
        return item;
      });
      return new vscode.CompletionList(items, true);
    },
  }, '/', ':', '"'));

  subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
    async provideSignatureHelp(document, position, token) {
      if (!vscode.workspace.isTrusted) return;
      const lexical = await workspace.lexical(document, token);
      const offset = lexical.snapshot.offset(position);
      const enclosing = surrounding(lexical, offset)[0];
      if (!enclosing) return;
      const session = await workspace.available(document.uri, token);
      if (!session?.analysis.complete || session.analysis.mode !== 'module') return;
      lexical.assertCurrent();
      if (session.snapshot.version !== lexical.snapshot.version) {
        throw new vscode.CancellationError();
      }
      const source = workspace.sourcePath(document.uri);
      const operators = session.analysis.annotations.filter(a => a.kind === 'application' && a.at?.source === source
        && a.at.start === enclosing.start && a.at.end === enclosing.end).flatMap(a => a.operatorAt ? [a.operatorAt] : []);
      const operator = operators[0];
      if (!operator || operators.some(other => !sameRange(operator, other))
        || !lexical.data.tokens.some(t => t.start === operator.start && t.end === operator.end)) return;
      const local = localSignatureHelp(lexical, session.analysis.annotations, source, operator, offset);
      if (local) {
        workspace.assertCurrent(session);
        return local;
      }
      const docs = await readDocumentation(session, source, operator.start, token);
      workspace.assertCurrent(session);
      const signatures = docs.filter(doc => doc.strings.length > 1).map(doc => new vscode.SignatureInformation(doc.strings.slice(1).join('\n')));
      if (!signatures.length) return;
      const help = new vscode.SignatureHelp();
      help.signatures = signatures;
      help.activeSignature = 0;
      help.activeParameter = 0;
      return help;
    },
  }, ' ', '('));

  const format = async (document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.TextEdit[]> => {
    if (!vscode.workspace.isTrusted) return [];
    const lexical = await workspace.lexical(document, token);
    const edits = await lexical.request<BackendEdit[]>('format', { start: lexical.snapshot.offset(range.start), end: lexical.snapshot.offset(range.end) }, token);
    lexical.assertCurrent();
    return edits.map(edit => vscode.TextEdit.replace(lexical.snapshot.range(edit.start, edit.end), edit.text));
  };
  subscriptions.push(
    vscode.languages.registerDocumentFormattingEditProvider(selector, {
      provideDocumentFormattingEdits: (document, _options, token) => format(document, new vscode.Range(
        new vscode.Position(0, 0), document.lineAt(document.lineCount - 1).range.end), token),
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider(selector, { provideDocumentRangeFormattingEdits: (document, range, _options, token) => format(document, range, token) }),
    vscode.languages.registerOnTypeFormattingEditProvider(selector, {
      provideOnTypeFormattingEdits: (document, position, _character, _options, token) => format(document, document.lineAt(position.line).range, token),
    }, '\n'),
    vscode.languages.registerFoldingRangeProvider(selector, {
      async provideFoldingRanges(document, _context, token) {
        if (!vscode.workspace.isTrusted) return [];
        const lexical = await workspace.lexical(document, token);
        const ranges = lexical.data.ranges.map(range => lexical.snapshot.range(range.start, range.end));
        for (const item of lexical.data.tokens) if (['comment', 'string'].includes(item.attributes.type)) ranges.push(lexical.snapshot.range(item.start, item.end));
        return ranges.filter(range => range.end.line > range.start.line).map(range => new vscode.FoldingRange(range.start.line, range.end.line));
      },
    }),
    vscode.languages.registerSelectionRangeProvider(selector, {
      async provideSelectionRanges(document, positions, token) {
        if (!vscode.workspace.isTrusted) return [];
        const lexical = await workspace.lexical(document, token);
        const result = await Promise.all(positions.map(async position => {
          const offset = lexical.snapshot.offset(position);
          const ranges = (await expressionRanges(lexical, offset, token))
            .filter(range => range.start <= offset && offset <= range.end).reverse();
          let parent: vscode.SelectionRange | undefined;
          for (const range of ranges) parent = new vscode.SelectionRange(lexical.snapshot.range(range.start, range.end), parent);
          return parent || new vscode.SelectionRange(new vscode.Range(position, position));
        }));
        lexical.assertCurrent();
        return result;
      },
    }),
  );

  subscriptions.push(vscode.commands.registerCommand('racket.documentation', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    try {
      const { document, selection } = editor;
      const session = await workspace.available(document.uri);
      if (!session?.analysis.complete || session.analysis.mode !== 'module') return;
      const source = workspace.sourcePath(document.uri), offset = session.snapshot.offset(selection.active);
      const entries = documentationAt(session, source, offset).flatMap(annotation => typeof annotation.path === 'string' ? [{
        label: annotation.label || annotation.name || 'Documentation',
        uri: vscode.Uri.file(annotation.path).with({ fragment: String(annotation.tag || '') }),
      }] : []);
      workspace.assertCurrent(session);
      if (!entries.length) return;
      const selected = entries.length === 1 ? entries[0] : await vscode.window.showQuickPick(entries);
      if (selected) await vscode.env.openExternal(selected.uri);
    } catch (error) {
      if (!isCancellation(error)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }));
  return subscriptions;
}
