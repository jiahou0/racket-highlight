import * as vscode from 'vscode';
import { Annotation, ReaderNode, SourceRange } from './protocol';
import { LexicalSession } from './workspace';
import { sameRange } from './documents';
import { connected } from './bindings';

// This is an editing hint for standard Racket, not a binding analysis. Walk
// lexer tokens only up to the completion target so unfinished lists still work.
export function completionContext(lexical: LexicalSession, start: number): { modulePath: boolean; literal: boolean; inRequire: boolean } | undefined {
  const headerEnd = lexical.data.structure.headerEnd;
  if (headerEnd === false || start < headerEnd) return;
  interface Frame { head?: string; count: number; slot: number; close: string; literal: boolean }
  const frames: Frame[] = [];
  let prefix = false;
  for (const t of lexical.data.tokens) {
    if (t.start >= start) break;
    if (t.end <= headerEnd || t.attributes['comment?'] || ['white-space', 'comment', 'sexp-comment'].includes(t.attributes.type)) continue;
    const text = lexical.snapshot.slice(t.start, t.end);
    const parent = frames.at(-1);
    if (["'", '`', "#'", '#`', '#&', ',', ',@', '#,', '#,@'].includes(text)) {
      prefix = true;
      continue;
    }
    if (t.paren && ['(', '[', '{'].includes(t.paren)) {
      const slot = parent?.count ?? 0;
      if (parent) parent.count++;
      frames.push({ count: 0, slot, close: t.paren === '(' ? ')' : t.paren === '[' ? ']' : '}',
        literal: !!parent?.literal || prefix || text !== t.paren });
      prefix = false;
    } else if (t.paren && [')', ']', '}'].includes(t.paren)) {
      if (!parent || parent.close !== text || prefix) return;
      frames.pop();
    } else {
      if (t.attributes.type === 'error') return;
      if (parent) {
        if (!parent.count && !prefix && t.attributes.type === 'symbol') {
          parent.head = text;
          if (['quote', 'quasiquote', 'syntax', 'quasisyntax', 'quote-syntax'].includes(text)) parent.literal = true;
        }
        parent.count++;
      }
      prefix = false;
    }
  }
  const literal = prefix || !!frames.at(-1)?.literal;
  const bodySlot = (index: number, slot: number): boolean => {
    if (index < 0) return true;
    const frame = frames[index];
    const minimum = frame.head === 'module' || frame.head === 'module*' ? 3
      : frame.head === 'module+' ? 2 : frame.head === 'begin' || frame.head === 'begin-for-syntax' ? 1 : undefined;
    return minimum !== undefined && slot >= minimum && bodySlot(index - 1, frame.slot);
  };
  const requireForm = (index: number): boolean => frames[index].head === 'require' && bodySlot(index - 1, frames[index].slot);
  const moduleSlot = (index: number, slot: number): boolean => {
    if (index < 0) return false;
    if (requireForm(index)) return slot >= 1;
    const frame = frames[index];
    if (!moduleSlot(index - 1, frame.slot)) return false;
    switch (frame.head) {
      case 'only-in': case 'except-in': case 'rename-in': return slot === 1;
      case 'prefix-in': return slot === 2;
      case 'for-syntax': case 'for-template': case 'for-label': case 'combine-in': return slot >= 1;
      case 'for-meta': case 'for-space': return slot >= 2;
      default: return false;
    }
  };
  return { literal, modulePath: !literal && moduleSlot(frames.length - 1, frames.at(-1)?.count ?? 0),
    inRequire: frames.some((_frame, index) => requireForm(index)) };
}

interface Parameter {
  label: string;
  keyword?: string;
  optional: boolean;
  rest: boolean;
}
interface SourceDefinition {
  name: string;
  id: ReaderNode;
  form: ReaderNode;
  kind: vscode.SymbolKind;
  signatures: Parameter[][];
}

function readerNodes(forms: ReaderNode[]): ReaderNode[] {
  return forms.flatMap(form => [form, ...readerNodes(form.children)]);
}

