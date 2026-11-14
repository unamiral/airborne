export type BoardBackground = 'plain' | 'grid' | 'cornell' | 'notebook' | 'camera';
export const BACKGROUNDS: readonly BoardBackground[] = ['plain', 'grid', 'cornell', 'notebook', 'camera'];
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Paper guides are fixed to the viewport; camera frames are mirrored like the preview. */
export function paintBackground(ctx: Context, width: number, height: number, scale: number, dark: boolean, background: BoardBackground, video?: HTMLVideoElement): void {
  ctx.save();
  ctx.fillStyle = dark ? '#000000' : '#ffffff';
  ctx.fillRect(0, 0, width * scale, height * scale);
  ctx.scale(scale, scale);
  if (background === 'camera') {
    if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const factor = Math.max(width / video.videoWidth, height / video.videoHeight);
      const w = video.videoWidth * factor, h = video.videoHeight * factor;
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(video, (width - w) / 2, (height - h) / 2, w, h);
    }
  } else if (background !== 'plain') {
    ctx.strokeStyle = dark ? '#364150' : '#dce4ee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const spacing = background === 'grid' ? 32 : 36;
    for (let y = spacing; y < height; y += spacing) { ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); }
    if (background === 'grid') for (let x = spacing; x < width; x += spacing) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, height); }
    ctx.stroke();
    if (background === 'notebook' || background === 'cornell') {
      ctx.strokeStyle = dark ? '#98666e' : '#e5a9b0';
      const margin = background === 'cornell' ? Math.min(200, width * 0.25) : Math.min(64, width * 0.15);
      ctx.beginPath(); ctx.moveTo(margin + 0.5, 0); ctx.lineTo(margin + 0.5, height);
      if (background === 'cornell') { const y = Math.max(0, height - Math.min(120, height * 0.2)); ctx.moveTo(0, y + 0.5); ctx.lineTo(width, y + 0.5); }
      ctx.stroke();
    }
  }
  ctx.restore();
}
