import * as vscode from 'vscode';
import { BackendEdit, ExpressionRange, ReaderNode } from './protocol';
import { LexicalSession, Workspace } from './workspace';
import { Snapshot, isCancellation, isRacket } from './documents';

export async function expressionAt(session: LexicalSession, position: number, token?: vscode.CancellationToken): Promise<{ start: number; end: number } | undefined> {
  return await session.request<{ start: number; end: number } | false>('expression', { position }, token) || undefined;
}

export function surrounding(session: LexicalSession, position: number): ExpressionRange[] {
  return session.data.ranges.filter(range => range.start <= position && position <= range.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start));
}

const operations = ['slurpForward', 'slurpBackward', 'barfForward', 'barfBackward',
  'swapForward', 'swapBackward', 'raiseExpression', 'deleteExpression'] as const;
type Operation = typeof operations[number];
type Piece = string | [number, number];
interface ExpressionEdit extends BackendEdit { cursor: number }

async function applyEdits(editor: vscode.TextEditor, snapshot: Snapshot, edits: BackendEdit[]): Promise<void> {
  const applied = await editor.edit(builder => {
    for (const edit of edits) builder.replace(snapshot.range(edit.start, edit.end), edit.text);
  }, { undoStopBefore: true, undoStopAfter: true });
  if (!applied) throw new Error('Could not apply changes');
}

function needsSeparator(left: string, right: string): boolean {
  return !!left && !!right && !/[\s()[\]{}]/u.test(left) && !/[\s()[\]{}]/u.test(right);
}

function isTrivia(lexical: LexicalSession, left: number, right: number): boolean {
  return left <= right && !lexical.data.tokens.some(t => t.start < right && t.end > left
    && !t.attributes['comment?'] && !['white-space', 'comment', 'sexp-comment'].includes(t.attributes.type));
}

function plainListRange(lexical: LexicalSession, list: ReaderNode): ExpressionRange {
  const range = lexical.data.ranges.find(r => r.start === list.start && r.end === list.end
    && r.openEnd === list.start + 1 && r.closeStart === list.end - 1);
  if (list.kind !== 'list' || !range) throw new Error('Unsupported list delimiters');
  let boundary = range.openEnd;
  for (const child of list.children) {
    if (!isTrivia(lexical, boundary, child.start)) throw new Error('Unsupported dotted or reader-transformed list');
    boundary = child.end;
  }
  if (!isTrivia(lexical, boundary, range.closeStart)) throw new Error('Unsupported dotted or reader-transformed list');
  return range;
}

function expressionPath(lexical: LexicalSession, selection: vscode.Selection): ReaderNode[] {
  const snapshot = lexical.snapshot;
  const start = snapshot.offset(selection.start), end = snapshot.offset(selection.end);
  const position = snapshot.offset(selection.active);
  const token = lexical.data.tokens.find(t => t.start <= position && position < t.end);
  if (selection.isEmpty && token && (token.attributes['comment?'] || ['comment', 'sexp-comment', 'error'].includes(token.attributes.type))) {
    throw new Error('No readable expression at the cursor');
  }
  const path: ReaderNode[] = [];
  let siblings = lexical.data.structure.forms;
  while (true) {
    const node = siblings.find(n => n.start <= start && end <= n.end && (!selection.isEmpty || position < n.end))
      || (selection.isEmpty ? siblings.find(n => n.end === position) : undefined);
    if (!node) break;
    path.push(node); siblings = node.children;
  }
  if (!path.length) throw new Error('No readable expression at the cursor');
  if (!selection.isEmpty && !path.some(n => n.start === start && n.end === end)) {
    throw new Error('Select a complete expression');
  }
  return path;
}

