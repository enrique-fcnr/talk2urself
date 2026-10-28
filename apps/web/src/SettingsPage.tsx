import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { englishStatus, voiceStatus, type VoiceCloneStatus } from './voice-sample';

// The gear: the profile and the one choice about the clone, whose voice it uses. Nothing else is configurable.
type Props = { theme: 'light' | 'dark'; voiceClone: VoiceCloneStatus | null; chooseVoice(own: boolean): Promise<void>; redoVoice(): Promise<void>; onClose(): void };

const later = <span className="settings-soon">Soon</span>;

export default function SettingsPage({ theme, voiceClone, chooseVoice, redoVoice, onClose }: Props) {
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Shown inside the page: the app's own notices sit behind it.
  const [message, setMessage] = useState('');
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
      // Memories are sentences ("O nome do usuário é Enrique.", "The user's name is Anna."): take the capitalised name after
      // "é", "se chama", "is" or "called".
      const value = fact?.value.trim().replace(/[.!]+$/, '');
      const found = value && (/(?:se chama|chama-se|é|\bis|\bcalled)\s+([\p{Lu}][\p{L}'’-]*(?:\s+[\p{Lu}][\p{L}'’-]*)*)/u.exec(value)?.[1] ?? (value.split(/\s+/).length <= 3 ? value : null));
      setName(found ? found.slice(0, 40) : null);
    }).catch(() => {});
  }, []);

  const own = !!voiceClone?.ownVoice;
  async function pick(choice: boolean) {
    if (!voiceClone || choice === own || saving) return;
    setSaving(true);
    setMessage('');
    try { await chooseVoice(choice); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not change the voice.'); } finally { setSaving(false); }
  }
  async function redo() {
    if (!confirm('Redo your voice? The current voice and the saved samples will be deleted, and your clone will learn your voice again from scratch.')) return;
    try { await redoVoice(); setMessage('Done: your clone will learn your voice again as you talk.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not redo your voice.'); }
  }
  const initial = (name ?? 'You').trim().charAt(0).toUpperCase();

  // Portalled to the body so it covers the whole page, header and start screen included.
  return createPortal(<div className="settings-page" data-theme={theme} role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div className="settings-sheet">
      <header className="settings-header">
        <h2 id="settings-title">Settings</h2>
        <button ref={closeButton} className="panel-close" aria-label="Close settings" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button>
      </header>

      <section className="settings-card settings-profile" aria-label="Profile">
        <span className="settings-avatar" aria-hidden="true">{initial}</span>
        <div><strong>{name ?? 'You'}</strong></div>
      </section>

      <section className="settings-card" aria-labelledby="settings-voice">
        <h3 id="settings-voice">Voice</h3>
        <div className="settings-choice" role="radiogroup" aria-label="Your clone's voice">
          <button role="radio" aria-checked={!own} disabled={saving} onClick={() => void pick(false)}>Original voice</button>
          <button role="radio" aria-checked={own} disabled={!voiceClone || saving} onClick={() => void pick(true)}><span>My voice</span>{voiceClone ? null : later}</button>
        </div>
        <p>{!voiceClone ? 'Your clone will be able to speak with your voice, learned from what you say.'
          : own ? voiceStatus(voiceClone) : 'Choose "My voice" so your clone learns your voice as you talk.'}</p>
        {voiceClone && own && englishStatus(voiceClone) ? <p>{englishStatus(voiceClone)}</p> : null}
        {message ? <p className="settings-message" role="status">{message}</p> : null}
        {voiceClone && own && voiceClone.cloned ? <button className="settings-link" onClick={() => void redo()}>Redo my voice</button> : null}
      </section>

    </div>
  </div>, document.body);
}