function sourceDefinitions(lexical: LexicalSession, annotations: Annotation[], source: string): SourceDefinition[] {
  const formKinds = new Map<string, Set<string>>();
  for (const { kind, at, form } of annotations) if (kind === 'sourceForm' && at?.source === source && form) {
    const key = `${at.start}:${at.end}`;
    const kinds = formKinds.get(key) || new Set<string>();
    kinds.add(form);
    formKinds.set(key, kinds);
  }
  const formKind = (node: ReaderNode): string | undefined => {
    const head = node.children[0];
    const kinds = head && formKinds.get(`${head.start}:${head.end}`);
    return kinds?.size === 1 ? [...kinds][0] : undefined;
  };
  const text = (node: ReaderNode) => lexical.snapshot.slice(node.start, node.end);
  const identifier = (node: ReaderNode | undefined): node is ReaderNode & { kind: 'atom'; name: string } => !!node && node.kind === 'atom'
    && node.atomKind === 'symbol';
  const parameters = (node: ReaderNode, skip = 0): Parameter[] | undefined => {
    if (identifier(node) && !skip) return [{ label: text(node), optional: false, rest: true }];
    if (!['list', 'dotted'].includes(node.kind)) return;
    const children = node.children.slice(skip);
    const result: Parameter[] = [];
    for (let i = 0; i < children.length; i++) {
      let item = children[i];
      let keyword: string | undefined;
      let keywordLabel = '';
      if (item.atomKind === 'keyword') {
        keyword = String(item.name);
        keywordLabel = text(item);
        item = children[++i];
        if (!item) return;
      }
      const optional = item.kind === 'list' && item.children.length === 2 && identifier(item.children[0]);
      if (!optional && !identifier(item)) return;
      const rest = node.kind === 'dotted' && i === children.length - 1;
      if (rest && (keyword || optional)) return;
      result.push({ label: `${keyword ? keywordLabel + ' ' : ''}${text(item)}`, keyword, optional, rest });
    }
    return result;
  };
  const lambdaSignatures = (rhs: ReaderNode | undefined): Parameter[][] => {
    if (!rhs) return [];
    const kind = formKind(rhs);
    if (kind === 'lambda' && rhs.children[1]) {
      const params = parameters(rhs.children[1]);
      return params ? [params] : [];
    }
    if (kind === 'case-lambda') {
      const variants: Parameter[][] = [];
      for (const clause of rhs.children.slice(1)) {
        const params = clause.children[0] && parameters(clause.children[0]);
        if (!params) return [];
        variants.push(params);
      }
      return variants;
    }
    return [];
  };
  const result: SourceDefinition[] = [];
  for (const form of readerNodes(lexical.data.structure.forms)) {
    const kind = formKind(form), target = form.children[1];
    if (!kind || !target) continue;
    let ids: ReaderNode[] = [], symbolKind = vscode.SymbolKind.Variable, signatures: Parameter[][] = [];
    switch (kind) {
      case 'define':
        if (identifier(target)) { ids = [target]; signatures = lambdaSignatures(form.children[2]); }
        else if (['list', 'dotted'].includes(target.kind) && identifier(target.children[0])) {
          ids = [target.children[0]];
          const params = parameters(target, 1); if (params) signatures = [params];
        }
        if (signatures.length) symbolKind = vscode.SymbolKind.Function;
        break;
      case 'define-values':
        ids = target.children.filter(identifier);
        if (ids.length === 1) signatures = lambdaSignatures(form.children[2]);
        if (signatures.length) symbolKind = vscode.SymbolKind.Function;
        break;
      case 'define-syntax': case 'define-syntax-rule':
        ids = identifier(target) ? [target] : target.children.slice(0, 1).filter(identifier);
        symbolKind = vscode.SymbolKind.Operator;
        break;
      case 'define-syntaxes': ids = target.children.filter(identifier); symbolKind = vscode.SymbolKind.Operator; break;
      case 'struct': case 'define-struct':
        ids = identifier(target) ? [target] : target.children.slice(0, 1).filter(identifier);
        symbolKind = vscode.SymbolKind.Struct;
        break;
      case 'module': case 'module*': case 'module+':
        ids = identifier(target) ? [target] : []; symbolKind = vscode.SymbolKind.Module;
        break;
    }
    for (const id of ids) result.push({ name: String(id.name), id, form, kind: symbolKind, signatures });
  }
  return result;
}

export function outlineSymbols(lexical: LexicalSession, annotations: Annotation[], source: string, complete: boolean): vscode.DocumentSymbol[] {
  const snapshot = lexical.snapshot;
  if (!complete) {
    // These are reader forms, not inferred definitions or stale semantic symbols.
    return lexical.data.structure.forms.map(form => {
      const line = snapshot.slice(form.start, form.end).split(/\r?\n/, 1)[0];
      const name = line.length > 80 ? line.slice(0, 77) + '…' : line;
      const head = form.children[0] || form;
      return new vscode.DocumentSymbol(name, '', vscode.SymbolKind.Object,
        snapshot.range(form.start, form.end), snapshot.range(head.start, head.end));
    });
  }
  const definitions = sourceDefinitions(lexical, annotations, source);
  const entries = definitions.map(d => ({ start: d.form.start, end: d.form.end,
    id: d.id.start, symbol: new vscode.DocumentSymbol(d.name, '', d.kind,
      snapshot.range(d.form.start, d.form.end), snapshot.range(d.id.start, d.id.end)) }));
  for (const { name, at, span, symbolKind } of [
    ...annotations.filter(a => a.kind === 'outline'), ...annotations.filter(a => a.kind === 'definition'),
  ]) {
    if (!name || at?.source !== source || !snapshot.contains(at)) continue;
    const existing = entries.find(entry => entry.id === at.start);
    if (existing) {
      // An unavailable source signature must not erase a confirmed function kind.
      if (symbolKind === 'function' && existing.symbol.kind === vscode.SymbolKind.Variable) {
        existing.symbol.kind = vscode.SymbolKind.Function;
      }
      continue;
    }
    const range = span?.source === source && snapshot.contains(span) ? span : at;
    const kind = symbolKind === 'module' ? vscode.SymbolKind.Module : symbolKind === 'macro' ? vscode.SymbolKind.Operator
      : symbolKind === 'function' ? vscode.SymbolKind.Function : vscode.SymbolKind.Variable;
    entries.push({ start: range.start, end: range.end, id: at.start,
      symbol: new vscode.DocumentSymbol(name, '', kind, snapshot.range(range.start, range.end), snapshot.range(at.start, at.end)) });
  }
  entries.sort((a, b) => a.start - b.start || b.end - a.end || a.id - b.id);
  const roots: vscode.DocumentSymbol[] = [];
  const stack: typeof entries = [];
  for (const entry of entries) {
    while (stack.length) {
      const parent = stack.at(-1)!;
      const strictlyContains = parent.start <= entry.start && entry.end <= parent.end
        && (parent.start < entry.start || entry.end < parent.end);
      if (strictlyContains) break;
      stack.pop();
    }
    (stack.at(-1)?.symbol.children || roots).push(entry.symbol);
    stack.push(entry);
  }
  return roots;
}

