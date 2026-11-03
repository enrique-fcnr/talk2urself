import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConversationState } from '../../../../shared/protocol';
import type { BrainLayout } from '../brain/layout';
import video from '../../landing/media/conversation.mp4';
import poster from '../../landing/media/conversation-poster.jpg';
import realVoice from '../../landing/media/voice-real-pt.m4a';
import clonedVoice from '../../landing/media/voice-clone-pt.m4a';
import demoJson from '../../landing/brain-demo.json';

// Positions and text only (see scripts/landing-brain.mts).
const demoBrain = demoJson as unknown as BrainLayout;
const BrainView = lazy(() => import('../brain/BrainView'));
const contact = 'https://www.linkedin.com/in/enrique-fernandes-b21754217/';
const words = ['wiser', 'sharper', 'calmer', 'bolder', 'truer', 'better'];
const glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Seconds without the cursor moving before Kelly falls asleep (she yawns on her own before that).
const sleepAfter = 30;

// Letters that settle one by one out of random glyphs, like the captions in the app.
function useCipher(text: string, run = true, speed = 28) {
  const [shown, setShown] = useState(run ? '' : text);
  useEffect(() => {
    if (!run) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setShown(text); return; }
    let frame = 0;
    const timer = setInterval(() => {
      frame++;
      const settled = Math.floor(frame / 2);
      setShown(Array.from(text, (char, i) => i < settled || char === ' ' ? char : i < settled + 6 ? glyphs[Math.floor(Math.random() * glyphs.length)] : '').join(''));
      if (settled >= text.length) clearInterval(timer);
    }, speed);
    return () => clearInterval(timer);
  }, [text, run, speed]);
  return shown;
}

// True once the element has come into view (it then stays true).
function useSeen<T extends Element>(margin = '-15% 0px') {
  const ref = useRef<T>(null), [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { setSeen(true); observer.disconnect(); } }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin]);
  return [ref, seen] as const;
}

