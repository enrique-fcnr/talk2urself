// Records a video of the conversation without screen recording: right after each frame of Kelly is rendered, the page
// redraws what the viewer sees (background, halo, Kelly with her fade, the captions, the start screen, the memories view)
// onto a canvas of its own, and that canvas plus the clone's voice go into a MediaRecorder. The header buttons, the
// recording controls and the user's voice never enter it.
// It aims for 60 frames a second; if the phone cannot keep that up it settles on a steady 30 instead.

type Listener = (avatar: HTMLCanvasElement) => void;
let listener: Listener | null = null;
// Called by the avatar after every render, while its drawing buffer still holds the frame.
export function frameRendered(avatar: HTMLCanvasElement) { listener?.(avatar); }

// stop() gives the video, or the reason there is none (the recorder failed, or nothing was recorded).
export type SessionVideo = { stop(): Promise<{ blob: Blob } | { error: string }>; readonly fps: number };
const types = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];
export const videoSupported = () => typeof MediaRecorder !== 'undefined' && 'captureStream' in HTMLCanvasElement.prototype;
export const videoExtension = (blob: Blob) => blob.type.includes('mp4') ? 'mp4' : 'webm';

// The bust fade from the stylesheet (an S-curve from fully clear to solid), as [alpha, position 0..1] stops.
const bustStops = [[0, 0], [.028, .1], [.104, .2], [.242, .32], [.425, .45], [.619, .58], [.784, .7], [.914, .82], [.982, .92], [1, 1]] as const;

