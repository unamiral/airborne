import type { Stroke } from '../board/stroke';
import { el, setText } from './dom';

interface NativeStroke { addPoint(point: { x: number; y: number }): void }
interface NativeDrawing {
  addStroke(stroke: NativeStroke): void;
  getPrediction(): Promise<Array<{ text: string }>>;
  clear(): void;
}
interface NativeRecognizer {
  startDrawing(hints: { recognitionType: string }): NativeDrawing;
  finish(): void;
}
type HandwritingNavigator = Navigator & {
  createHandwritingRecognizer?: (constraints: { languages: string[] }) => Promise<NativeRecognizer>;
};
type HandwritingGlobal = typeof globalThis & { HandwritingStroke?: new () => NativeStroke };

/** Recognizes a snapshot locally; ink is never changed by a prediction. */
export async function recognizeHandwriting(strokes: readonly Stroke[]): Promise<string> {
  const create = (navigator as HandwritingNavigator).createHandwritingRecognizer;
  const StrokeClass = (globalThis as HandwritingGlobal).HandwritingStroke;
  if (create === undefined || StrokeClass === undefined) {
    throw new Error('Handwriting recognition is not available in this browser or on this device.');
  }
  if (strokes.length === 0) throw new Error('Write something on the board first.');
  const recognizer = await create.call(navigator, { languages: ['en'] });
  try {
    const drawing = recognizer.startDrawing({ recognitionType: 'text' });
    try {
      for (const ink of strokes) {
        const stroke = new StrokeClass();
        ink.points.forEach((x, y) => stroke.addPoint({ x, y }));
        drawing.addStroke(stroke);
      }
      const predictions = await drawing.getPrediction();
      const text = predictions[0]?.text.trim();
      if (!text) throw new Error('No text was recognized. Try writing larger, separated letters.');
      return text;
    } finally {
      drawing.clear();
    }
  } finally {
    recognizer.finish();
  }
}

export class HandwritingDialog {
  readonly element: HTMLDialogElement;
  private readonly status = el('p', { class: 'help', role: 'status' });
  private readonly result = el('textarea', { 'aria-label': 'Recognized text', rows: 5, placeholder: 'Recognized text appears here for you to edit.' });
  private request = 0;

  constructor(onClose: () => void) {
    const close = el('button', { type: 'button', class: 'primary', 'data-hand-target': 'text-close' }, ['Done']);
    close.addEventListener('click', () => this.close());
    this.element = el('dialog', { class: 'card settings', 'aria-labelledby': 'text-title' }, [
      el('h2', { id: 'text-title' }, ['Handwriting to text']),
      el('p', { class: 'help' }, ['Recognize the board’s handwriting locally. Review and edit the result below; your drawing stays on the board.']),
      this.status, this.result,
      el('div', { class: 'actions' }, [close]),
    ]);
    this.element.addEventListener('close', () => { this.request++; onClose(); });
  }
  get isOpen(): boolean { return this.element.open; }
  open(strokes: readonly Stroke[]): void {
    const request = ++this.request;
    this.result.value = '';
    setText(this.status, 'Recognizing handwriting…');
    if (!this.element.open) this.element.showModal();
    void recognizeHandwriting([...strokes]).then((text) => {
      if (request !== this.request) return;
      this.result.value = text;
      setText(this.status, 'Review and edit the recognized text.');
    }).catch((error: unknown) => {
      if (request !== this.request) return;
      setText(this.status, error instanceof Error ? error.message : 'Recognition is unavailable on this device.');
    });
  }
  close(): void { if (this.element.open) this.element.close(); }
  activate(target: string): boolean {
    if (target !== 'text-close') return false;
    this.close();
    return true;
  }
}
