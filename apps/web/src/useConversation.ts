import { useEffect, useRef, useState } from 'react';
import { recallKey, type Recall } from './brain/layout';
import { maxRecordingBytes, parseServerEvent, type ClientCommand, type ConversationState, type Usage } from '../../../shared/protocol';
import { quietPeak, recordMicrophone, type Recording } from './recorder';
import type { AvatarPlayback, PhonemeCue } from '../../../shared/lip-sync';
import type { GestureCue } from '../../../shared/gestures';

export function useConversation() {
  const [state, setState] = useState<ConversationState>('idle');
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [mode, setMode] = useState<'loading' | 'demo' | 'voice'>('loading');
  const [model, setModel] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [recording, setRecording] = useState(false);
  const [starting, setStarting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [needsPlayback, setNeedsPlayback] = useState(false);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [waking, setWaking] = useState(false);
  // Memories the server used for the latest answer, keyed by subject slot and text.
  const [recall, setRecall] = useState<Recall | null>(null);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<Recording | null>(null);
  const playerRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const playbackRef = useRef<AvatarPlayback | null>(null);
  // One audio element for every reply, unlocked by the user's first tap so a reply arriving seconds later may play.
  const speaker = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const startingRef = useRef(false);

  function clearPlayer() {
    playbackRef.current = null;
    const player = playerRef.current;
    if (player) {
      player.audio.onended = null; player.audio.onerror = null; player.audio.pause();
      player.audio.removeAttribute('src'); player.audio.load(); URL.revokeObjectURL(player.url); playerRef.current = null;
    }
  }
  function stopMedia() {
    generation.current++; recorderRef.current?.cancel(); recorderRef.current = null;
    clearTimeout(wakeTimer.current); wakeTimer.current = undefined;
    startingRef.current = false; clearPlayer();
  }
  function resetMediaUi() { setRecording(false); setStarting(false); setSubmitting(false); setNeedsPlayback(false); setWaking(false); }
  function send(command: ClientCommand) {
    if (command !== 'playback-ended') setError('');
    if (command === 'reset') { stopMedia(); resetMediaUi(); setTranscript(''); setText(''); setError(''); }
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      if (command === 'start') {
        clearTimeout(wakeTimer.current); setWaking(true);
        wakeTimer.current = setTimeout(() => { setWaking(false); wakeTimer.current = undefined; }, 1000);
      }
      socketRef.current.send(JSON.stringify({ type: 'command', command }));
    }
  }
  // Call inside a tap: plays a moment of silence on the shared element, which browsers then allow to play later.
  function unlockAudio() {
    if (speaker.current) return;
    const audio = new Audio(); speaker.current = audio;
    audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
    void audio.play().catch(() => { /* A later reply falls back to the play button. */ });
  }
  async function playAnswer() {
    const player = playerRef.current;
    if (!player) return;
    try { await player.audio.play(); if (playerRef.current === player) setNeedsPlayback(false); }
    catch { if (playerRef.current === player) setNeedsPlayback(true); }
  }

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    function connect() {
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
      socket.binaryType = 'arraybuffer'; socketRef.current = socket;
      let expectingAudio = false;
      let phonemes: PhonemeCue[] = [];
      let gestures: GestureCue[] = [];
      socket.onopen = () => {
        if (disposed) return;
        retryDelay = 1000; setConnection('online'); setError(''); setMode('loading'); setUsage(null);
        void fetch('/api/health').then(async (response) => {
          if (!response.ok) throw new Error();
          const health = await response.json();
          if (disposed || socketRef.current !== socket) return;
          if (health.ok !== true || (health.mode !== 'voice' && health.mode !== 'demo')) throw new Error();
          setMode(health.mode); setModel(typeof health.model === 'string' ? health.model : null);
        }).catch(() => { if (!disposed && socketRef.current === socket) { setMode('loading'); setError('Não foi possível consultar a configuração. Recarregue a página.'); } });
      };
      socket.onmessage = (message) => {
        if (disposed || socketRef.current !== socket) return;
        if (message.data instanceof ArrayBuffer) {
          if (!expectingAudio) return;
          expectingAudio = false; clearPlayer();
          const url = URL.createObjectURL(new Blob([message.data], { type: 'audio/wav' }));
          const audio = speaker.current ?? new Audio(); audio.src = url; const player = { audio, url }; playerRef.current = player;
          playbackRef.current = { audio, cues: phonemes, gestures }; phonemes = []; gestures = [];
          audio.onended = () => { if (playerRef.current === player) { clearPlayer(); setNeedsPlayback(false); send('playback-ended'); } };
          audio.onerror = () => { if (playerRef.current === player) { clearPlayer(); setNeedsPlayback(false); setError('Não foi possível reproduzir a resposta.'); send('playback-ended'); } };
          void playAnswer(); return;
        }
        if (typeof message.data !== 'string') return;
        const event = parseServerEvent(message.data);
        if (!event) { setError('Recebemos uma mensagem inválida.'); return; }
        if (event.type === 'error') { setError(event.message); setSubmitting(false); return; }
        if (event.type === 'usage') { setUsage(event.usage); return; }
        if (event.type === 'recall') { setRecall({ keys: new Set(event.memories.map(({ slot, value }) => recallKey(slot, value))), at: Date.now() }); return; }
        if (event.type === 'transcript') { setTranscript(event.text); return; }
        if (event.type === 'audio-output') { expectingAudio = true; phonemes = event.phonemes ?? []; gestures = event.gestures ?? []; return; }
        setState(event.state); setText(event.text); setSubmitting(false);
        if (event.state === 'idle') { expectingAudio = false; stopMedia(); resetMediaUi(); setTranscript(''); }
        if (event.state === 'listening') { expectingAudio = false; clearPlayer(); setNeedsPlayback(false); }
      };
      socket.onerror = () => { if (!disposed) setError('A conexão está indisponível. Tentaremos novamente.'); };
      socket.onclose = () => {
        if (disposed || socketRef.current !== socket) return;
        socketRef.current = null; stopMedia(); resetMediaUi();
        setConnection('offline'); setState('idle'); setText(''); setTranscript(''); setMode('loading');
        reconnect = setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 5000);
      };
    }
    connect();
    return () => { disposed = true; clearTimeout(reconnect); stopMedia(); socketRef.current?.close(); socketRef.current = null; };
  }, []);

  async function startRecording() {
    if (mode !== 'voice' || state !== 'listening' || connection !== 'online' || startingRef.current || recorderRef.current || submitting) return;
    startingRef.current = true; setStarting(true); setError(''); setTranscript(''); setText('');
    const current = generation.current;
    try {
      const recorder = await recordMicrophone(async (blob, seconds, peak) => {
        recorderRef.current = null;
        if (current !== generation.current) return;
        setRecording(false); setSubmitting(true);
        if (blob.size === 0 || blob.size > maxRecordingBytes || seconds < 0.25) { setSubmitting(false); setError('Grave uma pergunta curta antes de enviar.'); return; }
        // Skip the paid transcription when the microphone delivered near silence.
        if (peak !== undefined && peak < quietPeak) { setSubmitting(false); setError('Seu microfone parece mudo ou com volume muito baixo. Aumente o volume de entrada nas configurações de som e tente novamente.'); return; }
        try {
          const bytes = await blob.arrayBuffer();
          if (current !== generation.current) return;
          const socket = socketRef.current;
          if (socket?.readyState !== WebSocket.OPEN) throw new Error();
          socket.send(JSON.stringify({ type: 'audio-input', mime: blob.type, seconds })); socket.send(bytes);
        } catch { if (current === generation.current) { setSubmitting(false); setError('Não foi possível enviar a gravação. Confira a conexão e tente novamente.'); } }
      }, (message) => { if (current === generation.current) { recorderRef.current = null; setRecording(false); setSubmitting(false); setError(message); } });
      if (current !== generation.current) { recorder.cancel(); return; }
      recorderRef.current = recorder; setRecording(true);
    } catch (error) {
      if (current !== generation.current) return;
      setError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Autorize o microfone no navegador para conversar.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'Não encontramos um microfone conectado.'
        : error instanceof Error ? error.message : 'Não foi possível acessar o microfone.');
    } finally { if (current === generation.current) { startingRef.current = false; setStarting(false); } }
  }
  function finishRecording() { recorderRef.current?.finish(); }
  return { state, connection, mode, model, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, usage, recall, playbackRef, unlockAudio, startRecording, finishRecording, playAnswer };
}