export function startSessionVideo(voice: MediaStream | null): SessionVideo {
  const width = innerWidth, height = innerHeight, scale = Math.min(devicePixelRatio || 1, 1080 / width);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  const canvas = document.createElement('canvas'), layer = document.createElement('canvas');
  canvas.width = layer.width = even(width * scale); canvas.height = layer.height = even(height * scale);
  const sx = canvas.width / width, sy = canvas.height / height;
  const ctx = canvas.getContext('2d', { alpha: false })!, lay = layer.getContext('2d')!;

  const stream = canvas.captureStream(60);
  for (const track of voice?.getAudioTracks() ?? []) stream.addTrack(track);
  const type = types.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  const recorder = new MediaRecorder(stream, { ...(type ? { mimeType: type } : {}), videoBitsPerSecond: 14_000_000, audioBitsPerSecond: 160_000 });
  const chunks: Blob[] = [];
  let failure = '';
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onerror = (event) => { failure ||= (event as Event & { error?: DOMException }).error?.message || 'the recorder stopped'; };

  let fps = 60, last = 0, began = 0, measured = 0, measuredSince = 0;
  const app = document.querySelector<HTMLElement>('.app');
  listener = (avatar) => {
    const now = performance.now();
    // Draw no faster than the target rate (a 120 Hz screen still gives 60).
    if (last && now - last < 1000 / fps - 3) return;
    last = now; began ||= now;
    // After a second to settle, count a second of frames: below about 50, settle on 30 for the rest of the video.
    if (fps === 60 && now - began > 1000) {
      if (!measuredSince) measuredSince = now;
      measured++;
      if (now - measuredSince >= 1000) { if (measured < 50) fps = 30; measured = 0; measuredSince = now; }
    }
    try { compose(avatar); } catch { /* A frame that cannot be drawn is skipped. */ }
  };

  function rect(element: Element) {
    const box = element.getBoundingClientRect();
    return { x: box.left * sx, y: box.top * sy, w: box.width * sx, h: box.height * sy, box };
  }
  function opacityOf(element: Element | null) {
    let alpha = 1;
    for (let node = element; node && node !== document.body; node = node.parentElement) alpha *= Number(getComputedStyle(node).opacity) || 0;
    return alpha;
  }
  function compose(avatar: HTMLCanvasElement) {
    const style = app ? getComputedStyle(app) : null;
    ctx.globalAlpha = 1; ctx.fillStyle = style?.backgroundColor || '#0d0e17'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    drawHalo();
    drawAvatar(avatar);
    drawCaptions();
    for (const root of document.querySelectorAll('.wordmark, .start-screen, .memory-moment')) paint(root, opacityOf(root.parentElement));
    const brain = document.querySelector('.brain-view');
    if (brain) drawBrain(brain);
  }
  // The halo: an ellipse of its glow colour fading out at 72% (farthest-corner sizing, centred at 50% 48%). It fades
  // to the same colour at zero alpha: fading to 'transparent' (black) would grey it.
  function drawHalo() {
    const halo = document.querySelector('.halo'), glow = halo && /rgba?\(([^)]+)\)/.exec(getComputedStyle(halo).backgroundImage)?.[1].split(',').map(Number);
    if (!halo || !glow || glow.length < 3) return;
    const { x, y, w, h } = rect(halo), cx = x + w / 2, cy = y + h * .48;
    const rx = Math.SQRT2 * w / 2, ry = Math.SQRT2 * Math.max(h * .48, h * .52);
    ctx.save(); ctx.globalAlpha = opacityOf(halo);
    ctx.translate(cx, cy); ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    const [r, g, b, a = 1] = glow;
    gradient.addColorStop(0, `rgba(${r},${g},${b},${a})`); gradient.addColorStop(.72, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = gradient; ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    ctx.restore();
  }
  // Kelly, clipped to her stage and faded at the bust like on the page.
  function drawAvatar(avatar: HTMLCanvasElement) {
    const host = avatar.parentElement, clip = document.querySelector('.avatar');
    if (!host || !clip) return;
    const { x, y, w, h } = rect(avatar), area = rect(clip), hostStyle = getComputedStyle(host);
    lay.globalCompositeOperation = 'source-over'; lay.clearRect(0, 0, layer.width, layer.height);
    lay.save(); lay.beginPath(); lay.rect(area.x, area.y, area.w, area.h); lay.clip();
    lay.drawImage(avatar, x, y, w, h); lay.restore();
    const clear = parseFloat(hostStyle.getPropertyValue('--bust-clear')) || 0, solid = parseFloat(hostStyle.getPropertyValue('--bust-solid')) || 230;
    const bottom = y + h, from = bottom - clear * sy, to = bottom - solid * sy;
    if (Math.abs(from - to) > 1) {
      const fade = lay.createLinearGradient(0, from, 0, to);
      for (const [alpha, at] of bustStops) fade.addColorStop(at, `rgba(0,0,0,${alpha})`);
      lay.globalCompositeOperation = 'destination-in'; lay.fillStyle = fade; lay.fillRect(0, 0, layer.width, layer.height);
      lay.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = opacityOf(host); ctx.drawImage(layer, 0, 0); ctx.globalAlpha = 1;
  }
  // Each piece of text is drawn centred in its own box, so the layout always matches the page.
  function text(element: Element, value: string, alpha: number) {
    if (!value.trim() || alpha <= .01) return;
    const css = getComputedStyle(element), { x, y, w, h } = rect(element);
    lay.font = `${css.fontWeight} ${parseFloat(css.fontSize) * sy}px ${css.fontFamily}`;
    lay.fillStyle = css.color; lay.globalAlpha = alpha;
    lay.textAlign = 'center'; lay.textBaseline = 'middle';
    lay.fillText(value, x + w / 2, y + h / 2);
  }
  // The caption line, letter by letter for the clone's decoding line and word by word for hints; faded at the sides.
  function drawCaptions() {
    const box = document.querySelector('.captions'), lines = box?.querySelectorAll('.caption');
    if (!box || !lines?.length) return;
    lay.clearRect(0, 0, layer.width, layer.height);
    for (const line of lines) {
      const lineAlpha = opacityOf(line);
      for (const char of line.querySelectorAll<HTMLElement>('.cipher-char')) {
        const state = char.dataset.state;
        if (state === 'done') { const real = char.firstElementChild!; text(real, real.textContent ?? '', lineAlpha * Number(getComputedStyle(real).opacity)); }
        else if (state === 'scramble') { const mask = char.lastElementChild as HTMLElement; text(mask, mask.textContent ?? '', lineAlpha * (Number(mask.style.opacity) || 1)); }
      }
      for (const word of line.querySelectorAll('.caption-word')) text(word, word.textContent ?? '', lineAlpha * Number(getComputedStyle(word).opacity));
      for (const dot of line.querySelectorAll('.caption-pulse')) {
        const { x, y, w, h } = rect(dot), css = getComputedStyle(dot);
        lay.globalAlpha = lineAlpha * Number(css.opacity); lay.fillStyle = css.backgroundColor;
        lay.beginPath(); lay.arc(x + w / 2, y + h / 2, w / 2, 0, Math.PI * 2); lay.fill();
      }
    }
    lay.globalAlpha = 1;
    // The line's sides fade out over 6% of its width, as on the page.
    const { x, w } = rect(box), fade = lay.createLinearGradient(x, 0, x + w, 0);
    fade.addColorStop(0, 'rgba(0,0,0,0)'); fade.addColorStop(.06, '#000'); fade.addColorStop(.94, '#000'); fade.addColorStop(1, 'rgba(0,0,0,0)');
    lay.globalCompositeOperation = 'destination-in'; lay.fillStyle = fade; lay.fillRect(0, 0, layer.width, layer.height);
    lay.globalCompositeOperation = 'source-over';
    ctx.drawImage(layer, 0, 0);
  }
  // --- Any other part of the page, drawn from its boxes: backgrounds, borders, text, icons, images. -----------------
  // Not a general renderer: it covers what these screens use (solid fills, rounded corners, words, stroked SVG icons).
  // Shadows, blurs behind glass and masks are left out.
  const skipped = '.header-actions, .record-toggle, .video-ready, .sr-only, .captions, .start-hit-area';
  const transparent = (color: string) => !color || color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color);
  type Spaced = CanvasRenderingContext2D & { letterSpacing?: string };
  function box(element: Element, css: CSSStyleDeclaration, alpha: number) {
    const fill = css.backgroundColor, line = (parseFloat(css.borderTopWidth) || 0) * sx, stroke = css.borderTopColor;
    if (transparent(fill) && (!line || transparent(stroke))) return;
    const { x, y, w, h } = rect(element), radius = Math.min((parseFloat(css.borderTopLeftRadius) || 0) * sx, h / 2, w / 2);
    ctx.globalAlpha = alpha;
    if (!transparent(fill)) { ctx.fillStyle = fill; ctx.beginPath(); ctx.roundRect(x, y, w, h, radius); ctx.fill(); }
    if (line && !transparent(stroke)) { ctx.lineWidth = line; ctx.strokeStyle = stroke; ctx.beginPath(); ctx.roundRect(x + line / 2, y + line / 2, w - line, h - line, Math.max(0, radius - line / 2)); ctx.stroke(); }
  }
  // Text word by word, each at the place the page laid it out (so wrapping and centring match).
  function words(node: Text, css: CSSStyleDeclaration, alpha: number) {
    const range = document.createRange(), upper = css.textTransform === 'uppercase', pen = ctx as Spaced;
    pen.font = `${css.fontStyle} ${css.fontWeight} ${parseFloat(css.fontSize) * sy}px ${css.fontFamily}`;
    if ('letterSpacing' in pen) pen.letterSpacing = css.letterSpacing === 'normal' ? '0px' : `${parseFloat(css.letterSpacing) * sx}px`;
    pen.fillStyle = css.color; pen.globalAlpha = alpha; pen.textAlign = 'left'; pen.textBaseline = 'middle';
    for (const match of node.data.matchAll(/\S+/g)) {
      range.setStart(node, match.index); range.setEnd(node, match.index + match[0].length);
      const area = range.getBoundingClientRect();
      if (area.width) pen.fillText(upper ? match[0].toUpperCase() : match[0], area.left * sx, (area.top + area.height / 2) * sy);
    }
    if ('letterSpacing' in pen) pen.letterSpacing = '0px';
  }
  function icon(svg: SVGSVGElement, css: CSSStyleDeclaration, alpha: number) {
    const { x, y, w, h } = rect(svg), view = svg.viewBox.baseVal;
    if (!view?.width) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.translate(x, y); ctx.scale(w / view.width, h / view.height); ctx.translate(-view.x, -view.y);
    ctx.strokeStyle = ctx.fillStyle = css.color; ctx.lineWidth = Number(svg.getAttribute('stroke-width')) || 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const shape of svg.querySelectorAll('path, circle, rect, line')) {
      const at = (name: string) => Number(shape.getAttribute(name)) || 0, path = new Path2D();
      if (shape.tagName === 'path') path.addPath(new Path2D(shape.getAttribute('d') ?? ''));
      else if (shape.tagName === 'circle') path.arc(at('cx'), at('cy'), at('r'), 0, Math.PI * 2);
      else if (shape.tagName === 'rect') path.roundRect(at('x'), at('y'), at('width'), at('height'), at('rx'));
      else { path.moveTo(at('x1'), at('y1')); path.lineTo(at('x2'), at('y2')); }
      if ((shape.getAttribute('fill') ?? svg.getAttribute('fill')) === 'currentColor') ctx.fill(path); else ctx.stroke(path);
    }
    ctx.restore();
  }
  function paint(element: Element, inherited: number) {
    if (element.matches(skipped)) return;
    const css = getComputedStyle(element);
    if (css.display === 'none') return;
    const alpha = inherited * (Number(css.opacity) || 0);
    if (alpha <= .01) return;
    const visible = css.visibility !== 'hidden';
    if (visible) {
      if (element instanceof HTMLImageElement) {
        if (element.complete && element.naturalWidth) { const { x, y, w, h } = rect(element); ctx.globalAlpha = alpha; ctx.drawImage(element, x, y, w, h); }
        return;
      }
      if (element instanceof SVGSVGElement) { icon(element, css, alpha); return; }
      box(element, css, alpha);
    }
    for (const child of element.childNodes) {
      if (child instanceof Text) { if (visible && child.data.trim()) words(child, css, alpha); }
      else if (child instanceof Element) paint(child, alpha);
    }
    ctx.globalAlpha = 1;
  }
  // A CSS radial gradient (an ellipse sized to the farthest corner) with its colour stops, as the page computed it.
  function radial(element: Element, alpha: number) {
    const image = getComputedStyle(element).backgroundImage, at = /at ([\d.]+)% ([\d.]+)%/.exec(image);
    const stops = [...image.matchAll(/(rgba?\([^)]+\))\s*([\d.]+)(%|px)?/g)].map((stop) => [stop[1], stop[3] === '%' ? Number(stop[2]) / 100 : 0] as const);
    if (!stops.length) return;
    const { x, y, w, h } = rect(element), px = Number(at?.[1] ?? 50) / 100 * w, py = Number(at?.[2] ?? 50) / 100 * h;
    const rx = Math.SQRT2 * Math.max(px, w - px), ry = Math.SQRT2 * Math.max(py, h - py);
    ctx.save(); ctx.globalAlpha = alpha; ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.translate(x + px, y + py); ctx.scale(1, ry / rx);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    for (const [color, offset] of stops) gradient.addColorStop(Math.min(1, offset), color);
    ctx.fillStyle = gradient; ctx.fillRect(-rx, -rx, rx * 2, rx * 2); ctx.restore();
  }
  // The memories view: what is behind it blurred, its veil, the hologram (screen-blended in the dark theme), then its
  // title, filters, hint and card on top.
  function drawBrain(brain: Element) {
    const alpha = Number(getComputedStyle(brain).opacity) || 0;
    if (alpha <= .01) return;
    if ('filter' in lay) {
      lay.save(); lay.globalCompositeOperation = 'copy'; lay.filter = `blur(${9 * sx}px)`; lay.drawImage(canvas, 0, 0); lay.restore();
      ctx.globalAlpha = alpha; ctx.drawImage(layer, 0, 0);
    }
    radial(brain, alpha);
    const scene = brain.querySelector('.brain-scene'), hologram = scene?.querySelector('canvas');
    if (scene && hologram) {
      const { x, y, w, h } = rect(hologram);
      ctx.save(); ctx.globalAlpha = alpha * (Number(getComputedStyle(scene).opacity) || 0);
      if (getComputedStyle(hologram).mixBlendMode === 'screen') ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(hologram, x, y, w, h); ctx.restore();
    }
    for (const child of brain.children) if (child !== scene) paint(child, alpha);
    ctx.globalAlpha = 1;
  }

  recorder.start(1000);
  return {
    get fps() { return fps; },
    // Whatever was recorded is kept, even if the recorder stopped early.
    stop: () => new Promise((resolve) => {
      listener = null;
      const finish = () => {
        for (const track of stream.getVideoTracks()) track.stop();
        resolve(chunks.length ? { blob: new Blob(chunks, { type: recorder.mimeType || type || 'video/mp4' }) } : { error: failure || 'nothing was recorded' });
      };
      if (recorder.state === 'inactive') return finish();
      recorder.onstop = finish;
      try { recorder.requestData(); recorder.stop(); } catch { finish(); }
    }),
  };
}