function signatureInformation(name: string, parameters: Parameter[]): vscode.SignatureInformation {
  let label = `(${name}`;
  const information: vscode.ParameterInformation[] = [];
  for (const parameter of parameters) {
    label += parameter.rest ? ' . ' : ' ';
    const start = label.length;
    label += parameter.label;
    information.push(new vscode.ParameterInformation([start, label.length]));
  }
  const signature = new vscode.SignatureInformation(label + ')');
  signature.parameters = information;
  return signature;
}

function activeParameter(parameters: Parameter[], args: ReaderNode[], offset: number): number | undefined {
  let positional = 0;
  const positionalParameters = parameters.map((parameter, index) => ({ parameter, index })).filter(p => !p.parameter.keyword);
  const last = positionalParameters.at(-1);
  for (let i = 0; i <= args.length; i++) {
    const arg = args[i];
    const keyword = arg?.atomKind === 'keyword' ? String(arg.name) : undefined;
    if (keyword) {
      const value = args[i + 1];
      if (offset <= (value?.end ?? arg.end) || !value) {
        const index = parameters.findIndex(parameter => parameter.keyword === keyword);
        return index < 0 ? undefined : index;
      }
      i++;
    } else {
      const candidate = positionalParameters[positional] || (last?.parameter.rest ? last : undefined);
      if (!arg || offset <= arg.end) return candidate?.index;
      positional++;
    }
  }
  return undefined;
}

export function localSignatureHelp(lexical: LexicalSession, annotations: Annotation[], source: string,
  operator: SourceRange, offset: number): vscode.SignatureHelp | undefined {
  const call = readerNodes(lexical.data.structure.forms).find(node => node.kind === 'list'
    && node.start <= offset && offset <= node.end
    && node.children[0]?.start === operator.start && node.children[0]?.end === operator.end);
  if (!call) return;
  const group = connected(annotations, [operator]);
  const targets = [...group.ranges, ...annotations.filter(a => a.kind === 'callBinding' && a.at && sameRange(a.at, operator))
    .flatMap(a => a.definitionAt ? [a.definitionAt] : [])];
  const mutated = annotations.some(({ kind, style, at }) => kind === 'style' && style === 'drracket:check-syntax:set!d'
    && at && targets.some(range => sameRange(range, at)));
  if (mutated) return;
  const definitions = sourceDefinitions(lexical, annotations, source)
    .filter(d => d.signatures.length && targets.some(range => range.source === source && range.start === d.id.start && range.end === d.id.end));
  if (definitions.length !== 1) return;
  const variants = definitions[0].signatures;
  const name = lexical.snapshot.slice(operator.start, operator.end);
  const help = new vscode.SignatureHelp();
  help.signatures = variants.map(parameters => signatureInformation(name, parameters));
  const args = call.children.slice(1);
  let positionalCount = 0;
  const keywords = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    if (args[i].atomKind === 'keyword') { keywords.add(String(args[i].name)); i++; }
    else positionalCount++;
  }
  const fitting = variants.findIndex(parameters => {
    const positional = parameters.filter(p => !p.keyword);
    return positionalCount >= positional.filter(p => !p.optional && !p.rest).length
      && (positional.some(p => p.rest) || positionalCount <= positional.length)
      && [...keywords].every(keyword => parameters.some(p => p.keyword === keyword))
      && parameters.every(p => !p.keyword || p.optional || keywords.has(p.keyword));
  });
  help.activeSignature = fitting < 0 ? 0 : fitting;
  for (let i = 0; i < variants.length; i++) {
    help.signatures[i].activeParameter = activeParameter(variants[i], args, offset) ?? variants[i].length;
  }
  help.activeParameter = help.signatures[help.activeSignature].activeParameter!;
  return help;
}