function editExpression(lexical: LexicalSession, selection: vscode.Selection, operation: Operation): ExpressionEdit {
  const snapshot = lexical.snapshot;
  const start = snapshot.offset(selection.start), end = snapshot.offset(selection.end);
  const position = snapshot.offset(selection.active);
  const roots = lexical.data.structure.forms;
  const path = expressionPath(lexical, selection);
  let index = selection.isEmpty ? path.length - 1 : path.findIndex(n => n.start === start && n.end === end);
  if (operation.startsWith('slurp') || operation.startsWith('barf')) {
    while (index >= 0 && path[index].kind !== 'list') index--;
    if (index < 0) throw new Error('No enclosing proper list');
  }
  let unitIndex = index;
  while (unitIndex > 0 && path[unitIndex - 1].kind === 'prefix') unitIndex--;
  const node = path[index], unit = path[unitIndex], parent = path[unitIndex - 1];
  if (parent && parent.kind !== 'list') throw new Error('Unsupported expression container');
  if (parent) plainListRange(lexical, parent);
  const peers = parent ? parent.children : roots;
  const peerIndex = peers.indexOf(unit);
  const previous = peers[peerIndex - 1], next = peers[peerIndex + 1];
  const part = (n: ReaderNode): [number, number] => [n.start, n.end];
  const gap = (left: number, right: number): Piece => {
    if (!isTrivia(lexical, left, right)) throw new Error('Unsupported expression boundary');
    const text = snapshot.slice(left, right);
    if (!text) return ' ';
    const startsWithSpace = /^\s/u.test(text), endsWithSpace = /\s$/u.test(text);
    if (startsWithSpace && endsWithSpace) return [left, right];
    return `${startsWithSpace ? '' : ' '}${text}${endsWithSpace ? '' : ' '}`;
  };
  const buildEdit = (left: number, right: number, pieces: Piece[]): ExpressionEdit => {
    let text = '', cursor: number | undefined;
    for (const piece of pieces) {
      if (typeof piece === 'string') { text += piece; continue; }
      const [from, to] = piece;
      if (cursor === undefined && from <= position && position <= to) cursor = text.length + snapshot.slice(from, position).length;
      text += snapshot.slice(from, to);
    }
    let caret = cursor ?? 0;
    const before = left > 0 ? snapshot.slice(left - 1, left) : '';
    const after = snapshot.slice(right, Math.min(snapshot.length, right + 1));
    if (needsSeparator(before, text.slice(0, 1))) { text = ' ' + text; caret++; }
    if (needsSeparator(text.slice(-1), after)) text += ' ';
    return { start: left, end: right, text, cursor: caret };
  };
  if (operation === 'swapForward' || operation === 'swapBackward') {
    const left = operation === 'swapForward' ? unit : previous;
    const right = operation === 'swapForward' ? next : unit;
    if (!left || !right) throw new Error('No adjacent expression');
    return buildEdit(left.start, right.end, [part(right), gap(left.end, right.start), part(left)]);
  }
  if (operation === 'deleteExpression') {
    const before = unit.start > 0 ? snapshot.slice(unit.start - 1, unit.start) : '';
    const after = snapshot.slice(unit.end, Math.min(snapshot.length, unit.end + 1));
    return buildEdit(unit.start, unit.end, [before && after && !/\s/.test(before + after) ? ' ' : '']);
  }
  if (operation === 'raiseExpression') {
    if (!parent) throw new Error('No enclosing expression');
    let outer = unitIndex - 1;
    while (outer > 0 && path[outer - 1].kind === 'prefix') outer--;
    return buildEdit(path[outer].start, path[outer].end, [part(unit)]);
  }
  const range = plainListRange(lexical, node);
  const open: Piece = [range.start, range.openEnd], close: Piece = [range.closeStart, range.end];
  switch (operation) {
    case 'slurpForward':
      if (!next) throw new Error('No following expression');
      return buildEdit(node.start, next.end, [[node.start, range.closeStart], gap(node.end, next.start), part(next), close]);
    case 'slurpBackward':
      if (!previous) throw new Error('No preceding expression');
      return buildEdit(previous.start, node.end, [[unit.start, node.start], open, part(previous),
        gap(previous.end, unit.start), [range.openEnd, node.end]]);
    case 'barfForward': {
      const last = node.children.at(-1), prior = node.children.at(-2);
      if (!last) throw new Error('The list is empty');
      const boundary = prior?.end ?? range.openEnd;
      return buildEdit(node.start, node.end, [[node.start, boundary], close, gap(boundary, last.start),
        part(last), [last.end, range.closeStart]]);
    }
    case 'barfBackward': {
      const first = node.children[0], second = node.children[1];
      if (!first) throw new Error('The list is empty');
      const boundary = second?.start ?? range.closeStart;
      return buildEdit(unit.start, node.end, [part(first), gap(first.end, boundary), [unit.start, node.start], open,
        [range.openEnd, first.start], [boundary, node.end]]);
    }
  }
}

