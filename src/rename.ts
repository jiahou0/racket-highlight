import * as vscode from 'vscode';
import { Analysis, RenameResult, SourceRange, Worker } from './protocol';
import { Snapshot, assertNotCancelled, atPosition, rangeKey, sameRange } from './documents';
import { SemanticSession, Workspace, requireSemanticAnalysis } from './workspace';
import { bindingAt, bindingKeys, matchingRanges } from './bindings';

interface RenameEdit { range: SourceRange; text: string }

// Re-expansion is part of the rename operation. Name-dup callbacks alone do not
// detect every change to imports, macro-generated bindings, or scope capture.
async function reanalyzeRename(workspace: Workspace, sessions: SemanticSession[], edits: RenameEdit[],
  renamed: Map<string, string>, token: vscode.CancellationToken): Promise<void> {
  const generation = workspace.generation;
  interface MappedEdit extends RenameEdit { lengthChange: number; sharedPrefix: number; sharedSuffix: number }
  const changed = new Map<string, { before: Snapshot; after: Snapshot; edits: MappedEdit[] }>();
  for (const edit of edits) {
    if (!edit.range.source || edit.range.source.startsWith('racket-source:')) throw new Error('Rename source is unavailable');
    let file = changed.get(edit.range.source);
    if (!file) {
      const snapshot = sessions.find(session => workspace.sourcePath(session.snapshot.uri) === edit.range.source)?.snapshot
        || await workspace.snapshot(vscode.Uri.file(edit.range.source));
      file = { before: snapshot, after: snapshot, edits: [] };
      changed.set(edit.range.source, file);
    }
    const before = Array.from(file.before.slice(edit.range.start, edit.range.end));
    const after = Array.from(edit.text);
    const sharedLength = Math.min(before.length, after.length);
    let sharedPrefix = 0, sharedSuffix = 0;
    while (sharedPrefix < sharedLength && before[sharedPrefix] === after[sharedPrefix]) sharedPrefix++;
    while (sharedSuffix < sharedLength - sharedPrefix
      && before[before.length - sharedSuffix - 1] === after[after.length - sharedSuffix - 1]) sharedSuffix++;
    file.edits.push({ ...edit, lengthChange: after.length - before.length, sharedPrefix, sharedSuffix });
  }
  for (const file of changed.values()) {
    file.edits.sort((a, b) => a.range.start - b.range.start);
    let text = file.before.original;
    for (const edit of [...file.edits].reverse()) {
      text = text.slice(0, file.before.rawOffset(edit.range.start)) + edit.text + text.slice(file.before.rawOffset(edit.range.end));
    }
    file.after = new Snapshot(file.before.uri, text);
  }
  const mapRange = (range: SourceRange): SourceRange => {
    const file = range.source && changed.get(range.source);
    if (!file) return range;
    const mapOffset = (position: number): number => {
      let delta = 0;
      for (const edit of file.edits) {
        const { start, end } = edit.range;
        if (position <= start) break;
        if (position < end) {
          if (position - start <= edit.sharedPrefix) return position + delta;
          if (end - position <= edit.sharedSuffix) return position + delta + edit.lengthChange;
          throw new Error('A macro source mapping cannot be preserved by this rename');
        }
        delta += edit.lengthChange;
      }
      return position + delta;
    };
    return { ...range, start: mapOffset(range.start), end: mapOffset(range.end) };
  };
  const bindingGraph = (analysis: Analysis, before: boolean): Set<string> => {
    const rangeIdentity = (range: SourceRange) => {
      const { source, start, end } = before ? mapRange(range) : range;
      return [source, start, end];
    };
    return new Set(analysis.annotations.flatMap(a => {
      if (a.kind === 'binding' && a.actual && a.from && a.to) return [JSON.stringify(['binding', rangeIdentity(a.from), rangeIdentity(a.to), a.phase, a.require])];
      if (['definition', 'jump'].includes(a.kind) && a.at) {
        const names = before ? [...new Set(bindingKeys(a).flatMap(key => renamed.has(key) ? [renamed.get(key)!] : []))] : [];
        if (names.length > 1) throw new Error('The source identifier denotes multiple bindings');
        return [JSON.stringify([a.kind, rangeIdentity(a.at), a.path, a.submodules, a.phaseSpace, a.definitionPhases, names[0] ?? a.name])];
      }
      return [];
    }));
  };
  for (const session of sessions) {
    workspace.assertGeneration(generation, token);
    const path = workspace.sourcePath(session.snapshot.uri);
    const snapshot = changed.get(path)?.after || session.snapshot;
    const params = workspace.parameters(snapshot);
    const documents = new Map(params.documents.map(doc => [doc.path, doc]));
    for (const [path, file] of changed) documents.set(path, { path, text: file.after.text });
    const worker = new Worker(workspace.context, 'semantic', session.snapshot.uri, workspace.log);
    try {
      const next = await worker.request<Analysis>('analyze', { ...params, documents: [...documents.values()] }, token);
      if (!next.complete) throw new Error(`Rename changes module validity: ${next.errors.map(e => e.message).join('\n')}`);
      const previous = bindingGraph(session.analysis, true), current = bindingGraph(next, false);
      if (previous.size !== current.size || [...previous].some(edge => !current.has(edge))) {
        throw new Error('Rename would change bindings or produce ambiguous macro source mappings');
      }
    } finally { worker.dispose(); }
  }
  workspace.assertGeneration(generation, token);
}

