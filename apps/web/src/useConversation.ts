import { useEffect, useRef, useState } from 'react';
import { recallKey, type Recall } from './brain/layout';
import { maxRecordingBytes, parseServerEvent, type ClientCommand, type ConversationState, type ScreenMark, type Usage } from '../../../shared/protocol';
import { closeMicrophone, openMicrophone, quietPeak, recordMicrophone, watchForBargeIn, type Recording } from './recorder';
import type { AvatarPlayback } from '../../../shared/lip-sync';
import { createSpeechPlayer } from './speech-player';
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
  const playbackRef = useRef<AvatarPlayback | null>(null);
  const generation = useRef(0);
  const startingRef = useRef(false);
  // Conversation mode: once the user wakes the clone, the microphone stays open for the whole conversation, the turn
  // ends by itself after a pause, and the user can cut in by speaking. It ends with a goodbye, a tap or a long silence.
  const live = useRef(false);
  const microphone = useRef<MediaStream | null>(null);
  // Silent stretches in a row (about 8 s each): listening simply goes on; after about two minutes the clone sleeps.
  const silences = useRef(0);
  const [listenAgain, setListenAgain] = useState(0);
  const maxSilences = 15;
  const stateRef = useRef<ConversationState>('idle');

  function sendJson(message: object) { if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(message)); }
  // A big change on screen, by the same clock as the voice's playback reports (see ScreenMark in the protocol).
  const markScreen = (what: ScreenMark['what']) => sendJson({ type: 'screen-mark', what, at: Math.round(performance.timeOrigin + performance.now()) });
  // The reply plays as it streams in; the server voices the next sentence once the page starts playing the previous one.
  const player = useRef<ReturnType<typeof createSpeechPlayer> | null>(null);
  player.current ??= createSpeechPlayer({
    onSegmentStart: (segment) => sendJson({ type: 'playing', segment }),
    onPlayed: (report) => sendJson({ type: 'voice-played', ...report }),
    onFinished: () => send('playback-ended'),
    onBlocked: (blocked) => setNeedsPlayback(blocked),
    onPlayback: (playback) => { playbackRef.current = playback; },
  });
  async function microphoneStream() {
    const open = microphone.current;
    if (open?.getTracks().some((track) => track.readyState === 'live')) return open;
    microphone.current = await openMicrophone();
    return microphone.current;
  }
  function releaseMicrophone() { if (microphone.current) { closeMicrophone(microphone.current); microphone.current = null; } }
  function stopMedia() {
    generation.current++; recorderRef.current?.cancel(); recorderRef.current = null;
    clearTimeout(wakeTimer.current); wakeTimer.current = undefined;
    startingRef.current = false; player.current!.stop();
  }
  function resetMediaUi() { setRecording(false); setStarting(false); setSubmitting(false); setNeedsPlayback(false); setWaking(false); }
  function send(command: ClientCommand) {
    if (command !== 'playback-ended') setError('');
    if (command === 'reset') { live.current = false; stopMedia(); releaseMicrophone(); resetMediaUi(); setTranscript(''); setText(''); setError(''); }
    if (command === 'start' || command === 'listen') live.current = true;
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      if (command === 'start' || command === 'listen') {
        clearTimeout(wakeTimer.current); setWaking(true);
        wakeTimer.current = setTimeout(() => { setWaking(false); wakeTimer.current = undefined; }, 1000);
      }
      socketRef.current.send(JSON.stringify({ type: 'command', command }));
    }
  }
  // Call inside a tap: browsers only allow audio, and the microphone prompt, after a gesture.
  function unlockAudio() {
    player.current!.unlock();
    void microphoneStream().catch(() => { /* Reported when recording starts. */ });
  }
  async function playAnswer() { await player.current!.resume(); }

  useEffect(() => {
    let disposed = false;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1000;
    function connect() {
      if (disposed) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
      socket.binaryType = 'arraybuffer'; socketRef.current = socket;
      // Binary messages are the PCM pieces of the segment announced last, until its audio-done.
      let expectingAudio = false;
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
        }).catch(() => { if (!disposed && socketRef.current === socket) { setMode('loading'); setError('Could not load the settings. Reload the page.'); } });
      };
      socket.onmessage = (message) => {
        if (disposed || socketRef.current !== socket) return;
        if (message.data instanceof ArrayBuffer) { if (expectingAudio) player.current!.chunk(message.data); return; }
        if (typeof message.data !== 'string') return;
        const event = parseServerEvent(message.data);
        if (!event) { setError('We received an invalid message.'); return; }
        if (event.type === 'error') { setError(event.message); setSubmitting(false); return; }
        if (event.type === 'usage') { setUsage(event.usage); return; }
        if (event.type === 'recall') { setRecall({ keys: new Set(event.memories.map(({ slot, value }) => recallKey(slot, value))), at: Date.now() }); return; }
        if (event.type === 'transcript') {
          setTranscript(event.text);
          const take = lastTake.current; lastTake.current = null;
          // Only takes with recognized speech count toward the user's voice; failures never disturb the conversation.
          const track = event.language === 'en' ? cloneRef.current?.english : cloneRef.current;
          if (take && cloneRef.current?.ownVoice && track?.collecting) void sendVoiceSample(take, event.language).then((status) => { if (status) { cloneRef.current = status; setVoiceClone(status); } }).catch(() => {});
          return;
        }
        if (event.type === 'audio-output') {
          expectingAudio = true;
          player.current!.begin({ segment: event.segment ?? 0, last: event.segment === undefined || !!event.last, from: event.from ?? 0, to: event.to ?? 0, gestures: event.gestures ?? [], clip: event.clip });
          return;
        }
        if (event.type === 'audio-done') { expectingAudio = false; player.current!.done(event.segment, event.phonemes); return; }
        if (event.type === 'speech-end') { player.current!.end(event.segments); return; }
        stateRef.current = event.state;
        setState(event.state); setText(event.text); setSubmitting(false);
        if (event.state === 'idle') { live.current = false; silences.current = 0; expectingAudio = false; stopMedia(); releaseMicrophone(); resetMediaUi(); setTranscript(''); }
        if (event.state === 'listening') { expectingAudio = false; player.current!.stop(); setNeedsPlayback(false); }
        // The server answers a held turn on its own: a recording still waiting for speech is dropped (it reopens after the reply).
        if ((event.state === 'thinking' || event.state === 'speaking') && recorderRef.current && !recorderRef.current.speaking()) { recorderRef.current.cancel(); recorderRef.current = null; setRecording(false); }
      };
      socket.onerror = () => { if (!disposed) setError('The connection is unavailable. We will try again.'); };
      socket.onclose = () => {
        if (disposed || socketRef.current !== socket) return;
        socketRef.current = null; stopMedia(); resetMediaUi();
        setConnection('offline'); setState('idle'); setText(''); setTranscript(''); setMode('loading');
        reconnect = setTimeout(connect, retryDelay); retryDelay = Math.min(retryDelay * 2, 5000);
      };
    }
    connect();
    return () => { disposed = true; clearTimeout(reconnect); stopMedia(); releaseMicrophone(); socketRef.current?.close(); socketRef.current = null; };
  }, []);

  // floor: the user cut in while the clone spoke and is already talking, so the turn counts them as speaking from the start.
  async function startRecording(floor?: number) {
    if (floor === undefined && (mode !== 'voice' || state !== 'listening' || connection !== 'online' || startingRef.current || recorderRef.current || submitting)) return;
    if (floor !== undefined && recorderRef.current) return;
    live.current = true;
    startingRef.current = true; setStarting(true); setError(''); setTranscript(''); setText('');
    const current = generation.current, takeover = floor !== undefined;
    try {
      const stream = await microphoneStream();
      if (current !== generation.current) return;
      const recorder = await recordMicrophone(async (blob, seconds, peak) => {
        recorderRef.current = null;
        if (current !== generation.current) return;
        silences.current = 0;
        setRecording(false); setSubmitting(true);
        if (blob.size === 0 || blob.size > maxRecordingBytes || seconds < 0.25) { setSubmitting(false); setError('Record a short question before sending.'); return; }
        // Skip the paid transcription when the microphone delivered near silence.
        if (peak !== undefined && peak < quietPeak) { setSubmitting(false); setError('Your microphone seems muted or too quiet. Raise the input volume in your sound settings and try again.'); return; }
        try {
          const bytes = await blob.arrayBuffer();
          if (current !== generation.current) return;
          const socket = socketRef.current;
          if (socket?.readyState !== WebSocket.OPEN) throw new Error();
          socket.send(JSON.stringify({ type: 'audio-input', mime: blob.type, seconds })); socket.send(bytes);
          // A take that began over the clone's voice may carry its echo: it never becomes a sample of the user's voice.
          lastTake.current = cloneRef.current?.ownVoice && (cloneRef.current.collecting || cloneRef.current.english.collecting) && !takeover ? blob : null;
        } catch { if (current === generation.current) { setSubmitting(false); setError('Could not send the recording. Check your connection and try again.'); } }
      }, (message) => { if (current === generation.current) { recorderRef.current = null; setRecording(false); setSubmitting(false); setError(message); } },
      // Hands-free: the turn ends by itself after a pause; if nothing was said, nothing is sent.
      { handsFree: true, stream, ...(takeover ? { floor } : {}), onSpeaking: () => sendJson({ type: 'user-speaking' }),
        // Nobody spoke: keep listening quietly; a long silence puts the clone to sleep.
        onSilent: () => {
          if (current !== generation.current) return;
          recorderRef.current = null; setRecording(false);
          if (++silences.current >= maxSilences) send('reset'); else setListenAgain((count) => count + 1);
        } });
      if (current !== generation.current) { recorder.cancel(); return; }
      recorderRef.current = recorder; setRecording(true);
    } catch (error) {
      if (current !== generation.current) return;
      live.current = false;
      setError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'Allow the microphone in your browser to talk.'
        : error instanceof DOMException && error.name === 'NotFoundError' ? 'No microphone was found.'
        : error instanceof Error ? error.message : 'Could not access the microphone.');
    } finally { if (current === generation.current) { startingRef.current = false; setStarting(false); } }
  }
  // Loudness of the user's voice while recording, for the clone to react to (0 when not recording).
  function micLevel() { return recorderRef.current?.level() ?? 0; }
  // Cutting the clone off by speaking over it: the server learns how much was heard and stops voicing the rest.
  function interrupt() {
    if (stateRef.current !== 'speaking' || mode !== 'voice') return;
    const said = player.current!.heard();
    player.current!.stop(); setNeedsPlayback(false); live.current = true;
    sendJson({ type: 'interrupt', heard: said });
  }
  // Conversation mode: after each reply the recording starts again right away, on the same microphone.
  useEffect(() => {
    if (state === 'listening' && live.current && !submitting && !needsPlayback && !recorderRef.current && !startingRef.current) void startRecording();
  }, [state, submitting, needsPlayback, listenAgain]);
  // While the clone speaks, speaking over it interrupts it and the recording continues from there.
  useEffect(() => {
    if (state !== 'speaking' || mode !== 'voice' || !live.current || needsPlayback) return;
    let watcher: { stop(): void } | undefined, stopped = false;
    void microphoneStream().then((stream) => {
      if (stopped) return;
      watcher = watchForBargeIn(stream, (floor) => {
        if (stopped || stateRef.current !== 'speaking') return;
        interrupt(); void startRecording(floor);
      });
    }).catch(() => { /* Without a microphone there is nothing to listen for. */ });
    return () => { stopped = true; watcher?.stop(); };
  }, [state, mode, needsPlayback]);
  // "Refazer minha voz": the server deletes the clone and every sample, and collecting starts over.
  async function redoVoice() {
    const response = await fetch('/api/voice/reset', { method: 'POST' });
    const status = response.ok ? parseCloneStatus(await response.json()) : null;
    if (!status) throw new Error('Could not redo your voice right now. Try again.');
    cloneRef.current = status; setVoiceClone(status);
  }
  // "Voz original" or "Minha voz"; choosing the user's own voice is what starts collecting their speech.
  async function chooseVoice(own: boolean) {
    const response = await fetch('/api/voice/choice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ownVoice: own }) });
    const status = response.ok ? parseCloneStatus(await response.json()) : null;
    if (!status) throw new Error('Could not change the voice right now. Try again.');
    cloneRef.current = status; setVoiceClone(status);
  }
  return { voiceClone, redoVoice, chooseVoice, state, connection, mode, model, text, transcript, error, send, waking, recording, starting, submitting, needsPlayback, usage, recall, playbackRef, unlockAudio, playAnswer, micLevel, markScreen };
}
