import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useConversation } from './useConversation';
import type { BrainProbe } from './avatar/kelly';
import Captions from './Captions';
import { voiceStatus } from './voice-sample';
const Avatar3D = lazy(() => import('./avatar/Avatar3D'));
const BrainView = lazy(() => import('./brain/BrainView'));
// Start screen: "a smarter version of you", with the adjective cycling. Feminine forms agree with "versão".
const adjectives = ['inteligente', 'sábia', 'criativa', 'corajosa', 'calma', 'curiosa', 'confiante', 'gentil', 'focada', 'ousada'];
const wordSeconds = 2.2, exitSeconds = .65, toastSeconds = 6;
// Small promises under the headline, and a plain note about the microphone before the browser asks for it.
const promises = ['Voz natural', 'Lembra de você', 'Reage como gente'];
type Theme = 'light' | 'dark';
function Icon({ name }: { name: 'mic' | 'sun' | 'moon' | 'pause' | 'close' | 'play' | 'gear' }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'mic' ? <><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6" /></> : null}
    {name === 'sun' ? <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5" /></> : null}
    {name === 'moon' ? <path d="M20 15.5A9 9 0 0 1 8.5 4a9 9 0 1 0 11.5 11.5Z" /> : null}
    {name === 'pause' ? <path d="M9 6v12M15 6v12" /> : null}
    {name === 'close' ? <path d="m6 6 12 12M18 6 6 18" /> : null}
    {name === 'play' ? <path d="m8 5 11 7-11 7Z" /> : null}
    {name === 'gear' ? <><path d="m9.5 3-.5 2-2 1.2-2-.5L3 9l1.5 1.5v3L3 15l2 3.3 2-.5L9 19l.5 2h5l.5-2 2-1.2 2 .5 2-3.3-1.5-1.5v-3L21 9l-2-3.3-2 .5L15 5l-.5-2Z" /><circle cx="12" cy="12" r="3" /></> : null}
  </svg>;
}
export default function App() {
  const { voiceClone, redoVoice, state, connection, mode, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, recall, playbackRef, unlockAudio, startRecording, finishRecording, playAnswer, micLevel, interrupt } = useConversation();
  // Tapping the violet look's brain opens the memories inside it, growing out of the spot that was tapped.
  const brainProbe = useRef<BrainProbe | null>(null), brainLocator = useRef<(() => { x: number; y: number } | null) | null>(null), subjectTop = useRef<(() => number | null) | null>(null);
  const experience = useRef<HTMLElement>(null);
  // Captions sit halfway between the floating header and the top of Kelly's portal (or her head).
  const header = useRef<HTMLElement>(null);
  const captionCentre = () => {
    const top = subjectTop.current?.(), area = experience.current?.getBoundingClientRect(), below = header.current?.getBoundingClientRect().bottom ?? 0;
    return top && area ? Math.max(below + 12, (below + top) / 2) - area.top : null;
  };
  // Live captions at the top, on by default; the choice is remembered on this browser.
  const [captions, setCaptions] = useState(() => { try { return localStorage.getItem('talk2urself-captions') !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('talk2urself-captions', captions ? '1' : '0'); } catch { /* Captions work without storage. */ } }, [captions]);
  // Memory moments: a small tag over Kelly's head when she draws on a memory to answer, or learns a new one.
  const [moment, setMoment] = useState<{ id: number; kind: 'recall' | 'new'; text: string; extra: number; x: number; y: number } | null>(null);
  function showMoment(kind: 'recall' | 'new', text: string, extra = 0) {
    const brain = brainLocator.current?.(), width = Math.min(320, innerWidth - 32);
    const x = Math.min(Math.max(brain?.x ?? innerWidth / 2, 16 + width / 2), innerWidth - 16 - width / 2);
    setMoment({ id: Date.now(), kind, text, extra, x, y: brain ? brain.y - 64 : innerHeight * .22 });
  }
  useEffect(() => {
    if (!moment) return;
    const timer = setTimeout(() => setMoment(null), moment.kind === 'new' ? 3200 : 4800);
    return () => clearTimeout(timer);
  }, [moment]);
  useEffect(() => {
    if (!started || !recall?.keys.size) return;
    const [first] = recall.keys, value = first.split('\u0000')[1] ?? '';
    showMoment('recall', value.length > 46 ? `${value.slice(0, 44).trimEnd()}…` : value, recall.keys.size - 1);
  }, [recall]);
  const [brainOrigin, setBrainOriginState] = useState<{ x: number; y: number } | null>(null), [overBrain, setOverBrain] = useState(false);
  // Until the brain has been opened once, the caption line suggests it (after the first exchange).
  const [brainOpened, setBrainOpened] = useState(() => { try { return localStorage.getItem('talk2urself-brain-opened') === '1'; } catch { return false; } });
  // Opening the memories: the brain first lifts out of Kelly's head in her own scene (brainOut), and the hologram
  // view mounts once it has risen, growing from wherever the brain is on the page by then.
  const [brainOut, setBrainOut] = useState(false);
  function setBrainOrigin(origin: { x: number; y: number } | null) {
    setBrainOriginState(origin);
    if (origin && !brainOpened) { setBrainOpened(true); try { localStorage.setItem('talk2urself-brain-opened', '1'); } catch { /* The hint may return next visit. */ } }
  }
  function openBrain(fallback: { x: number; y: number }) {
    if (brainOut) return;
    setBrainOut(true);
    // Mount as the brain nears the top, so the hologram grows while the brain is still dissolving.
    setTimeout(() => setBrainOrigin(brainLocator.current?.() ?? fallback), 600);
  }
  function closeBrain() { setBrainOrigin(null); setBrainOut(false); }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [started, setStarted] = useState(false), [leaving, setLeaving] = useState(false), [wordIndex, setWordIndex] = useState(0);
  // Fetch the memories view ahead of time, so the hologram is ready the moment the brain has risen.
  useEffect(() => { if (started) void import('./brain/BrainView').then(({ preloadBrain }) => preloadBrain()); }, [started]);
  const [entryAwake, setEntryAwake] = useState(false);
  const [toast, setToast] = useState('');
  // Wide screens get a two-column start: copy on the left, Kelly on the right; she glides to the centre on waking.
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1100px)').matches);
  useEffect(() => {
    const query = matchMedia('(min-width: 1100px)'), change = () => setWide(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  // Saved memories: a returning visitor is greeted with them. undefined until known (or given up on after 2.5 s).
  const [memories, setMemories] = useState<number | undefined>();
  useEffect(() => {
    let done = false;
    const settle = (count: number) => { if (!done) { done = true; setMemories(count); } };
    const timer = setTimeout(() => settle(0), 2500);
    fetch('/api/memory/count', { cache: 'no-store' }).then((response) => response.ok ? response.json() : null)
      .then((data: { enabled?: boolean; count?: number } | null) => settle(data?.enabled && Number.isInteger(data.count) ? data.count! : 0))
      .catch(() => settle(0));
    return () => { done = true; clearTimeout(timer); };
  }, []);
  // What sits at the top of the page; Kelly's head is framed below it.
  const topContent = useRef<HTMLElement>(null), bottomContent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (started) return;
    const timer = setInterval(() => setWordIndex((index) => (index + 1) % adjectives.length), wordSeconds * 1000);
    return () => clearInterval(timer);
  }, [started]);
  useEffect(() => {
    setToast(error);
    if (!error) return;
    const timer = setTimeout(() => setToast(''), toastSeconds * 1000);
    return () => clearTimeout(timer);
  }, [error]);
  // Waking is one step: the copy leaves while the conversation starts and Kelly greets the user. The tap also
  // unlocks audio, so her greeting may play when it arrives. Offline, she only wakes on screen and a later tap starts.
  const [greeting, setGreeting] = useState(false);
  function begin() {
    if (leaving) return;
    setLeaving(true);
    unlockAudio();
    if (connection === 'online' && mode !== 'loading' && state === 'idle') { setGreeting(true); send('start'); }
    else setEntryAwake(true);
    setTimeout(() => setStarted(true), exitSeconds * 1000);
  }
  useEffect(() => { if (greeting && (state === 'listening' || state === 'idle' && !waking) && !needsPlayback) setGreeting(false); }, [greeting, state, waking, needsPlayback]);
  useEffect(() => { if (error) setGreeting(false); }, [error]);
  // Until the first message is sent, hints in the caption line say how to talk to her; they never come back afterwards.
  const [hasSpoken, setHasSpoken] = useState(() => { try { return localStorage.getItem('talk2urself-spoke') === '1'; } catch { return false; } });
  useEffect(() => {
    if (!submitting || hasSpoken) return;
    setHasSpoken(true);
    try { localStorage.setItem('talk2urself-spoke', '1'); } catch { /* The hint may show again next visit. */ }
  }, [recording, hasSpoken]);
  const [theme, setTheme] = useState<Theme>(() => {
    try { return localStorage.getItem('talk2urself-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => { try { localStorage.setItem('talk2urself-theme', theme); } catch { /* Theme works without storage. */ } }, [theme]);
  useEffect(() => {
    if (!settingsOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSettingsOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [settingsOpen]);
  const busy = state === 'thinking' || state === 'speaking' || starting || submitting;
  const online = connection === 'online';
  const avatarState = state === 'idle' && entryAwake ? 'listening' : state;
  const status = !online ? connection === 'connecting' ? 'Conectando…' : 'Reconectando…' : state === 'idle' && entryAwake ? 'Pronto para conversar' : waking ? 'Despertando' : recording ? 'Ouvindo você'
    : ({ idle: 'Em repouso', listening: 'Pronto para ouvir', thinking: 'Refletindo', speaking: 'Respondendo' })[state];
  const activity = !online ? 'offline' : recording ? 'listening' : waking || submitting || state === 'thinking' ? 'thinking'
    : state === 'speaking' && !needsPlayback ? 'speaking' : 'resting';
  const activityLabel = !online ? status : needsPlayback ? 'Áudio pronto' : starting ? 'Preparando microfone'
    : waking || greeting && activity === 'thinking' ? 'Despertando…'
    : activity === 'resting' ? state === 'listening' ? 'Pronta para ouvir' : entryAwake ? 'Acordada' : 'Em repouso'
    : ({ offline: '', listening: 'Ouvindo', speaking: 'Falando', thinking: 'Refletindo' })[activity];
  const resting = started && online && state === 'listening' && !recording && !starting && !submitting && !needsPlayback;
  const showBrainHint = resting && hasSpoken && !brainOpened && !brainOut;
  const showTalkHint = started && online && mode === 'voice' && state === 'listening' && !recording && !starting && !submitting && !needsPlayback && !hasSpoken;
  // Kelly herself is the control: wake her, start and send a recording, or play a reply the browser held back.
  const avatarLabel = needsPlayback ? 'Tocar resposta' : state === 'idle' ? entryAwake ? 'Começar conversa' : 'Despertar' : starting ? 'Acessando microfone'
    : state === 'speaking' && mode === 'voice' ? 'Interromper e falar' : busy ? 'Aguarde a resposta' : mode === 'demo' ? 'Simular pergunta' : recording ? 'Enviar fala' : 'Começar a falar';
  const avatarReady = started && online && mode !== 'loading' && !waking && (needsPlayback || !busy || state === 'speaking' && mode === 'voice');
  function avatarAction(event: MouseEvent) {
    const brainAt = started && !recording ? brainProbe.current?.(event.clientX, event.clientY) : null;
    if (brainAt) { setOverBrain(false); openBrain(brainAt); return; }
    if (!avatarReady) return;
    if (needsPlayback) void playAnswer();
    else if (state === 'speaking') interrupt();
    else if (state === 'idle') { unlockAudio(); send('start'); }
    else if (mode === 'demo') send('submit-demo');
    else if (recording) finishRecording();
    else void startRecording();
  }
  return <div className="app" data-theme={theme} data-state={state} data-waking={waking} data-recording={recording} data-started={started} data-leaving={leaving}>
    <header className="header" ref={header}>
      <a className="wordmark" href="/" aria-label="Talk2urself — início" tabIndex={leaving ? -1 : undefined}>talk<span>2</span>urself<span className="brand-dot">.</span></a>
      <nav className="header-actions" aria-label="Navegação principal">
        <button className="settings-toggle" aria-label="Abrir configurações" title="Configurações" aria-expanded={settingsOpen} aria-controls="experience-panel" onClick={() => setSettingsOpen((open) => !open)}><Icon name="gear" /></button>
        <button className="theme-toggle" aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
      </nav>
    </header>
    {settingsOpen ? <aside className="guide" id="experience-panel" aria-label="Configurações">
      <div className="panel-heading"><strong>Configurações</strong><button className="panel-close" aria-label="Fechar painel" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></div>
      <button className="memory-entry rest-entry" onClick={() => { setSettingsOpen(false); openBrain({ x: innerWidth / 2, y: innerHeight / 2 }); }}><strong>Memórias</strong><span>Ver o cérebro e tudo o que a Kelly lembra sobre você.</span></button>
      {online && (state !== 'idle' || entryAwake) ? <button className="memory-entry rest-entry" onClick={() => { setEntryAwake(false); send('reset'); setSettingsOpen(false); }}><strong>Pôr para dormir</strong><span>Encerrar a conversa e deixar a Kelly em repouso.</span></button> : null}
      <button className="memory-entry rest-entry" role="switch" aria-checked={captions} onClick={() => setCaptions((on) => !on)}><strong>Legendas {captions ? 'ligadas' : 'desligadas'}</strong><span>Mostrar no topo, linha por linha, o que a Kelly e você dizem.</span></button>
      {voiceClone ? <button className="memory-entry rest-entry" onClick={() => {
        if (!confirm('Refazer sua voz? A voz atual e todas as amostras guardadas serão apagadas, e a Kelly volta a aprender sua voz do zero.')) return;
        const notify = (message: string) => { setToast(message); setTimeout(() => setToast((current) => current === message ? '' : current), toastSeconds * 1000); };
        void redoVoice().then(() => notify('Pronto: ela vai reaprender sua voz enquanto vocês conversam.'), (error: Error) => notify(error.message));
      }}><strong>Refazer minha voz</strong><span>{voiceStatus(voiceClone)}</span></button> : null}
        <details><summary>Créditos dos modelos 3D</summary>
          <p>Modelo provisório <a href="https://sketchfab.com/3d-models/kelly-woman-head-with-blendshapes-938d50fda06c46109d6877c85c6ec3d2" target="_blank" rel="noreferrer">Kelly, de skullvez</a>, CC BY 4.0. Acabamento e ombros adaptados.</p>
          <p>Cérebro: <a href="https://sketchfab.com/3d-models/human-brain-cerebrum-brainstem-0aa0e33c5c854d1bab7bac9e1c7acaec" target="_blank" rel="noreferrer">Human brain, Cerebrum &amp; Brainstem, de pranktoy</a>, CC BY 4.0. Sem o tronco, malha simplificada e desenhada como holograma.</p>
        </details>
    </aside> : null}
    <main className="experience" ref={experience}>
      {started ? null : <div className={`start-screen ${leaving ? 'leaving' : ''}`}>
        <button className="start-hit-area" aria-hidden="true" tabIndex={-1} onClick={begin} disabled={leaving} />
        <section ref={topContent} className="start-content" aria-label="Conheça o talk2urself" data-ready={memories !== undefined}>
          {memories ? <div className="start-copy">
            <span className="start-title">Que bom te ver de novo</span>
            <span className="start-lede">Ela lembra de <strong>{memories} {memories === 1 ? 'coisa' : 'coisas'}</strong> sobre você.</span>
          </div> : <div className="start-copy">
            <span className="start-title">Converse com uma versão mais <span className="start-personal"><span className="rotating-word" key={wordIndex}>{adjectives[wordIndex]}</span> de você</span></span>
            <span className="start-lede">Uma conversa por voz que aprende com você e lembra do que importa.</span>
            <ul className="start-promises" aria-label="O que ela faz">{promises.map((promise) => <li key={promise}>{promise}</li>)}</ul>
          </div>}
          <div className="start-actions" ref={bottomContent}>
            <button className="wake-button" onClick={begin} disabled={leaving}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" /><circle cx="12" cy="12" r="3.2" /></svg>
              Acordar a Kelly
            </button>
            <p className="start-note">O microfone só grava quando você toca nela. As memórias ficam guardadas para as próximas conversas.</p>
          </div>
        </section>
      </div>}
      {/* The screen shows only Kelly; status and both sides of the conversation stay available to screen readers. */}
      {!started && !leaving ? <span className="sr-only" role="status">{status}</span> : null}
      <section className="sr-only" aria-label="Sua fala">{transcript}</section>
      <section className="sr-only" aria-label="Resposta do personagem" aria-live="polite" aria-atomic="true">{text}</section>
      <div className="avatar-stage">
        <div className="halo" aria-hidden="true" />
        <button className="avatar" aria-label={avatarLabel} aria-disabled={!avatarReady} disabled={!started || !online} data-over-brain={overBrain} title={overBrain ? 'Ver memórias' : undefined} onClick={avatarAction}
          onPointerMove={(event) => { const over = started && !recording && event.pointerType === 'mouse' && !!brainProbe.current?.(event.clientX, event.clientY); if (over !== overBrain) setOverBrain(over); }}
          onPointerLeave={() => setOverBrain(false)}>
          <Suspense fallback={null}><Avatar3D state={avatarState} recording={recording} playbackRef={playbackRef} clearOf={topContent} theme={theme} micLevel={micLevel} brainOut={brainOut} invite={resting && !brainOut} brainProbe={brainProbe} clearBelow={bottomContent} holdLayout={leaving || started} restBelow={wide && !leaving && !started ? undefined : 28} aside={wide && !leaving && !started}
            brainLocator={brainLocator} subjectTop={subjectTop} onNewMemory={() => { if (started) showMoment('new', 'nova memória'); }} /></Suspense>
        </button>
      </div>
      {/* No status pill: Kelly's own motion and the captions show what is happening; screen readers still hear it. */}
      {started || leaving ? <span className="sr-only" role="status" aria-atomic="true">{activityLabel}</span> : null}
      {started && captions ? <Captions text={text} transcript={transcript} speaking={state === 'speaking' && !needsPlayback} thinking={state === 'thinking' || submitting} playbackRef={playbackRef} place={captionCentre} hint={recording ? hasSpoken ? 'Ouvindo…' : 'Ouvindo… é só fazer uma pausa para enviar' : showTalkHint ? 'Toque nela para falar' : showBrainHint ? 'Toque no cérebro para ver as memórias' : undefined} hintArrow={!recording && !showTalkHint && showBrainHint} /> : null}
      {moment ? <p className="memory-moment" data-kind={moment.kind} key={moment.id} aria-hidden="true" style={{ left: moment.x, top: moment.y }}>
        <i />{moment.kind === 'recall' ? <><strong>lembrou</strong>{moment.text}{moment.extra ? <span>+{moment.extra}</span> : null}</> : <strong>{moment.text}</strong>}
      </p> : null}
      {started && toast ? <p className="toast" role="alert">{toast}</p> : null}
      {brainOrigin ? <Suspense fallback={null}><BrainView origin={brainOrigin} recall={recall} onClose={closeBrain} onLeave={() => setBrainOut(false)} /></Suspense> : null}
    </main>
  </div>;
}
