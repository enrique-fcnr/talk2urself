import { useEffect, useRef, useState } from 'react';
import { recallKey, type Recall } from './brain/layout';
import { maxRecordingBytes, parseServerEvent, type ClientCommand, type ConversationState, type Usage } from '../../../shared/protocol';
import { quietPeak, recordMicrophone, watchForBargeIn, type Recording } from './recorder';
import type { AvatarPlayback, PhonemeCue } from '../../../shared/lip-sync';
import type { GestureCue } from '../../../shared/gestures';
import { parseCloneStatus, sendVoiceSample, type VoiceCloneStatus } from './voice-sample';

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
  // Voice cloning status (server flag VOICE_CLONING=1); null when it is off.
  const [voiceClone, setVoiceClone] = useState<VoiceCloneStatus | null>(null);
  const cloneRef = useRef<VoiceCloneStatus | null>(null);
  // The take sent for the current turn, offered as a voice sample once the server heard speech in it.
  const lastTake = useRef<Blob | null>(null);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<Recording | null>(null);
  const playerRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const playbackRef = useRef<AvatarPlayback | null>(null);
  // One audio element for every reply, unlocked by the user's first tap so a reply arriving seconds later may play.
  const speaker = useRef<HTMLAudioElement | null>(null);
  const generation = useRef(0);
  const startingRef = useRef(false);
  // The reply arrives in segments (sentences) that play one after another. index: the segment playing now.
  type Segment = { url: string; cues: PhonemeCue[]; gestures: GestureCue[]; from: number; to: number; last: boolean; segment: number };
  const queue = useRef<{ segments: Segment[]; index: number; total: number }>({ segments: [], index: -1, total: 0 });
  // Conversation mode: once the user wakes the clone or talks, the microphone reopens after every reply, and the
  // user can cut in by speaking. It ends when nobody speaks for a while, or when the clone goes to sleep.
  const live = useRef(false);
  const stateRef = useRef<ConversationState>('idle');

  function clearQueue() {
    for (const segment of queue.current.segments.slice(queue.current.index + 1)) URL.revokeObjectURL(segment.url);
    queue.current = { segments: [], index: -1, total: 0 };
  }
  function sendJson(message: object) { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)); }
  // Plays segment `index` if it has arrived; the next one follows when it ends, and the last one ends the reply.
  function playSegment(index: number) {
    const segment = queue.current.segments[index];
    // Not here yet: wait for it (it plays as soon as it arrives).
    if (!segment) { clearPlayer(); queue.current.index = index; return; }
    clearPlayer(); queue.current.index = index;
    const audio = speaker.current ?? new Audio(); audio.src = segment.url; const player = { audio, url: segment.url }; playerRef.current = player;
    playbackRef.current = { audio, cues: segment.cues, gestures: segment.gestures, from: segment.from, to: segment.to, total: queue.current.total };
    // The server voices the next sentence only once this one starts playing.
    audio.onplaying = () => { if (playerRef.current === player) sendJson({ type: 'playing', segment: segment.segment }); audio.onplaying = null; };
    const next = () => {
      if (playerRef.current !== player) return;
      if (segment.last) { clearPlayer(); clearQueue(); setNeedsPlayback(false); send('playback-ended'); }
      else playSegment(index + 1);
    };
    audio.onended = next;
    audio.onerror = () => { if (playerRef.current === player) setError('Não foi possível reproduzir a resposta.'); next(); };
    void playAnswer();
  }
  // How much of the reply the user has heard, in characters, for an interruption.
  function heard() {
    const playback = playbackRef.current;
    if (playback?.from === undefined || playback.to === undefined) return queue.current.segments[queue.current.index]?.from ?? 0;
    const duration = playback.audio.duration, progress = Number.isFinite(duration) && duration > 0 ? Math.min(1, playback.audio.currentTime / duration) : 0;
    return Math.round(playback.from + progress * (playback.to - playback.from));
  }
  function clearPlayer() {
    playbackRef.current = null;
    const player = playerRef.current;
    if (player) {
      player.audio.onended = null; player.audio.onerror = null; player.audio.onplaying = null; player.audio.pause();
      player.audio.removeAttribute('src'); player.audio.load(); URL.revokeObjectURL(player.url); playerRef.current = null;
    }
  }
  function stopMedia() {
    generation.current++; recorderRef.current?.cancel(); recorderRef.current = null; clearQueue();
    clearTimeout(wakeTimer.current); wakeTimer.current = undefined;
    startingRef.current = false; clearPlayer();
  }
  function resetMediaUi() { setRecording(false); setStarting(false); setSubmitting(false); setNeedsPlayback(false); setWaking(false); }
  function send(command: ClientCommand) {
    if (command !== 'playback-ended') setError('');
    if (command === 'reset') { live.current = false; stopMedia(); resetMediaUi(); setTranscript(''); setText(''); setError(''); }
    if (command === 'start') live.current = true;
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
      let meta = { segment: 0, last: true, from: 0, to: 0 };
      socket.onopen = () => {
        if (disposed) return;
        retryDelay = 1000; setConnection('online'); setError(''); setMode('loading'); setUsage(null);
        void fetch('/api/health').then(async (response) => {
          if (!response.ok) throw new Error();
          const health = await response.json();
          if (disposed || socketRef.current !== socket) return;
          if (health.ok !== true || (health.mode !== 'voice' && health.mode !== 'demo')) throw new Error();
          setMode(health.mode); setModel(typeof health.model === 'string' ? health.model : null);
          cloneRef.current = parseCloneStatus(health.voiceClone); setVoiceClone(cloneRef.current);
        }).catch(() => { if (!disposed && socketRef.current === socket) { setMode('loading'); setError('Não foi possível consultar a configuração. Recarregue a página.'); } });
      };
      socket.onmessage = (message) => {
        if (disposed || socketRef.current !== socket) return;
        if (message.data instanceof ArrayBuffer) {
          if (!expectingAudio) return;
          expectingAudio = false;
          const url = URL.createObjectURL(new Blob([message.data], { type: 'audio/wav' }));
          if (meta.segment === 0) clearQueue();
          queue.current.segments[meta.segment] = { url, cues: phonemes, gestures, ...meta };
          phonemes = []; gestures = [];
          // Play it now if it is the first one, or if the previous one already finished and was waiting for it.
          if (meta.segment === 0 || (queue.current.index === meta.segment && !playerRef.current)) playSegment(meta.segment);
          return;
        }
        if (typeof message.data !== 'string') return;
        const event = parseServerEvent(message.data);
        if (!event) { setError('Recebemos uma mensagem inválida.'); return; }
        if (event.type === 'error') { setError(event.message); setSubmitting(false); return; }
        if (event.type === 'usage') { setUsage(event.usage); return; }
        if (event.type === 'recall') { setRecall({ keys: new Set(event.memories.map(({ slot, value }) => recallKey(slot, value))), at: Date.now() }); return; }
        if (event.type === 'transcript') {
          setTranscript(event.text);
          const take = lastTake.current; lastTake.current = null;
          // Only takes with recognized speech count toward the user's voice; failures never disturb the conversation.
          if (take && cloneRef.current?.collecting) void sendVoiceSample(take).then((status) => { if (status) { cloneRef.current = status; setVoiceClone(status); } }).catch(() => {});
          return;
        }
        if (event.type === 'audio-output') {
          expectingAudio = true; phonemes = event.phonemes ?? []; gestures = event.gestures ?? [];
          meta = { segment: event.segment ?? 0, last: event.segment === undefined || !!event.last, from: event.from ?? 0, to: event.to ?? 0 };
          return;
        }
        stateRef.current = event.state;
        if (event.state === 'speaking') queue.current.total = event.text.length;
        setState(event.state); setText(event.text); setSubmitting(false);
        if (event.state === 'idle') { expectingAudio = false; stopMedia(); resetMediaUi(); setTranscript(''); }
        if (event.state === 'listening') { expectingAudio = false; clearPlayer(); clearQueue(); setNeedsPlayback(false); }
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

  // takeover: the user cut in while the clone spoke; the microphone is already open and they are already talking.
  async function startRecording(takeover?: { stream: MediaStream; floor: number }) {
    if (!takeover && (mode !== 'voice' || state !== 'listening' || connection !== 'online' || startingRef.current || recorderRef.current || submitting)) return;
    if (takeover && recorderRef.current) { takeover.stream.getTracks().forEach((track) => track.stop()); return; }
    live.current = true;
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
          lastTake.current = cloneRef.current?.collecting ? blob : null;
        } catch { if (current === generation.current) { setSubmitting(false); setError('Não foi possível enviar a gravação. Confira a conexão e tente novamente.'); } }
      }, (message) => { if (current === generation.current) { recorderRef.current = null; setRecording(false); setSubmitting(false); setError(message); } },
      // Hands-free: the turn ends by itself after a pause; if nothing was said, nothing is sent.
      { handsFree: true, ...(takeover ? { stream: takeover.stream, floor: takeover.floor } : {}),
        onSilent: () => { if (current === generation.current) { recorderRef.current = null; setRecording(false); live.current = false; setError('Não ouvi nada. Toque quando quiser falar.'); } } });
      if (current !== generation.current) { recorder.cancel(); return; }
      recorderRef.current = recorder; setRecording(true);
    } catch (error) {
      if (current !== generation.current) return;
      live.current = false;
      setError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Autorize o microfone no navegador para conversar.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'Não encontramos um microfone conectado.'
        : error instanceof Error ? error.message : 'Não foi possível acessar o microfone.');
    } finally { if (current === generation.current) { startingRef.current = false; setStarting(false); } }
  }
  function finishRecording() { recorderRef.current?.finish(); }
  // Loudness of the user's voice while recording, for Kelly to react to (0 when not recording).
  function micLevel() { return recorderRef.current?.level() ?? 0; }
  // Cutting the clone off, by tapping it or by speaking over it: the server learns how much was heard and stops voicing the rest.
  function interrupt() {
    if (stateRef.current !== 'speaking' || mode !== 'voice') return;
    const said = heard();
    clearPlayer(); clearQueue(); setNeedsPlayback(false); live.current = true;
    sendJson({ type: 'interrupt', heard: said });
  }
  // Conversation mode: after each reply the microphone reopens by itself.
  useEffect(() => {
    if (state === 'listening' && live.current && !submitting && !needsPlayback && !recorderRef.current && !startingRef.current) void startRecording();
  }, [state, submitting, needsPlayback]);
  // While the clone speaks, speaking over it interrupts it and the recording continues from there.
  useEffect(() => {
    if (state !== 'speaking' || mode !== 'voice' || !live.current || needsPlayback) return;
    let watcher: { stop(): void } | undefined, stopped = false;
    void watchForBargeIn((stream, floor) => {
      if (stopped || stateRef.current !== 'speaking') { stream.getTracks().forEach((track) => track.stop()); return; }
      interrupt(); void startRecording({ stream, floor });
    }).then((started) => { if (stopped) started.stop(); else watcher = started; }).catch(() => { /* Tapping still interrupts. */ });
    return () => { stopped = true; watcher?.stop(); };
  }, [state, mode, needsPlayback]);
  // "Refazer minha voz": the server deletes the clone and every sample, and collecting starts over.
  async function redoVoice() {
    const response = await fetch('/api/voice/reset', { method: 'POST' });
    const status = response.ok ? parseCloneStatus(await response.json()) : null;
    if (!status) throw new Error('Não foi possível refazer a voz agora. Tente novamente.');
    cloneRef.current = status; setVoiceClone(status);
  }
  // "Voz original" or "Minha voz"; choosing the user's own voice is what starts collecting their speech.
  async function chooseVoice(own: boolean) {
    const response = await fetch('/api/voice/choice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownVoice: own }) });
    const status = response.ok ? parseCloneStatus(await response.json()) : null;
    if (!status) throw new Error('Não foi possível trocar a voz agora. Tente novamente.');
    cloneRef.current = status; setVoiceClone(status);
  }
  return { voiceClone, redoVoice, chooseVoice, state, connection, mode, model, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, usage, recall, playbackRef, unlockAudio, startRecording, finishRecording, playAnswer, micLevel, interrupt };
}
