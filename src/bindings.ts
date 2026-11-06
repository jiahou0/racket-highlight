import { Annotation, SourceRange } from './protocol';
import { atPosition, rangeKey } from './documents';

interface AnnotationRange {
  range: SourceRange;
  index: number;
  maxEnd: number;
  left?: AnnotationRange;
  right?: AnnotationRange;
}
interface AnnotationIndex {
  adjacent: Map<string, Annotation[]>;
  positions: Map<SourceRange['source'], AnnotationRange>;
  byRange: Map<string, number[]>;
  byBinding: Map<string, number[]>;
}

// Analysis annotations are immutable for the lifetime of their session.
const annotationIndexes = new WeakMap<readonly Annotation[], AnnotationIndex>();

function buildRangeTree(sorted: AnnotationRange[], start = 0, end = sorted.length): AnnotationRange | undefined {
  if (start === end) return;
  const middle = (start + end) >>> 1;
  const node = sorted[middle];
  node.left = buildRangeTree(sorted, start, middle);
  node.right = buildRangeTree(sorted, middle + 1, end);
  node.maxEnd = Math.max(node.range.end, node.left?.maxEnd ?? node.range.end, node.right?.maxEnd ?? node.range.end);
  return node;
}

function getAnnotationIndex(annotations: readonly Annotation[]): AnnotationIndex {
  const cached = annotationIndexes.get(annotations);
  if (cached) return cached;
  const adjacent = new Map<string, Annotation[]>();
  const byRange = new Map<string, number[]>();
  const byBinding = new Map<string, number[]>();
  const rangesBySource = new Map<SourceRange['source'], AnnotationRange[]>();
  for (const [index, annotation] of annotations.entries()) {
    if (annotation.at) {
      const key = rangeKey(annotation.at);
      const entries = byRange.get(key) || [];
      entries.push(index);
      byRange.set(key, entries);
    }
    for (const key of bindingKeys(annotation)) {
      const entries = byBinding.get(key) || [];
      entries.push(index);
      byBinding.set(key, entries);
    }
    for (const range of [annotation.at, annotation.from, annotation.to]) {
      if (!range) continue;
      const entries = rangesBySource.get(range.source) || [];
      entries.push({ range, index, maxEnd: range.end });
      rangesBySource.set(range.source, entries);
    }
    if (annotation.kind !== 'binding' || !annotation.actual || annotation.require || !annotation.from || !annotation.to) continue;
    for (const range of [annotation.from, annotation.to]) {
      const key = rangeKey(range);
      const entries = adjacent.get(key) || [];
      entries.push(annotation);
      adjacent.set(key, entries);
    }
  }
  const positions = new Map<SourceRange['source'], AnnotationRange>();
  for (const [source, entries] of rangesBySource) {
    entries.sort((a, b) => a.range.start - b.range.start);
    positions.set(source, buildRangeTree(entries)!);
  }
  const result = { adjacent, positions, byRange, byBinding };
  annotationIndexes.set(annotations, result);
  return result;
}

function indexedAnnotations(annotations: readonly Annotation[], index: Map<string, number[]>, keys: Iterable<string>): Annotation[] {
  const matches = new Set<number>();
  for (const key of keys) for (const position of index.get(key) || []) matches.add(position);
  return [...matches].sort((a, b) => a - b).map(position => annotations[position]);
}

export function annotationsForRanges(annotations: readonly Annotation[], ranges: SourceRange[]): Annotation[] {
  return indexedAnnotations(annotations, getAnnotationIndex(annotations).byRange, ranges.map(rangeKey));
}

export function annotationsForBindings(annotations: readonly Annotation[], keys: Iterable<string>): Annotation[] {
  return indexedAnnotations(annotations, getAnnotationIndex(annotations).byBinding, keys);
}

export function annotationsAt(annotations: readonly Annotation[], source: string, position: number): Annotation[] {
  const matches = new Set<number>();
  // Macros can reuse or overlap source ranges. Prune only subtrees that cannot
  // contain the cursor, preserving enclosing and zero-width annotations too.
  const visit = (node: AnnotationRange | undefined) => {
    if (!node || node.maxEnd < position) return;
    visit(node.left);
    if (node.range.start > position) return;
    if (atPosition(node.range, source, position)) matches.add(node.index);
    visit(node.right);
  };
  visit(getAnnotationIndex(annotations).positions.get(source));
  return [...matches].sort((a, b) => a - b).map(index => annotations[index]);
}

export function bindingKeys(annotation: Annotation): string[] {
  const path = annotation.kind === 'definition' ? annotation.at?.source : annotation.path;
  if (!path || annotation.name === undefined) return [];
  const phases = annotation.kind === 'definition' ? [annotation.phaseSpace] : annotation.definitionPhases;
  return (phases || []).map(phase => JSON.stringify([path, annotation.submodules || [], annotation.name, phase]));
}

export function connected(annotations: readonly Annotation[], seeds: SourceRange[]): { ranges: SourceRange[]; edges: Annotation[] } {
  if (!seeds.length) return { ranges: [], edges: [] };
  const { adjacent } = getAnnotationIndex(annotations);
  const ranges = new Map(seeds.map(range => [rangeKey(range), range]));
  const edges = new Set<Annotation>();
  // Map iteration also visits newly discovered ranges, without rescanning the
  // entire file for each additional link in a binding chain.
  for (const key of ranges.keys()) {
    for (const edge of adjacent.get(key) || []) {
      edges.add(edge);
      for (const range of [edge.from!, edge.to!]) ranges.set(rangeKey(range), range);
    }
  }
  return { ranges: [...ranges.values()], edges: [...edges] };
}

export function bindingAt(annotations: readonly Annotation[], source: string, position: number) {
  let seed: SourceRange | undefined;
  const consider = (range: SourceRange | undefined) => {
    if (range && atPosition(range, source, position) && (!seed || range.end - range.start < seed.end - seed.start)) seed = range;
  };
  for (const a of annotationsAt(annotations, source, position)) {
    if (a.kind === 'binding' && a.actual && !a.require) {
      consider(a.from); consider(a.to);
    }
    if (['definition', 'jump', 'unusedBinding'].includes(a.kind)) consider(a.at);
  }
  const group = connected(annotations, seed ? [seed] : []);
  const selected = annotationsForRanges(annotations, group.ranges);
  const keys = new Set(selected.flatMap(bindingKeys));
  const unresolvedImports = selected.some(a => a.kind === 'jump' && bindingKeys(a).length !== 1);
  return { ...group, keys, unresolvedImports };
}

export function matchingRanges(annotations: readonly Annotation[], keys: Set<string>): SourceRange[] {
  const seeds = annotationsForBindings(annotations, keys).flatMap(a => a.at ? [a.at] : []);
  return connected(annotations, seeds).ranges;
}

export function importEdgesForSelection(annotations: readonly Annotation[], ranges: SourceRange[], source: string, position: number): Annotation[] {
  // prefix-in splits the complete identifier into prefix and name endpoints.
  // Containment is for display only; binding identity still uses exact ranges.
  return annotations.filter(({ kind, actual, require, from, to }) => kind === 'binding' && actual && require && from && to
    && (atPosition(from, source, position) || atPosition(to, source, position)
      || ranges.some(range => range.source === to.source && range.start <= to.start && to.end <= range.end)));
}