export function registerStructuralEditing(workspace: Workspace): vscode.Disposable[] {
  const subscriptions: vscode.Disposable[] = [];
  const command = (name: string, action: (editor: vscode.TextEditor, lexical: LexicalSession, assertCurrent: () => void) => Promise<void>) => {
    subscriptions.push(vscode.commands.registerCommand(name, async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isRacket(editor.document)) return;
      const selections = editor.selections;
      try {
        const lexical = await workspace.lexical(editor.document);
        const assertCurrent = () => {
          lexical.assertCurrent();
          if (vscode.window.activeTextEditor !== editor
            || selections.length !== editor.selections.length
            || selections.some((selection, i) => !selection.isEqual(editor.selections[i]))) {
            throw new vscode.CancellationError();
          }
        };
        assertCurrent();
        await action(editor, lexical, assertCurrent);
      } catch (error) {
        if (!isCancellation(error)) void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      }
    }));
  };
  for (const [name, direction] of [['forwardExpression', 'forward'], ['backwardExpression', 'backward'], ['upExpression', 'up'], ['downExpression', 'down']]) {
    command(`racket.${name}`, async (editor, lexical, assertCurrent) => {
      const position = await lexical.request<number | false>('navigate', { position: lexical.snapshot.offset(editor.selection.active), direction });
      assertCurrent();
      if (position !== false) {
        const target = lexical.snapshot.position(position);
        editor.selection = new vscode.Selection(target, target);
        editor.revealRange(editor.selection);
      }
    });
  }
  command('racket.selectExpression', async (editor, lexical, assertCurrent) => {
    const at = lexical.snapshot.offset(editor.selection.active);
    const candidates = [await expressionAt(lexical, at), ...surrounding(lexical, at)].filter(range => range !== undefined);
    assertCurrent();
    const selected = candidates.find(range => {
      const target = lexical.snapshot.range(range.start, range.end);
      return target.contains(editor.selection) && !target.isEqual(editor.selection);
    });
    if (selected) {
      const range = lexical.snapshot.range(selected.start, selected.end);
      editor.selection = new vscode.Selection(range.start, range.end);
    }
  });
  for (const [name, open, close] of [['wrapRound', '(', ')'], ['wrapSquare', '[', ']']]) command(`racket.${name}`, async (editor, lexical, assertCurrent) => {
    assertCurrent();
    const ranges = await Promise.all(editor.selections.map(async selection => {
      if (!selection.isEmpty) return new vscode.Range(selection.start, selection.end);
      const expression = await expressionAt(lexical, lexical.snapshot.offset(selection.active));
      return expression ? lexical.snapshot.range(expression.start, expression.end) : new vscode.Range(selection.active, selection.active);
    }));
    assertCurrent();
    const ordered = [...ranges].sort((a, b) => a.start.compareTo(b.start));
    if (ordered.some((range, i) => i > 0 && ordered[i - 1].end.isAfter(range.start))) throw new Error('Overlapping selections');
    const applied = await editor.edit(edit => {
      for (const range of ranges) edit.replace(range, open + editor.document.getText(range) + close);
    }, { undoStopBefore: true, undoStopAfter: true });
    if (!applied) throw new Error('Could not apply changes');
  });
  command('racket.unwrap', async (editor, lexical, assertCurrent) => {
    const snapshot = lexical.snapshot;
    const changes = editor.selections.map(selection => {
      const list = expressionPath(lexical, selection).filter(node => ['list', 'dotted'].includes(node.kind)).at(-1);
      if (!list) throw new Error('No enclosing proper list');
      const range = plainListRange(lexical, list);
      let text = snapshot.slice(range.openEnd, range.closeStart);
      const before = snapshot.slice(Math.max(0, range.start - 1), range.start);
      const after = snapshot.slice(range.end, Math.min(snapshot.length, range.end + 1));
      if (!text) { if (needsSeparator(before, after)) text = ' '; }
      else {
        if (needsSeparator(before, text[0])) text = ' ' + text;
        if (needsSeparator(text.slice(-1), after)) text += ' ';
      }
      return { ...range, text };
    });
    const unique = [...new Map(changes.map(change => [change.start, change])).values()].sort((a, b) => a.start - b.start);
    if (unique.some((change, i) => i > 0 && unique[i - 1].end > change.start)) throw new Error('Overlapping structural edits');
    assertCurrent();
    await applyEdits(editor, snapshot, unique);
  });

  command('racket.changeBrackets', async (editor, lexical, assertCurrent) => {
    const ranges = editor.selections.map(selection => {
      const path = expressionPath(lexical, selection);
      const list = path.filter(node => ['list', 'dotted'].includes(node.kind)).at(-1);
      if (!list || !selection.isEmpty && (lexical.snapshot.offset(selection.start) !== list.start
        || lexical.snapshot.offset(selection.end) !== list.end)) throw new Error('Select a complete list');
      const range = lexical.data.ranges.find(range => range.start === list.start && range.end === list.end
        && range.openEnd === list.start + 1 && range.closeStart === list.end - 1);
      if (!range) throw new Error('Unsupported list delimiters');
      return range;
    });
    const pair = await vscode.window.showQuickPick(['()', '[]', '{}']);
    if (!pair) return;
    assertCurrent();
    const unique = [...new Map(ranges.map(range => [range.start, range])).values()];
    await applyEdits(editor, lexical.snapshot, unique.flatMap(range => [
      { start: range.start, end: range.openEnd, text: pair[0] },
      { start: range.closeStart, end: range.end, text: pair[1] },
    ]));
  });

  command('racket.toggleExpressionComment', async (editor, lexical, assertCurrent) => {
    const edits = editor.selections.map(selection => {
      const start = lexical.snapshot.offset(selection.start), end = lexical.snapshot.offset(selection.end);
      const nextToken = lexical.data.tokens.find(token => token.start <= start && start < token.end);
      const afterExpression = selection.isEmpty && (!nextToken || ['white-space', 'comment'].includes(nextToken.attributes.type));
      const comments = lexical.data.comments.filter(comment => comment.start <= start && end <= comment.end
        && (!selection.isEmpty || start < comment.end || afterExpression));
      const comment = comments.sort((a, b) => a.end - a.start - (b.end - b.start))[0];
      if (comment) {
        if (lexical.data.comments.some(other => other !== comment && other.start < comment.end && comment.start < other.end)) {
          throw new Error('Ambiguous nested expression comment');
        }
        const selectsComment = start === comment.start && (end === comment.start + 2 || end === comment.end);
        const selectsBody = start === comment.bodyStart && end === comment.end;
        if (!selection.isEmpty && !selectsComment && !selectsBody) throw new Error('Select a complete expression comment');
        return { start: comment.start, end: comment.start + 2, text: '', scopeEnd: comment.end };
      }
      const path = expressionPath(lexical, selection);
      let index = selection.isEmpty ? path.length - 1 : path.findIndex(node => node.start === start && node.end === end);
      while (index > 0 && path[index - 1].kind === 'prefix') index--;
      const node = path[index];
      const parent = path[index - 1];
      if (parent && parent.kind !== 'list') throw new Error('Unsupported expression container');
      if (lexical.data.comments.some(comment => comment.start < node.end && node.start < comment.end)) {
        throw new Error('Ambiguous nested expression comment');
      }
      return { start: node.start, end: node.start, text: '#;', scopeEnd: node.end };
    });
    const unique = [...new Map(edits.map(edit => [edit.start, edit])).values()].sort((a, b) => a.start - b.start);
    if (unique.some((edit, i) => i > 0 && unique[i - 1].scopeEnd > edit.start)) throw new Error('Overlapping expression comments');
    assertCurrent();
    await applyEdits(editor, lexical.snapshot, unique);
  });

  for (const operation of operations) command(`racket.${operation}`, async (editor, lexical) => {
    const version = editor.document.version;
    const changes = editor.selections.map(selection => editExpression(lexical, selection, operation));
    const ordered = [...changes].sort((a, b) => a.start - b.start || a.end - b.end);
    if (ordered.some((change, i) => i > 0 && ordered[i - 1].end > change.start)) throw new Error('Overlapping structural edits');
    await applyEdits(editor, lexical.snapshot, changes);
    if (editor.document.version !== version + 1 || vscode.window.activeTextEditor !== editor) return;
    const selections = new Map<ExpressionEdit, vscode.Selection>();
    let delta = 0;
    for (const change of ordered) {
      const position = editor.document.positionAt(lexical.snapshot.rawOffset(change.start) + delta + change.cursor);
      selections.set(change, new vscode.Selection(position, position));
      delta += change.text.length - (lexical.snapshot.rawOffset(change.end) - lexical.snapshot.rawOffset(change.start));
    }
    editor.selections = changes.map(change => selections.get(change)!);
    editor.revealRange(editor.selection);
  });
  return subscriptions;
}
