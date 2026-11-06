import { Annotation, SourceRange } from './protocol';
import { atPosition, rangeKey } from './documents';

export function bindingKeys(annotation: Annotation): string[] {
  const path = annotation.kind === 'definition' ? annotation.at?.source : annotation.path;
  if (!path || annotation.name === undefined) return [];
  const phases = annotation.kind === 'definition' ? [annotation.phaseSpace] : annotation.definitionPhases;
  return (phases || []).map(phase => JSON.stringify([path, annotation.submodules || [], annotation.name, phase]));
}

export function connected(annotations: Annotation[], seeds: SourceRange[]): { ranges: SourceRange[]; edges: Annotation[] } {
  const adjacent = new Map<string, Annotation[]>();
  for (const edge of annotations) {
    if (edge.kind !== 'binding' || !edge.actual || edge.require || !edge.from || !edge.to) continue;
    for (const range of [edge.from, edge.to]) {
      const key = rangeKey(range);
      const entries = adjacent.get(key) || [];
      entries.push(edge);
      adjacent.set(key, entries);
    }
  }
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

export function bindingAt(annotations: Annotation[], source: string, position: number) {
  const possible: SourceRange[] = [];
  for (const a of annotations) {
    if (a.kind === 'binding' && a.actual && !a.require) {
      for (const range of [a.from, a.to]) if (range && atPosition(range, source, position)) possible.push(range);
    }
    if (['definition', 'jump', 'unusedBinding'].includes(a.kind) && a.at && atPosition(a.at, source, position)) possible.push(a.at);
  }
  possible.sort((a, b) => a.end - a.start - (b.end - b.start));
  const seed = possible[0];
  const group = connected(annotations, seed ? [seed] : []);
  const selectedRanges = new Set(group.ranges.map(rangeKey));
  const selected = annotations.filter(a => a.at && selectedRanges.has(rangeKey(a.at)));
  const keys = new Set(selected.flatMap(bindingKeys));
  const unresolvedImports = selected.some(a => a.kind === 'jump' && bindingKeys(a).length !== 1);
  return { ...group, keys, unresolvedImports };
}

export function matchingRanges(annotations: Annotation[], keys: Set<string>): SourceRange[] {
  const seeds = annotations.flatMap(a => a.at && bindingKeys(a).some(key => keys.has(key)) ? [a.at] : []);
  return connected(annotations, seeds).ranges;
}
