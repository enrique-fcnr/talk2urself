import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useConversation } from './useConversation';
import type { ConversationState } from '../../../shared/protocol';
import { maxRecordingSeconds } from '../../../shared/protocol';
const Avatar3D = lazy(() => import('./avatar/Avatar3D'));
const labels: Record<ConversationState, { title: string; hint: string }> = {
  idle: { title: 'Um espaço para pensar em voz alta.', hint: 'Toque no avatar para despertar.' },
  listening: { title: 'Uma história para reconstruir.', hint: 'Comece a falar e envie quando terminar.' },
  thinking: { title: 'Um instante para refletir.', hint: 'Preparando sua resposta…' },
  speaking: { title: 'Olhe para a ideia por outro ângulo.', hint: 'Ouça a resposta e depois continue.' },
};
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
  const { state, connection, mode, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, playbackRef, startRecording, finishRecording, playAnswer } = useConversation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const intro = useRef<HTMLElement>(null);
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
  const primaryLabel = state === 'idle' ? 'Despertar' : starting ? 'Acessando microfone…' : busy ? 'Aguarde a resposta'
    : mode === 'demo' ? 'Simular pergunta' : recording ? 'Enviar fala' : 'Começar a falar';
  const status = !online ? connection === 'connecting' ? 'Conectando…' : 'Reconectando…' : waking ? 'Despertando' : recording ? 'Ouvindo você'
    : ({ idle: 'Em repouso', listening: 'Pronto para ouvir', thinking: 'Refletindo', speaking: 'Respondendo' })[state];
  function primaryAction() {
    if (state === 'idle') send('start');
    else if (mode === 'demo') send('submit-demo');
    else if (recording) finishRecording();
    else void startRecording();
  }
  return <div className="app" data-theme={theme} data-state={state} data-waking={waking} data-recording={recording}>
    <header className="header">
      <a className="wordmark" href="/" aria-label="Talk2urself — início">talk<span>2</span>urself<span className="brand-dot">.</span></a>
      <nav className="header-actions" aria-label="Navegação principal">
        <button className="settings-toggle" aria-label="Abrir configurações" title="Configurações" aria-expanded={settingsOpen} aria-controls="experience-panel" onClick={() => setSettingsOpen((open) => !open)}><Icon name="gear" /></button>
        <button className="theme-toggle" aria-label={theme === 'light' ? 'Ativar tema escuro' : 'Ativar tema claro'} title={theme === 'light' ? 'Tema escuro' : 'Tema claro'} aria-pressed={theme === 'dark'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Icon name={theme === 'light' ? 'moon' : 'sun'} /></button>
      </nav>
    </header>
    {settingsOpen ? <aside className="guide" id="experience-panel" aria-label="Configurações">
      <div className="panel-heading"><strong>Configurações</strong><button className="panel-close" aria-label="Fechar painel" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></div>
      <a className="memory-entry" href="/memories" target="_blank" rel="noreferrer"><strong>Memórias <span aria-hidden="true">↗</span></strong><span>Acessar o cérebro e explorar os embeddings.</span></a>
        <details><summary>Créditos do avatar</summary>
          <p>Modelo provisório <a href="https://sketchfab.com/3d-models/kelly-woman-head-with-blendshapes-938d50fda06c46109d6877c85c6ec3d2" target="_blank" rel="noreferrer">Kelly, de skullvez</a>, CC BY 4.0. Acabamento e ombros adaptados.</p>
        </details>
    </aside> : null}
    <main className="experience">
      <section ref={intro} className="intro" aria-label="Estado da conversa">
        <span className="state-pill" role="status"><span className="state-dot" />{status}</span>
        <h1>{labels[state].title}</h1>
        <p className="subtitle">Sua história, por outro ângulo.</p>
        <p className="hint">{recording ? `Fale e clique em Enviar fala. Até ${maxRecordingSeconds} segundos por gravação.` : mode === 'demo' && state === 'listening' ? 'Experimente uma pergunta demonstrativa.' : mode === 'demo' && busy ? 'Resposta demonstrativa, sem consumo de créditos.' : labels[state].hint}</p>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </section>
      <div className="avatar-stage">
        <div className="halo" aria-hidden="true" />
        <button className="avatar" aria-label={state === 'idle' ? 'Despertar avatar' : 'Avatar desperto'} disabled={!online || mode === 'loading' || state !== 'idle' || waking} onClick={() => send('start')}>
          <Suspense fallback={null}><Avatar3D state={state} recording={recording} playbackRef={playbackRef} clearOf={intro} /></Suspense>
        </button>
      </div>
      <div className="conversation-cards">
        <section className={`conversation-card user-card ${transcript ? 'has-content' : ''}`} aria-label="Sua fala">
          <span className="card-label">Você</span><p>{transcript || (recording ? 'Estou ouvindo. Conte no seu ritmo.' : 'Sua história começa aqui.')}</p>
        </section>
        <section className={`conversation-card reply-card ${text ? 'has-content' : ''}`} aria-label="Resposta do personagem" aria-live="polite" aria-atomic="true">
          <span className="card-label">Resposta</span><p>{text || (state === 'thinking' ? 'Um instante para conectar as ideias…' : 'Um espaço para refletir com calma.')}</p>
        </section>
      </div>
      {needsPlayback ? <button className="playback-action" onClick={() => void playAnswer()}><Icon name="play" />Tocar resposta</button> : null}
      <div className="actions" aria-label="Controles de voz">
        <button className="primary-action" disabled={!online || busy || waking || mode === 'loading'} onClick={primaryAction}>
          <span className={`mic-disc ${busy ? 'busy' : ''}`}><Icon name={state === 'speaking' ? 'play' : 'mic'} /></span><span>{primaryLabel}</span>
        </button>
        <span className="control-divider" aria-hidden="true" />
        <button className="rest-action" aria-label="Voltar ao repouso" title="Voltar ao repouso" disabled={!online || state === 'idle'} onClick={() => send('reset')}><Icon name="pause" /></button>
      </div>
      <span className="footer-note">{mode === 'demo' ? 'PRÉVIA DEMONSTRATIVA' : 'UM ENCONTRO COM SUAS IDEIAS'}</span>
    </main>
  </div>;
}