function Reveal({ children, className = '', delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  return <div ref={ref} className={`reveal${seen ? ' in' : ''} ${className}`} style={{ transitionDelay: `${delay}ms` }}>{children}</div>;
}

// The hero: Kelly herself, awake from the start and following the cursor with her head and eyes. Left alone she
// yawns, and after a while falls asleep; moving again wakes her.
function Hero() {
  const host = useRef<HTMLDivElement>(null);
  const [awake, setAwake] = useState(true), [ready, setReady] = useState(false), [failed, setFailed] = useState(false);
  const [index, setIndex] = useState(0);
  const word = useCipher(words[index].toUpperCase(), true, 40);
  useEffect(() => { const timer = setInterval(() => setIndex((i) => (i + 1) % words.length), 3200); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let state: ConversationState = 'listening', gaze: { x: number; y: number } | null = null, idle: ReturnType<typeof setTimeout> | undefined, dispose: (() => void) | undefined, cancelled = false;
    const touch = matchMedia('(pointer: coarse)').matches;
    const rest = () => { clearTimeout(idle); idle = setTimeout(() => { state = 'idle'; gaze = null; setAwake(false); }, sleepAfter * 1000); };
    const look = (x: number, y: number) => {
      const box = element.getBoundingClientRect();
      // Her eyes sit about a third of the way down the frame.
      const cx = box.left + box.width / 2, cy = box.top + box.height * .38;
      gaze = { x: Math.max(-1, Math.min(1, (x - cx) / (innerWidth * .5))), y: Math.max(-1, Math.min(1, (cy - y) / (innerHeight * .5))) };
      if (state === 'idle') { state = 'listening'; setAwake(true); }
      rest();
    };
    const move = (event: PointerEvent) => { if (!touch || event.pointerType !== 'mouse') look(event.clientX, event.clientY); };
    const tap = (event: PointerEvent) => look(event.clientX, event.clientY);
    const away = () => { gaze = null; };
    rest();
    addEventListener('pointermove', move); addEventListener('pointerdown', tap); document.addEventListener('pointerleave', away);
    void import('../avatar/kelly').then(({ mountKelly }) => {
      if (cancelled) return;
      try {
        dispose = mountKelly(element, { getPlayback: () => null, getState: () => state, getGaze: () => gaze, memories: demoBrain.points.length, getTheme: () => 'dark',
          getHeadroom: () => element.clientHeight * (innerWidth < 760 ? .1 : .06), getFootroom: () => element.clientHeight * (innerWidth < 760 ? .36 : .3), portrait: true,
          onReady: () => setReady(true), onError: () => setFailed(true) });
      } catch { setFailed(true); }
    });
    return () => { cancelled = true; dispose?.(); clearTimeout(idle); removeEventListener('pointermove', move); removeEventListener('pointerdown', tap); document.removeEventListener('pointerleave', away); };
  }, []);
  return <header className="hero">
    <nav className="bar">
      <span className="wordmark">TALK<b>2</b>URSELF</span>
      <a className="tag" href={contact} target="_blank" rel="noreferrer"><i />Private demo<span className="wide"> — request access</span> <span aria-hidden="true">↗</span></a>
    </nav>
    <h1 className="headline" aria-label="Talk to a wiser version of you">
      <span className="line">Talk to a</span>
      <span className="line accent" aria-hidden="true">{word || ' '}</span>
      <span className="line">version of you</span>
    </h1>
    <div ref={host} className={`kelly${ready && !failed ? ' ready' : ''}`} aria-hidden="true" />
    <div className="hero-foot">
      <p className="lede">A character you talk to out loud. It remembers what you tell it, keeps it in a living memory, and slowly starts answering in your own voice.</p>
      <p className="hint" aria-live="polite">{awake ? 'Move your cursor. She’s watching.' : 'She fell asleep. Move to wake her.'}</p>
    </div>
  </header>;
}

function Chapter({ number, name, title, children }: { number: string; name: string; title: ReactNode; children?: ReactNode }) {
  return <Reveal className="chapter-head">
    <p className="chapter-label"><span>{number}</span>{name}</p>
    <h2 className="chapter-title">{title}</h2>
    {children ? <p className="chapter-lede">{children}</p> : null}
  </Reveal>;
}

function Listens() {
  const player = useRef<HTMLVideoElement>(null), [muted, setMuted] = useState(true);
  const [ref, seen] = useSeen<HTMLDivElement>('0px');
  useEffect(() => { if (seen) void player.current?.play().catch(() => {}); }, [seen]);
  return <section className="chapter" id="listens">
    <Chapter number="01" name="Listens" title={<>Talk. It <em>talks back.</em></>}>No buttons to hold. It hears when you start and when you’re done, answers in a streamed voice, and moves its mouth with every word.</Chapter>
    <div className="listens">
      <div ref={ref} className="screen">
        <video ref={player} src={video} poster={poster} muted={muted} loop playsInline preload="metadata" />
        <button className="sound" onClick={() => { const element = player.current!; element.muted = !muted; setMuted(!muted); void element.play().catch(() => {}); }}>
          {muted ? 'Turn sound on' : 'Mute'}</button>
      </div>
      <ul className="facts">
        <Reveal><li><span>Turn-taking</span>A voice model on your device hears when you stop, so you never press a thing.</li></Reveal>
        <Reveal delay={80}><li><span>Two languages</span>Portuguese or English, picked up from how you speak, turn by turn.</li></Reveal>
        <Reveal delay={160}><li><span>Lip-sync</span>Speech arrives in pieces with word timings; her mouth shapes follow them.</li></Reveal>
        <Reveal delay={240}><li><span>Real footage</span>This is a screen recording of a real conversation, not a mock-up.</li></Reveal>
      </ul>
    </div>
  </section>;
}

// One answer, traced: the question, the memories it pulled, and the reply built from them.
const question = 'Should I take the job offer in Berlin?';
const pulled = [['Money', 'I keep six months of expenses saved before any big change.', .61], ['Goals', 'I want to move into design leadership within two years.', .58], ['Reasoning', 'I decide by writing pros and cons, then sleeping on it.', .55]] as const;
const reply = 'Write the pros and cons tonight and sleep on it. If the role gets you closer to leading design, and your six months of savings stay intact, it’s worth a real look.';
function Trace() {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!seen) return;
    const timers = [setTimeout(() => setStep(1), 300), setTimeout(() => setStep(2), 1700), setTimeout(() => setStep(3), 3300)];
    return () => timers.forEach(clearTimeout);
  }, [seen]);
  const asked = useCipher(question, step >= 1, 22), answered = useCipher(reply, step >= 3, 14);
  const stages = ['Hear it', 'Embed it', 'Search 28 memories', 'Answer with them', 'Say it in your voice'];
  return <div ref={ref} className="trace">
    <ol className="stages" aria-label="What happens on each turn">{stages.map((name, i) =>
      <li key={name} className={step >= Math.min(3, Math.ceil((i + 1) * .7)) ? 'on' : ''}><span>{String(i + 1).padStart(2, '0')}</span>{name}</li>)}</ol>
    <div className="thread">
      <p className="who">You</p>
      <p className="said">{asked || ' '}</p>
      <div className={`pulled${step >= 2 ? ' in' : ''}`}>
        {pulled.map(([subject, text, score], i) => <div key={subject} className="memory" style={{ transitionDelay: `${i * 160}ms` }}>
          <span className="subject">{subject}</span><span className="text">{text}</span><span className="score">{score.toFixed(2)}</span></div>)}
      </div>
      <p className="who clone">Your clone</p>
      <p className="said answer">{answered || ' '}</p>
    </div>
  </div>;
}

function Remembers() {
  const [ref, seen] = useSeen<HTMLDivElement>('200px 0px');
  return <section className="chapter" id="remembers">
    <Chapter number="02" name="Remembers" title={<>Every answer comes from <em>what you told it.</em></>}>Each turn, what you say is turned into a vector and matched against everything it knows about you. Only the closest memories go into the answer. Afterwards, anything new you shared is pulled out, given a subject and saved.</Chapter>
    <Trace />
    <Reveal className="brain-intro"><h3>Spin the brain. <em>Open a memory.</em></h3><p>Every point of light is something it learned. Memories on the same subject share a region, and related ones are linked. These belong to Maya, a made-up person.</p></Reveal>
    <div ref={ref} className="brain-stage">
      {seen ? <Suspense fallback={null}><BrainView origin={{ x: 0, y: 0 }} recall={null} theme="dark" onClose={() => {}} demo={demoBrain} /></Suspense> : null}
    </div>
  </section>;
}

