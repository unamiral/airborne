/**
 * Undo/redo of user actions (plan §10 "History and bounds"): one stroke, one
 * erase gesture, or one clear. View changes and settings are not history.
 * Commands reference immutable strokes shared with the document (no copies),
 * restore the original order exactly, and are capped by action count and by
 * retained payload; the oldest undo entries are evicted first, never the
 * current board content.
 */
import type { BoardDocument } from './document';
import { strokeBytes, type Stroke } from './stroke';

export type Command =
  | { readonly kind: 'replace'; readonly strokes: readonly Stroke[]; readonly originals: readonly Stroke[] }
  | { readonly kind: 'add'; readonly strokes: readonly Stroke[] }
  | { readonly kind: 'remove'; readonly strokes: readonly Stroke[] }
  | { readonly kind: 'clear'; readonly strokes: readonly Stroke[] };

export interface HistoryLimits {
  readonly maxActions: number;
  readonly maxBytes: number;
}

function payload(command: Command): number {
  let bytes = 64;
  for (const s of command.strokes) bytes += strokeBytes(s);
  if (command.kind === 'replace') for (const s of command.originals) bytes += strokeBytes(s);
  return bytes;
}

function apply(doc: BoardDocument, command: Command): void {
  switch (command.kind) {
    case 'replace':
      doc.remove(new Set(command.originals.map((s) => s.id)));
      doc.insert(command.strokes);
      return;
    case 'add':
      doc.insert(command.strokes);
      return;
    case 'remove':
    case 'clear':
      doc.remove(new Set(command.strokes.map((s) => s.id)));
      return;
  }
}

function revert(doc: BoardDocument, command: Command): void {
  switch (command.kind) {
    case 'replace':
      doc.remove(new Set(command.strokes.map((s) => s.id)));
      doc.insert(command.originals);
      return;
    case 'add':
      doc.remove(new Set(command.strokes.map((s) => s.id)));
      return;
    case 'remove':
    case 'clear':
      doc.insert(command.strokes);
      return;
  }
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private bytes = 0;
  evicted = 0;

  constructor(private limits: HistoryLimits) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get retainedBytes(): number {
    return this.bytes;
  }

  /** Most recent undoable action (for observers such as the practice tracker). */
  get lastCommand(): Command | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  setLimits(limits: HistoryLimits): void {
    this.limits = limits;
    this.enforce();
  }

  /** Records an action that has already been applied to the document. */
  record(command: Command): void {
    if (command.strokes.length === 0) return;
    for (const c of this.redoStack) this.bytes -= payload(c);
    this.redoStack = [];
    this.undoStack.push(command);
    this.bytes += payload(command);
    this.enforce();
  }

  undo(doc: BoardDocument): Command | null {
    const command = this.undoStack.pop();
    if (command === undefined) return null;
    revert(doc, command);
    this.redoStack.push(command);
    return command;
  }

  redo(doc: BoardDocument): Command | null {
    const command = this.redoStack.pop();
    if (command === undefined) return null;
    apply(doc, command);
    this.undoStack.push(command);
    return command;
  }

  private enforce(): void {
    while (this.undoStack.length > 0 && (this.undoStack.length > this.limits.maxActions || this.bytes > this.limits.maxBytes)) {
      const oldest = this.undoStack.shift()!;
      this.bytes -= payload(oldest);
      this.evicted++;
    }
  }
}
