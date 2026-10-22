import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import type { AvatarPlayback } from '../../../shared/lip-sync';

// Split a reply into short lines at word boundaries (never mid-word), each at most `width` characters.
export function captionLines(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.trim().split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + word).length > width) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines;
}
// Which line is being said, from how far the audio has played: lines take time in proportion to their length.
export function lineAt(lines: string[], progress: number): number {
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  let reached = 0;
  for (let i = 0; i < lines.length; i++) {
    reached += lines[i].length;
    if (progress * total < reached) return i;
  }
  return Math.max(0, lines.length - 1);
}

type Shown = { key: string; text: string; who: 'kelly' | 'you' | 'hint'; arrow?: boolean };
// Live captions above the clone: one line at a time, its words emerging from a blur and dissolving as the next line
// arrives, following its audio. The user's own words are not shown.
// Nothing stays on screen once a line has passed. place() gives the line's vertical centre, in pixels from the top
// of the conversation area.
// hint: a short guidance line ("Toque para falar") shown in the same place while nobody is talking.
// hintArrow: the hint points down at Kelly (a small bobbing chevron after it).
export default function Captions({ text, transcript, speaking, thinking, playbackRef, place, hint, hintArrow = false }: {
  text: string; transcript: string; speaking: boolean; thinking: boolean; playbackRef: RefObject<AvatarPlayback | null>; place: () => number | null; hint?: string; hintArrow?: boolean;
}) {
  const [shown, setShown] = useState<Shown | null>(null), [leaving, setLeaving] = useState<Shown | null>(null);
  const current = useRef<Shown | null>(null), box = useRef<HTMLDivElement>(null), placeRef = useRef(place);
  placeRef.current = place;
  const width = () => innerWidth < 700 ? 34 : 58;
  function show(next: Shown | null) {
    if (next?.key === current.current?.key) return;
    setLeaving(current.current); current.current = next; setShown(next);
  }
  // Kelly speaking: follow the audio.
  useEffect(() => {
    if (!speaking || !text) return;
    const lines = captionLines(text, width());
    let frame = 0;
    const tick = () => {
      const playback = playbackRef.current, audio = playback?.audio, duration = audio?.duration;
      const played = audio && Number.isFinite(duration) && duration! > 0 ? Math.min(1, audio.currentTime / duration!) : 0;
      // A reply in segments: this audio covers characters from..to of the whole text.
      const progress = playback?.from !== undefined && playback.to !== undefined && text.length
        ? Math.min(1, (playback.from + played * (playback.to - playback.from)) / text.length) : played;
      // Between segments there is no audio for a moment: keep the line being shown.
      if (!playback && current.current?.who === 'kelly') { frame = requestAnimationFrame(tick); return; }
      const index = lineAt(lines, progress);
      show({ key: `k:${text.length}:${index}:${lines[index]}`, text: lines[index], who: 'kelly' });
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [speaking, text, playbackRef]);
  // Between turns the line empties, or shows the hint when there is one.
  useEffect(() => { if (!speaking && !thinking) show(hint ? { key: `h:${hint}`, text: hint, who: 'hint', arrow: hintArrow } : null); }, [speaking, thinking, hint, hintArrow]);
  // Keep the line centred in its gap as the layout settles or the window changes.
  useEffect(() => {
    if (!shown && !leaving) return;
    let frame = 0;
    const follow = () => { const y = placeRef.current(); if (y !== null && box.current) box.current.style.top = `${Math.round(y)}px`; frame = requestAnimationFrame(follow); };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [shown, leaving]);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), 1100);
    return () => clearTimeout(timer);
  }, [leaving]);
  return <div className="captions" ref={box} aria-hidden="true">
    {leaving ? <Line shown={leaving} out key={`out:${leaving.key}`} /> : null}
    {shown ? <Line shown={shown} key={shown.key} /> : null}
  </div>;
}
// Characters a letter cycles through before it locks: same case and a similar width, so the line keeps its shape.
const cipherSets = { upper: 'ABCDEFGHJKLMNOPQRSTUVWXYZ', lower: 'abcdefghjkmnopqrstuvwxyz', digit: '0123456789' };
function cipherPool(char: string) {
  if (/\d/.test(char)) return cipherSets.digit;
  return char !== char.toLowerCase() ? cipherSets.upper : char !== char.toUpperCase() ? cipherSets.lower : '';
}
// When each letter of a line starts and stops scrambling, decoding left to right: the whole line takes about a second
// (less for short lines), each letter scrambling for a moment before it locks.
export function cipherSchedule(length: number, scramble = .32) {
  const duration = Math.min(1.1, .35 + length * .022), spread = Math.max(0, duration - scramble);
  return Array.from({ length }, (_, i) => { const start = length > 1 ? i / (length - 1) * spread : 0; return { start, end: start + scramble }; });
}
// Kelly's line decodes out of scrambled characters: each letter appears as cipher, flickers through look-alike
// characters in the accent colour and locks into place. The real letter is always laid out (only hidden), so the
// line never shifts. Leaving lines dissolve like the others.
function CipherLine({ shown }: { shown: Shown }) {
  const root = useRef<HTMLParagraphElement>(null);
  const words = shown.text.split(' ');
  useEffect(() => {
    const letters = [...(root.current?.querySelectorAll<HTMLElement>('.cipher-char') ?? [])];
    const masks = letters.map((letter) => letter.lastElementChild as HTMLElement);
    const schedule = cipherSchedule(letters.length), rate = 16;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { for (const letter of letters) letter.dataset.state = 'done'; return; }
    const begin = performance.now();
    let frame = 0, tick = -1;
    const draw = (now: number) => {
      const t = (now - begin) / 1000, step = Math.floor(t * rate), fresh = step !== tick;
      tick = step;
      let pending = false;
      letters.forEach((letter, i) => {
        const { start, end } = schedule[i], pool = cipherPool(letter.dataset.char ?? '');
        const state = t < start ? 'blank' : t >= end || !pool ? 'done' : 'scramble';
        if (letter.dataset.state !== state) letter.dataset.state = state;
        if (state !== 'done') pending = true;
        if (state === 'scramble') {
          if (fresh || !masks[i].textContent) masks[i].textContent = pool[Math.floor(Math.random() * pool.length)];
          // Scrambled characters brighten as their letter is about to lock.
          masks[i].style.opacity = String(.42 + .58 * ((t - start) / (end - start)) ** 2);
        }
      });
      if (pending) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [shown.text]);
  return <p className="caption cipher" data-who={shown.who} ref={root}>
    {words.map((word, w) => <span className="cipher-word" key={w}>
      {[...word].map((char, i) => <span className="cipher-char" data-char={char} data-state="blank" key={i}><span className="cipher-real">{char}</span><span className="cipher-mask" /></span>)}
    </span>)}
  </p>;
}
// Words emerge one after another out of a blur and dissolve the same way, each with its own small delay and drift.
function Line({ shown, out = false }: { shown: Shown; out?: boolean }) {
  if (!out && shown.who === 'kelly') return <CipherLine shown={shown} />;
  const words = shown.text.split(' ');
  return <p className={`caption${out ? ' leaving' : ''}`} data-who={shown.who}>
    {shown.who === 'you' ? <span className="caption-who">você</span> : shown.who === 'hint' ? <span className="caption-pulse" /> : null}
    {words.map((word, i) => <span className="caption-word" key={i} style={{ '--i': i, '--n': words.length, '--drift': `${((i * 37) % 7 - 3) * .6}px` } as CSSProperties}>{word}</span>)}
    {shown.arrow ? <span className="caption-arrow" style={{ '--i': words.length } as CSSProperties} /> : null}
  </p>;
}
