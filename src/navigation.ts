import * as vscode from 'vscode';
import { Annotation, SourceRange } from './protocol';
import { SemanticSession, Workspace, requireSemanticAnalysis } from './workspace';
import { atPosition, rangeKey, assertNotCancelled, sameRange } from './documents';
import { outlineSymbols } from './source';
import { bindingAt, bindingKeys, matchingRanges } from './bindings';

async function resolveJump(workspace: Workspace, jump: Annotation, token?: vscode.CancellationToken): Promise<SourceRange[]> {
  if (!jump.path) return [];
  const keys = new Set(bindingKeys(jump));
  if (!keys.size) throw new Error('The imported binding identity could not be resolved');
  const uri = vscode.Uri.file(jump.path);
  return workspace.withSemantic(uri, token, target => {
    requireSemanticAnalysis(target);
    return target.analysis.annotations.flatMap(a =>
      a.kind === 'definition' && a.at && bindingKeys(a).some(key => keys.has(key)) ? [a.at] : []);
  });
}

async function locations(workspace: Workspace, ranges: SourceRange[]): Promise<vscode.Location[]> {
  const unique = [...new Map(ranges.map(range => [rangeKey(range), range])).values()];
  const result: vscode.Location[] = [];
  for (const range of unique) {
    const location = await workspace.location(range);
    if (!location) throw new Error(`Source location is no longer available: ${range.source}`);
    result.push(location);
  }
  return result;
}

