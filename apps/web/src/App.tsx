import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent } from 'react';
import { useConversation } from './useConversation';
import type { BrainProbe } from './avatar/kelly';
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
  const { state, connection, mode, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, recall, playbackRef, startRecording, finishRecording, playAnswer } = useConversation();
  // Tapping the violet look's brain opens the memories inside it, growing out of the spot that was tapped.
  const brainProbe = useRef<BrainProbe | null>(null);
  const [brainOrigin, setBrainOrigin] = useState<{ x: number; y: number } | null>(null), [overBrain, setOverBrain] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [started, setStarted] = useState(false), [leaving, setLeaving] = useState(false), [wordIndex, setWordIndex] = useState(0);
  const [entryAwake, setEntryAwake] = useState(false);
  const [toast, setToast] = useState('');
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
  function begin() {
    if (leaving) return;
    setLeaving(true);
    setEntryAwake(true);
    setTimeout(() => setStarted(true), exitSeconds * 1000);
  }
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
  const activityLabel = !online ? status : needsPlayback ? 'Áudio pronto' : starting ? 'Preparando microfone' : waking ? 'Despertando'
    : ({ offline: '', listening: 'Ouvindo', speaking: 'Falando', thinking: 'Refletindo', resting: 'Em repouso' })[activity];
  // Kelly herself is the control: wake her, start and send a recording, or play a reply the browser held back.
  const avatarLabel = needsPlayback ? 'Tocar resposta' : state === 'idle' ? entryAwake ? 'Começar conversa' : 'Despertar' : starting ? 'Acessando microfone'
    : busy ? 'Aguarde a resposta' : mode === 'demo' ? 'Simular pergunta' : recording ? 'Enviar fala' : 'Começar a falar';
  const avatarReady = started && online && mode !== 'loading' && !waking && (needsPlayback || !busy);
  function avatarAction(event: MouseEvent) {
    const brainAt = started && !recording ? brainProbe.current?.(event.clientX, event.clientY) : null;
    if (brainAt) { setOverBrain(false); setBrainOrigin(brainAt); return; }
    if (!avatarReady) return;
    if (needsPlayback) void playAnswer();
    else if (state === 'idle') send('start');
    else if (mode === 'demo') send('submit-demo');
    else if (recording) finishRecording();
    else void startRecording();
  }
  return <div className="app" data-theme={theme} data-state={state} data-waking={waking} data-recording={recording} data-started={started}>
    <header className="header">
      {started ? null : <a className="wordmark" href="/" aria-label="Talk2urself — início">talk<span>2</span>urself<span className="brand-dot">.</span></a>}
      <nav className="header-actions" aria-label="Navegação principal">
        <button className="settings-toggle" aria-label="Abrir configurações" title="Configurações" aria-expanded={settingsOpen} aria-controls="experience-panel" onClick={() => setSettingsOpen((open) => !open)}><Icon name="gear" /></button>
        <button className="theme-toggle" aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
      </nav>
    </header>
    {settingsOpen ? <aside className="guide" id="experience-panel" aria-label="Configurações">
      <div className="panel-heading"><strong>Configurações</strong><button className="panel-close" aria-label="Fechar painel" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></div>
      <button className="memory-entry rest-entry" onClick={() => { setSettingsOpen(false); setBrainOrigin({ x: innerWidth / 2, y: innerHeight / 2 }); }}><strong>Memórias</strong><span>Ver o cérebro e tudo o que a Kelly lembra sobre você.</span></button>
      {online && (state !== 'idle' || entryAwake) ? <button className="memory-entry rest-entry" onClick={() => { setEntryAwake(false); send('reset'); setSettingsOpen(false); }}><strong>Pôr para dormir</strong><span>Encerrar a conversa e deixar a Kelly em repouso.</span></button> : null}
        <details><summary>Créditos dos modelos 3D</summary>
          <p>Modelo provisório <a href="https://sketchfab.com/3d-models/kelly-woman-head-with-blendshapes-938d50fda06c46109d6877c85c6ec3d2" target="_blank" rel="noreferrer">Kelly, de skullvez</a>, CC BY 4.0. Acabamento e ombros adaptados.</p>
          <p>Cérebro: <a href="https://sketchfab.com/3d-models/human-brain-cerebrum-brainstem-0aa0e33c5c854d1bab7bac9e1c7acaec" target="_blank" rel="noreferrer">Human brain, Cerebrum &amp; Brainstem, de pranktoy</a>, CC BY 4.0. Sem o tronco, malha simplificada e desenhada como holograma.</p>
        </details>
    </aside> : null}
    <main className="experience">
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
        </section>
        <div className="start-actions" ref={bottomContent}>
          <button className="wake-button" onClick={begin} disabled={leaving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1.4 1.4M16.6 16.6 18 18M6 18l1.4-1.4M16.6 7.4 18 6" /><circle cx="12" cy="12" r="3.2" /></svg>
            Acordar a Kelly
          </button>
          <p className="start-note">O microfone só grava quando você toca nela. As memórias ficam guardadas para as próximas conversas.</p>
        </div>
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
          <Suspense fallback={null}><Avatar3D state={avatarState} recording={recording} playbackRef={playbackRef} clearOf={topContent} theme={theme} brainProbe={brainProbe} clearBelow={bottomContent} holdLayout={leaving || started} /></Suspense>
        </button>
      </div>
      {started || leaving ? <div className="character-status" data-activity={activity} role="status" aria-atomic="true">
        <span className="character-status-motion" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        <span>{activityLabel}</span>
      </div> : null}
      {started && toast ? <p className="toast" role="alert">{toast}</p> : null}
      {brainOrigin ? <Suspense fallback={null}><BrainView origin={brainOrigin} recall={recall} onClose={() => setBrainOrigin(null)} /></Suspense> : null}
    </main>
  </div>;
}
