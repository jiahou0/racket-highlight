import * as vscode from 'vscode';
import { SourceRange } from './protocol';

function indexAtOrBefore(offsets: readonly number[], value: number): number {
  let low = 0, high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (offsets[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

export class Snapshot {
  readonly text: string;
  // Racket counts normalized characters; VS Code counts original UTF-16 units.
  private readonly utf16Offsets: number[] = [0];
  private readonly lineStarts: number[] = [0];

  constructor(readonly uri: vscode.Uri, readonly original: string, readonly version?: number) {
    const characters: string[] = [];
    for (let offset = 0; offset < original.length;) {
      const codePoint = original.codePointAt(offset)!;
      if (codePoint === 13) {
        offset += original.charCodeAt(offset + 1) === 10 ? 2 : 1;
        characters.push('\n');
        this.lineStarts.push(offset);
      } else {
        characters.push(String.fromCodePoint(codePoint));
        offset += codePoint > 0xffff ? 2 : 1;
        if (codePoint === 10) this.lineStarts.push(offset);
      }
      this.utf16Offsets.push(offset);
    }
    this.text = characters.join('');
  }
  get length(): number { return this.utf16Offsets.length - 1; }
  rawOffset(offset: number): number { return this.utf16Offsets[offset]; }
  offset(position: vscode.Position): number {
    const raw = (this.lineStarts[position.line] ?? this.original.length) + position.character;
    return indexAtOrBefore(this.utf16Offsets, raw);
  }
  position(offset: number): vscode.Position {
    const raw = this.rawOffset(Math.max(0, Math.min(this.length, offset)));
    const line = indexAtOrBefore(this.lineStarts, raw);
    return new vscode.Position(line, raw - this.lineStarts[line]);
  }
  range(start: number, end: number): vscode.Range { return new vscode.Range(this.position(start), this.position(end)); }
  slice(start: number, end: number): string { return this.original.slice(this.rawOffset(start), this.rawOffset(end)); }
  contains(range: SourceRange): boolean { return range.start >= 0 && range.end >= range.start && range.end <= this.length; }
}

export const isRacket = (document: vscode.TextDocument): boolean => document.languageId === 'racket';
export const atPosition = (range: SourceRange | false | undefined, source: string, position: number): boolean =>
  !!range && range.source === source && range.start <= position && (position < range.end || range.start === range.end && position === range.start);
export const rangeKey = (range: SourceRange): string => JSON.stringify([range.source, range.start, range.end]);
export const sameRange = (a: SourceRange, b: SourceRange): boolean =>
  a.source === b.source && a.start === b.start && a.end === b.end;
export const isCancellation = (error: unknown): boolean => error instanceof vscode.CancellationError;
export function assertNotCancelled(token?: vscode.CancellationToken): void {
  if (token?.isCancellationRequested) throw new vscode.CancellationError();
}