export function registerNavigation(workspace: Workspace): vscode.Disposable[] {
  const selector: vscode.DocumentSelector = { language: 'racket' };
  const symbols: vscode.DocumentSymbolProvider = {
    async provideDocumentSymbols(document, token) {
      if (!vscode.workspace.isTrusted) return [];
      const lexical = await workspace.lexical(document, token);
      const session = await workspace.available(document.uri, token);
      lexical.assertCurrent();
      if (session) workspace.assertCurrent(session);
      if (session && session.snapshot.version !== lexical.snapshot.version) {
        throw new vscode.CancellationError();
      }
      const source = workspace.sourcePath(document.uri);
      return outlineSymbols(lexical, session?.analysis.annotations || [], source, !!session?.analysis.complete && session.analysis.mode === 'module');
    },
  };
  let symbolRegistration = vscode.languages.registerDocumentSymbolProvider(selector, symbols);
  let refreshPending = false, disposed = false;
  const refreshSymbols = () => {
    if (refreshPending || disposed) return;
    refreshPending = true;
    queueMicrotask(() => {
      refreshPending = false;
      if (disposed) return;
      // VS Code caches outlines by document version and provider identity.
      // Analysis can change without a text edit, and this API has no refresh event.
      symbolRegistration.dispose();
      symbolRegistration = vscode.languages.registerDocumentSymbolProvider(selector, symbols);
    });
  };
  return [
    { dispose() { disposed = true; symbolRegistration.dispose(); } },
    workspace.ready.event(session => {
      if (vscode.workspace.textDocuments.some(document => !document.isClosed && document.uri.toString() === session.snapshot.uri.toString())) refreshSymbols();
    }),
    workspace.changed.event(refreshSymbols),
    vscode.languages.registerDefinitionProvider(selector, {
      async provideDefinition(document, position, token) {
        if (!vscode.workspace.isTrusted) return;
        const generation = workspace.generation;
        const session = await workspace.available(document.uri, token);
        if (!session || session.analysis.mode === 'syntax') return [];
        requireSemanticAnalysis(session);
        const source = workspace.sourcePath(document.uri), offset = session.snapshot.offset(position);
        const group = bindingAt(session.analysis.annotations, source, offset);
        const result = group.edges.map(edge => edge.from!);
        for (const a of session.analysis.annotations) {
          if (a.kind === 'jump' && (atPosition(a.at, source, offset) || group.ranges.some(r => a.at && sameRange(r, a.at)))) {
            result.push(...await resolveJump(workspace, a, token));
          }
          if (['require', 'language'].includes(a.kind) && atPosition(a.at, source, offset) && a.path) result.push({ source: a.path, start: 0, end: 0 });
        }
        workspace.assertCurrent(session);
        const targets = await locations(workspace, result);
        workspace.assertGeneration(generation, token);
        return targets;
      },
    }),
    vscode.languages.registerReferenceProvider(selector, {
      async provideReferences(document, position, context, token) {
        if (!vscode.workspace.isTrusted) return [];
        const generation = workspace.generation;
        const original = await workspace.available(document.uri, token);
        if (!original || original.analysis.mode === 'syntax') return [];
        requireSemanticAnalysis(original);
        const source = workspace.sourcePath(document.uri);
        const query = bindingAt(original.analysis.annotations, source, original.snapshot.offset(position));
        if (query.unresolvedImports) {
          throw new Error('The imported binding identity is unresolved or ambiguous');
        }
        const result: SourceRange[] = [];
        const append = (session: SemanticSession, ranges: SourceRange[]) => {
          const definitions = new Set(session.analysis.annotations.flatMap(a =>
            a.kind === 'definition' && a.at ? [rangeKey(a.at)] : a.kind === 'binding' && a.actual && !a.require && a.from ? [rangeKey(a.from)] : []));
          result.push(...ranges.filter(range => context.includeDeclaration || !definitions.has(rangeKey(range))));
        };
        append(original, [...query.ranges, ...matchingRanges(original.analysis.annotations, query.keys)]);
        const crossFileKeys = new Set(query.keys);
        for (const key of query.keys) {
          const definitions = original.analysis.annotations.filter(a => a.kind === 'definition' && a.at && bindingKeys(a).includes(key));
          if (definitions.length !== 1) continue;
          const definition = definitions[0], at = definition.at!;
          if (at.source !== source || !original.snapshot.contains(at)) continue;
          const privateLocal = await original.worker.request<boolean>('private-definition',
            { start: at.start, end: at.end, phaseSpace: definition.phaseSpace }, token);
          if (privateLocal) crossFileKeys.delete(key);
        }
        if (crossFileKeys.size) {
          const files = await workspace.sourceFiles(token);
          for (const uri of files) {
            if (uri.toString() === document.uri.toString()) continue;
            workspace.assertGeneration(generation, token); workspace.assertCurrent(original);
            await workspace.withSemantic(uri, token, session => {
              requireSemanticAnalysis(session);
              append(session, matchingRanges(session.analysis.annotations, crossFileKeys));
            });
          }
          if (context.includeDeclaration) for (const a of original.analysis.annotations) {
            if (a.kind === 'jump' && bindingKeys(a).some(key => crossFileKeys.has(key))) result.push(...await resolveJump(workspace, a, token));
          }
        }
        workspace.assertCurrent(original);
        const targets = await locations(workspace, result);
        workspace.assertGeneration(generation, token);
        return targets;
      },
    }),
    vscode.languages.registerDocumentHighlightProvider(selector, {
      async provideDocumentHighlights(document, position, token) {
        if (!vscode.workspace.isTrusted) return [];
        const session = await workspace.available(document.uri, token);
        if (!session || session.analysis.mode === 'syntax') return [];
        requireSemanticAnalysis(session);
        const source = workspace.sourcePath(document.uri), offset = session.snapshot.offset(position);
        const group = bindingAt(session.analysis.annotations, source, offset);
        const ranges = [...group.ranges, ...matchingRanges(session.analysis.annotations, group.keys)];
        for (const edge of session.analysis.annotations) if (edge.kind === 'binding' && edge.actual && edge.require
          && (atPosition(edge.to, source, offset) || atPosition(edge.from, source, offset))) {
          ranges.push(edge.from!, edge.to!);
        }
        return [...new Map(ranges.filter(range => range.source === source && session.snapshot.contains(range)).map(range => [rangeKey(range), range])).values()]
          .map(range => new vscode.DocumentHighlight(session.snapshot.range(range.start, range.end), vscode.DocumentHighlightKind.Read));
      },
    }),
    vscode.languages.registerWorkspaceSymbolProvider({
      provideWorkspaceSymbols(query, token) {
        if (!vscode.workspace.isTrusted) return [];
        const results: vscode.SymbolInformation[] = [];
        const search = query.toLocaleLowerCase();
        const seen = new Set<string>();
        for (const session of workspace.cachedFiles()) {
          assertNotCancelled(token);
          const source = workspace.sourcePath(session.snapshot.uri);
          for (const a of session.analysis.annotations) {
            if (a.kind !== 'definition' || !a.at || a.at.source !== source || !session.snapshot.contains(a.at)
              || !a.name?.toLocaleLowerCase().includes(search)) continue;
            const container = (a.submodules || []).join('/');
            const key = JSON.stringify([rangeKey(a.at), a.name, container]);
            if (seen.has(key)) continue;
            seen.add(key);
            const location = new vscode.Location(session.snapshot.uri, session.snapshot.range(a.at.start, a.at.end));
            results.push(new vscode.SymbolInformation(a.name, vscode.SymbolKind.Variable, container, location));
          }
        }
        return results;
      },
    }),
  ];
}
