/**
 * Practice session: a separate BoardController so training never touches the
 * real board. While active it is the board that input, toolbar commands, and
 * the renderer use; closing returns to the real board unchanged.
 */
import { BoardController } from '../board/controller';
import { PracticeCard, PracticeOffer } from '../ui/practice';
import type { AppConfig } from './config';
import { PracticeTracker } from './practice-tracker';

export interface PracticeHost {
  readonly config: () => AppConfig;
  readonly mainBoard: BoardController;
  readonly boardCenter: () => { x: number; y: number };
  readonly usingHands: () => boolean;
  readonly now: () => number;
  /** Switches the board used by input and rendering. */
  readonly setActiveBoard: (board: BoardController) => void;
  readonly onChange: () => void;
}

export class PracticeSession {
  readonly card: PracticeCard;
  readonly offer: PracticeOffer;
  private board: BoardController | null = null;
  private tracker: PracticeTracker | null = null;
  private offered = false;
  completions: number[] = [];

  constructor(private readonly host: PracticeHost) {
    this.card = new PracticeCard(() => this.stop());
    this.offer = new PracticeOffer(
      () => {
        this.offer.element.hidden = true;
        this.start();
      },
      () => {
        this.offer.element.hidden = true;
        host.onChange();
      },
    );
  }

  get active(): boolean {
    return this.board !== null;
  }

  get practiceBoard(): BoardController | null {
    return this.board;
  }

  /** Offers practice once per page session (on first camera readiness). */
  offerOnce(): void {
    if (this.offered || this.active) return;
    this.offered = true;
    this.offer.element.hidden = false;
    this.host.onChange();
  }

  start(): void {
    if (this.active) return;
    this.offer.element.hidden = true;
    const main = this.host.mainBoard;
    const board = new BoardController(this.host.config());
    board.setColor(main.color);
    board.setWidth(main.widthPx);
    const tracker = new PracticeTracker(this.host.now, this.host.boardCenter, board.view);
    let known = new Set<number>();
    board.onChange((kind) => {
      if (kind === 'doc') {
        const ids = new Set(board.doc.strokes.map((s) => s.id));
        for (const s of board.doc.strokes) if (!known.has(s.id)) tracker.strokeCommitted(s, board.view);
        const removed = [...known].filter((id) => !ids.has(id)).length;
        if (removed > 0 && board.erasing) tracker.strokesErased(removed, board.view);
        known = ids;
      } else if (kind === 'view') {
        tracker.viewChanged(board.view);
      }
      if (kind === 'doc' || kind === 'view') this.render();
    });
    this.board = board;
    this.tracker = tracker;
    this.host.setActiveBoard(board);
    this.card.show();
    this.render();
    this.host.onChange();
  }

  stop(): void {
    if (!this.active) return;
    if (this.tracker?.complete === true) this.completions.push(this.tracker.elapsedMs);
    this.board?.closeTransientWork();
    this.board = null;
    this.tracker = null;
    this.card.hide();
    this.host.setActiveBoard(this.host.mainBoard);
    this.host.onChange();
  }

  activate(target: string): boolean {
    if (target === 'practice-skip' || target === 'practice-done') this.stop();
    else if (target === 'practice-start') this.start();
    else if (target === 'practice-dismiss') {
      this.offer.element.hidden = true;
      this.host.onChange();
    } else return false;
    return true;
  }

  private render(): void {
    if (this.tracker !== null) this.card.render(this.tracker, this.host.usingHands());
  }
}
