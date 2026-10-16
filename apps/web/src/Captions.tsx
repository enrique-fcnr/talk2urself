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
// Live captions above Kelly: one line at a time, its words emerging from a blur and dissolving as the next line
// arrives. Kelly's words follow her audio; after the user speaks, what she understood shows in a quieter tone.
// Nothing stays on screen once a line has passed. place() gives the line's vertical centre, in pixels from the top
// of the conversation area.
// hint: a short guidance line ("Toque nela para falar") shown in the same place while nobody is talking.
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
      const audio = playbackRef.current?.audio, duration = audio?.duration;
      const progress = audio && Number.isFinite(duration) && duration! > 0 ? audio.currentTime / duration! : 0;
      const index = lineAt(lines, progress);
      show({ key: `k:${text.length}:${index}:${lines[index]}`, text: lines[index], who: 'kelly' });
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [speaking, text, playbackRef]);
  // The user's words, while she thinks: a line every 1.8 s, the last one held until she answers.
  useEffect(() => {
    if (!thinking || !transcript) return;
    const lines = captionLines(transcript, width());
    let index = 0;
    show({ key: `y:0:${lines[0]}`, text: lines[0], who: 'you' });
    const timer = setInterval(() => {
      if (index >= lines.length - 1) { clearInterval(timer); return; }
      index++; show({ key: `y:${index}:${lines[index]}`, text: lines[index], who: 'you' });
    }, 1800);
    return () => clearInterval(timer);
  }, [thinking, transcript]);
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
// Words emerge one after another out of a blur and dissolve the same way, each with its own small delay and drift.
function Line({ shown, out = false }: { shown: Shown; out?: boolean }) {
  const words = shown.text.split(' ');
  return <p className={`caption${out ? ' leaving' : ''}`} data-who={shown.who}>
    {shown.who === 'you' ? <span className="caption-who">você</span> : shown.who === 'hint' ? <span className="caption-pulse" /> : null}
    {words.map((word, i) => <span className="caption-word" key={i} style={{ '--i': i, '--n': words.length, '--drift': `${((i * 37) % 7 - 3) * .6}px` } as CSSProperties}>{word}</span>)}
    {shown.arrow ? <span className="caption-arrow" style={{ '--i': words.length } as CSSProperties} /> : null}
  </p>;
}