// A voice sample that draws its own waveform while it plays.
function Sample({ src, label }: { src: string; label: string }) {
  const audio = useRef<HTMLAudioElement>(null), canvas = useRef<HTMLCanvasElement>(null), [playing, setPlaying] = useState(false);
  const graph = useRef<{ analyser: AnalyserNode; data: Uint8Array<ArrayBuffer> } | null>(null);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const draw = () => {
      const element = canvas.current, context = element?.getContext('2d'), node = graph.current;
      if (element && context && node) {
        node.analyser.getByteTimeDomainData(node.data);
        const { width, height } = element; context.clearRect(0, 0, width, height);
        context.strokeStyle = '#b58cff'; context.lineWidth = 2; context.beginPath();
        node.data.forEach((value, i) => { const x = i / (node.data.length - 1) * width, y = (value / 255) * height; if (i) context.lineTo(x, y); else context.moveTo(x, y); });
        context.stroke();
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [playing]);
  function toggle() {
    const element = audio.current!;
    if (!graph.current) {
      const context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 1024;
      context.createMediaElementSource(element).connect(analyser); analyser.connect(context.destination);
      graph.current = { analyser, data: new Uint8Array(analyser.fftSize) };
    }
    if (element.paused) { void element.play(); setPlaying(true); } else { element.pause(); setPlaying(false); }
  }
  return <div className="sample">
    <button className={`play${playing ? ' on' : ''}`} onClick={toggle} aria-label={`${playing ? 'Pause' : 'Play'} ${label}`}>{playing ? '❚❚' : '▶'}</button>
    <canvas ref={canvas} width={480} height={64} />
    <audio ref={audio} src={src} preload="none" onEnded={() => setPlaying(false)} />
  </div>;
}

// The real voice, then the clone growing while you talk, ending with the clone saying the same line. In Portuguese: a
// clone is made in one language and sounds most like the speaker in it, and Portuguese is Enrique's.
function Becomes() {
  const stages = [
    { at: '0 min', name: 'A borrowed voice', note: 'It starts with a stock voice, while it listens to yours.' },
    { at: '2.5 min', name: 'First clone', note: 'Clean takes of your speech become a first clone of your voice.' },
    { at: '10 min', name: 'Second clone', note: 'Rebuilt from your best takes so far.' },
    { at: '20 min', name: 'Final clone', note: 'Frozen. From here on, it speaks as you. Hear it say the same line.', src: clonedVoice, label: 'the clone' },
  ];
  return <section className="chapter" id="becomes">
    <Chapter number="03" name="Becomes you" title={<>Its voice slowly <em>turns into yours.</em></>}>While you talk, clean takes of your speech are kept, and at each milestone a better clone of your voice replaces the last. Listen to the real voice first, then to the clone saying the same line.</Chapter>
    <Reveal className="original">
      <div><span className="at">The real voice</span><h3>Enrique, recorded</h3>
        <p lang="pt-BR">“Toda vez que a gente conversa, eu aprendo um pouco mais sobre quem você é. E, pouco a pouco, eu começo a soar como você.”</p>
        <p className="translation">“Every time we talk, I learn a little more about who you are. And, little by little, I start to sound like you.”</p></div>
      <Sample src={realVoice} label="the real voice" />
    </Reveal>
    <div className="timeline">
      {stages.map((stage, i) => <Reveal key={stage.name} delay={i * 90} className="stop">
        <span className="at">{stage.at}</span>
        <h3>{stage.name}</h3>
        <p>{stage.note}</p>
        {stage.src ? <Sample src={stage.src} label={stage.label!} /> : null}
      </Reveal>)}
    </div>
    <p className="aside">Recorded in Portuguese, his native language: each clone is built in one language and sounds most like you in it. Minutes of Portuguese speech in conversation; English has its own, shorter track (about 1, 5 and 10 minutes).</p>
  </section>;
}

export default function Landing() {
  return <main>
    <Hero />
    <Listens />
    <Remembers />
    <Becomes />
    <footer className="end">
      <Reveal><p className="chapter-label"><span>—</span>Private demo</p>
        <h2 className="end-title">By invitation, <em>for now.</em></h2>
        <p className="chapter-lede">Talk2urself is a personal project by Enrique Fernandes. If you’re a recruiter, or you’d like to talk to it yourself, send a message.</p>
        <a className="cta" href={contact} target="_blank" rel="noreferrer">Request access on LinkedIn <span aria-hidden="true">↗</span></a></Reveal>
      <p className="stack">Fastify · React · three.js · Supabase pgvector · OpenAI · Cartesia</p>
    </footer>
  </main>;
}
