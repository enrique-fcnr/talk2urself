import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { voiceStatus, type VoiceCloneStatus } from './voice-sample';

// The gear: the profile and the one choice about the clone, whose voice it uses. Nothing else is configurable.
type Props = { theme: 'light' | 'dark'; voiceClone: VoiceCloneStatus | null; chooseVoice(own: boolean): Promise<void>; redoVoice(): Promise<void>; notify(message: string): void; onClose(): void };

const later = <span className="settings-soon">Em breve</span>;

export default function SettingsPage({ theme, voiceClone, chooseVoice, redoVoice, notify, onClose }: Props) {
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [onClose]);
  useEffect(() => {
    // The name Kelly learned is the profile name until accounts exist.
    void fetch('/api/memory').then((response) => response.json()).then((data: { profile?: { slot: string; value: string; status: string }[] }) => {
      const fact = data.profile?.find((item) => (item.slot === 'memory.nome' || item.slot === 'name') && item.status === 'known');
      // Memories are sentences ("O nome do usuário é Enrique, sem H."): take the capitalised name after "é" or "se chama".
      const value = fact?.value.trim().replace(/[.!]+$/, '');
      const found = value && (/(?:se chama|chama-se|é)\s+([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*)*)/u.exec(value)?.[1] ?? (value.split(/\s+/).length <= 3 ? value : null));
      setName(found ? found.slice(0, 40) : null);
    }).catch(() => {});
  }, []);

  const own = !!voiceClone?.ownVoice;
  async function pick(choice: boolean) {
    if (!voiceClone || choice === own || saving) return;
    setSaving(true);
    try { await chooseVoice(choice); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível trocar a voz.'); } finally { setSaving(false); }
  }
  async function redo() {
    if (!confirm('Refazer sua voz? A voz atual e as amostras guardadas serão apagadas, e seu clone volta a aprender sua voz do zero.')) return;
    try { await redoVoice(); notify('Pronto: seu clone vai reaprender sua voz enquanto vocês conversam.'); } catch (error) { notify(error instanceof Error ? error.message : 'Não foi possível refazer a voz.'); }
  }
  const initial = (name ?? 'Você').trim().charAt(0).toUpperCase();

  // Portalled to the body so it covers the whole page, header and start screen included.
  return createPortal(<div className="settings-page" data-theme={theme} role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div className="settings-sheet">
      <header className="settings-header">
        <h2 id="settings-title">Configurações</h2>
        <button ref={closeButton} className="panel-close" aria-label="Fechar configurações" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <section className="settings-card settings-profile" aria-label="Perfil">
        <span className="settings-avatar" aria-hidden="true">{initial}</span>
        <div><strong>{name ?? 'Você'}</strong></div>
      </section>

      <section className="settings-card" aria-labelledby="settings-voice">
        <h3 id="settings-voice">Voz</h3>
        <div className="settings-choice" role="radiogroup" aria-label="Voz do seu clone">
          <button role="radio" aria-checked={!own} disabled={saving} onClick={() => void pick(false)}>Voz original</button>
          <button role="radio" aria-checked={own} disabled={!voiceClone || saving} onClick={() => void pick(true)}><span>Minha voz</span>{voiceClone ? null : later}</button>
        </div>
        <p>{!voiceClone ? 'Seu clone vai poder falar com a sua voz, aprendida das suas falas.'
          : own ? voiceStatus(voiceClone) : 'Escolha "Minha voz" para seu clone aprender sua voz enquanto vocês conversam.'}</p>
        {voiceClone && own && voiceClone.cloned ? <button className="settings-link" onClick={() => void redo()}>Refazer minha voz</button> : null}
      </section>

    </div>
  </div>, document.body);
}