export function registerRename(workspace: Workspace): vscode.Disposable {
  return vscode.languages.registerRenameProvider({ language: 'racket' }, {
    async prepareRename(document, position, token) {
      const session = await workspace.available(document.uri, token);
      requireSemanticAnalysis(session);
      const source = workspace.sourcePath(document.uri), offset = session.snapshot.offset(position);
      const query = bindingAt(session.analysis.annotations, source, offset);
      const at = query.ranges.filter(range => atPosition(range, source, offset)).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      const prefix = session.analysis.annotations.find(a => a.kind === 'prefix' && atPosition(a.prefixAt, source, offset));
      const range = prefix?.prefixAt || at;
      if (!range) throw new Error('No editable binding at this position');
      return { range: session.snapshot.range(range.start, range.end), placeholder: session.snapshot.slice(range.start, range.end) };
    },
    async provideRenameEdits(document, position, newName, token) {
      const generation = workspace.generation;
      const original = await workspace.available(document.uri, token);
      requireSemanticAnalysis(original);
      const source = workspace.sourcePath(document.uri), offset = original.snapshot.offset(position);
      const prefix = original.analysis.annotations.find(a => a.kind === 'prefix' && atPosition(a.prefixAt, source, offset));
      const query = bindingAt(original.analysis.annotations, source, offset);
      if (query.unresolvedImports) {
        throw new Error('The imported binding identity is unresolved or ambiguous');
      }
      if (new Set(query.edges.map(edge => JSON.stringify(edge.phase))).size > 1) {
        throw new Error('The source range denotes bindings at multiple phases');
      }
      const edits = new Map<string, RenameEdit>();
      const baselines = new Map<string, SemanticSession>([[document.uri.toString(), original]]);
      const renamed = new Map<string, string>();
      const add = (range: SourceRange, text: string) => {
        const key = rangeKey(range);
        const previous = edits.get(key);
        if (previous && previous.text !== text) throw new Error('Conflicting rename edits');
        edits.set(key, { range, text });
      };
      if (prefix?.prefixAt) {
        const valid = await original.worker.request<RenameResult>('rename', { ids: [], name: newName }, token);
        add(prefix.prefixAt, valid.text);
        for (const edge of original.analysis.annotations) {
          const { from, to } = edge;
          if (edge.kind !== 'binding' || !edge.actual || !edge.require || !from || !sameRange(from, prefix.prefixAt) || !to) continue;
          const jump = original.analysis.annotations.find(a => a.kind === 'jump' && a.at?.source === to.source && a.at.start === to.start && a.at.end >= to.end);
          if (!jump?.at || jump.at.source !== source) throw new Error('Prefix reference has no complete source identifier');
          const spelling = original.snapshot.slice(jump.at.start, jump.at.end);
          const oldPrefix = prefix.prefix;
          if (oldPrefix === undefined || !spelling.startsWith(oldPrefix)) throw new Error('Prefix source spelling is ambiguous');
          const combined = valid.name + spelling.slice(oldPrefix.length);
          const checked = await original.worker.request<RenameResult>('rename', { ids: edge.id ? [edge.id] : [], name: combined }, token);
          if (checked.conflicts.length) throw new Error('The new prefix conflicts with an existing binding');
          if (checked.text === combined && to.end - to.start === Array.from(oldPrefix).length) add(to, valid.name);
          else add(jump.at, checked.text);
        }
      } else {
        if (!query.ranges.length) throw new Error('No editable binding at this position');
        const alias = original.analysis.imports.find(({ renamed, localAt }) =>
          renamed && localAt && query.ranges.some(range => sameRange(range, localAt)));
        const keys = alias ? new Set<string>() : query.keys;
        const oldNames = new Set<string>();
        const decodedNames = new Map<SemanticSession, Map<string, string>>();
        const decodeName = async (session: SemanticSession, spelling: string): Promise<string> => {
          workspace.assertCurrent(session);
          assertNotCancelled(token);
          let names = decodedNames.get(session);
          if (!names) { names = new Map(); decodedNames.set(session, names); }
          const cached = names.get(spelling);
          if (cached !== undefined) return cached;
          const { name } = await session.worker.request<RenameResult>('rename', { ids: [], name: spelling }, token);
          workspace.assertCurrent(session);
          assertNotCancelled(token);
          names.set(spelling, name);
          return name;
        };
        let crossFile = false;
        const validName = await original.worker.request<RenameResult>('rename', { ids: [], name: newName }, token);
        for (const key of keys) {
          const [path] = JSON.parse(key);
          const uri = vscode.Uri.file(path);
          const inWorkspace = !!vscode.workspace.getWorkspaceFolder(uri);
          if (path !== source && !inWorkspace) throw new Error('The definition is outside this workspace');
          const inspectDefinition = async (definition: SemanticSession) => {
            requireSemanticAnalysis(definition);
            baselines.set(definition.snapshot.uri.toString(), definition);
            const targets = definition.analysis.annotations.filter(a => a.kind === 'definition' && a.at && bindingKeys(a).includes(key));
            if (targets.length !== 1) throw new Error('The binding has no unique editable definition');
            const at = targets[0].at!;
            if (at.source !== workspace.sourcePath(definition.snapshot.uri) || !definition.snapshot.contains(at)) throw new Error('Definition source is unavailable');
            const privateLocal = path === source && await definition.worker.request<boolean>('private-definition',
              { start: at.start, end: at.end, phaseSpace: targets[0].phaseSpace }, token);
            if (!privateLocal) {
              if (!inWorkspace) throw new Error('Cross-file rename requires a workspace');
              crossFile = true;
            }
            oldNames.add(await decodeName(definition, definition.snapshot.slice(at.start, at.end)));
            renamed.set(key, validName.name);
          };
          if (path === source) await inspectDefinition(original);
          else await workspace.withSemantic(uri, token, inspectDefinition);
        }
        if (oldNames.size > 1) throw new Error('The source identifier denotes multiple definitions');
        const collectEdits = async (session: SemanticSession, ranges: SourceRange[]) => {
          const selected = new Set(ranges.map(rangeKey));
          const aliases = keys.size ? session.analysis.imports.filter(item => item.renamed && item.localAt
            && selected.has(rangeKey(item.localAt)) && oldNames.has(item.original)) : [];
          const importedNames = new Set<string>();
          for (const alias of aliases) {
            if (!alias.originalAt) throw new Error('Imported alias has no editable source name');
            add(alias.originalAt, validName.text);
            // Only the imported spelling changes. The local alias and all of
            // its references keep their name, so their conflict callbacks do not apply.
            importedNames.add(rangeKey(alias.originalAt));
          }
          const renamedRanges = new Set<string>();
          for (const range of ranges) {
            if (importedNames.has(rangeKey(range))) continue;
            if (!range.source || range.source.startsWith('racket-source:')) throw new Error('Binding has no editable source');
            const snapshot = range.source === workspace.sourcePath(session.snapshot.uri) ? session.snapshot : await workspace.snapshot(vscode.Uri.file(range.source));
            if (!snapshot.contains(range)) throw new Error('Binding source range is no longer available');
            const spelling = snapshot.slice(range.start, range.end);
            const name = await decodeName(session, spelling);
            if (aliases.some(alias => alias.name === name)) continue;
            const prefixEdge = session.analysis.annotations.find(edge => edge.kind === 'binding' && edge.actual && edge.require && edge.to && edge.to.source === range.source
              && edge.to.start > range.start && edge.to.end === range.end);
            const target = prefixEdge?.to || range;
            if (keys.size) {
              const targetName = target === range ? name : await decodeName(session, snapshot.slice(target.start, target.end));
              if (!oldNames.has(targetName)) continue;
            }
            add(target, validName.text);
            renamedRanges.add(rangeKey(range));
          }
          const ids = session.analysis.annotations.filter(a => a.kind === 'binding' && a.actual
            && (a.from && renamedRanges.has(rangeKey(a.from)) || a.to && renamedRanges.has(rangeKey(a.to))))
            .flatMap(a => a.id ? [a.id] : []);
          if (!ids.length) return;
          const checked = await session.worker.request<RenameResult>('rename', { ids: [...new Set(ids)], name: newName }, token);
          if (checked.conflicts.length) throw new Error('The new name conflicts with an existing binding');
        };
        const localRanges = [...new Map([...query.ranges, ...matchingRanges(original.analysis.annotations, keys)].map(range => [rangeKey(range), range])).values()];
        await collectEdits(original, localRanges);
        if (crossFile) for (const uri of await workspace.sourceFiles(token)) {
          workspace.assertGeneration(generation, token); workspace.assertCurrent(original);
          if (uri.toString() === document.uri.toString()) continue;
          await workspace.withSemantic(uri, token, async session => {
            requireSemanticAnalysis(session);
            baselines.set(uri.toString(), session);
            const ranges = matchingRanges(session.analysis.annotations, keys);
            if (ranges.length) await collectEdits(session, ranges);
          });
        }
      }
      workspace.assertCurrent(original);
      const result = new vscode.WorkspaceEdit();
      const ordered = [...edits.values()].sort((a, b) => String(a.range.source).localeCompare(String(b.range.source)) || a.range.start - b.range.start);
      for (let i = 0; i < ordered.length; i++) {
        const { range, text } = ordered[i];
        const previous = ordered[i - 1];
        if (previous && previous.range.source === range.source && previous.range.end > range.start) throw new Error('Overlapping source mappings prevent this rename');
        const loc = await workspace.location(range);
        if (!loc) throw new Error('Rename source is unavailable');
        result.replace(loc.uri, loc.range, text);
      }
      if (!ordered.length) throw new Error('No source edits can preserve this binding');
      workspace.assertGeneration(generation, token);
      await reanalyzeRename(workspace, [...baselines.values()], ordered, renamed, token);
      workspace.assertCurrent(original);
      workspace.assertGeneration(generation, token);
      return result;
    },
  });
}
