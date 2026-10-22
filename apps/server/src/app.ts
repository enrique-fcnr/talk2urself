import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { maxRecalled, maxRecordingBytes, parseAudioInput, parseClientCommand, parseSpeechProgress, type AudioInput, type ConversationState, type ServerEvent, type Usage } from '../../../shared/protocol.ts';
import { extractGestures, wantsSleep } from '../../../shared/gestures.ts';
import { openaiTranscriptionModel, type Message, type VoiceProvider } from './voice.ts';
import { randomUUID } from 'node:crypto';
import type { MemoryService, StoredMemory } from './memory.ts';
import type { WebSocket } from 'ws';
import { emitDiagnostic, type DiagnosticSink, type DiagnosticStage, type MemoryDiagnosticRecord } from './memory-diagnostics.ts';
import { createLanguageWorker } from './language-worker.ts';
import { originAllowed, registerWeb } from './access.ts';
import { registerGate } from './gate.ts';
import type { VoiceCloner } from './voice-clone.ts';
import { detectSpeechLanguage, type SpeechLanguage } from './speech-language.ts';
import { heardPart, segmentGestures, splitSpeech, type SpeechSegment } from './speech-segments.ts';
import { firstSentenceEnd } from './reply-stream.ts';
import { looksUnfinished } from './turn-end.ts';
import type { GestureCue } from '../../../shared/gestures.ts';
import type { TimedSpeech } from './speech-timing.ts';

// webRoot: serve the built web app from there (production).
export async function createApp(options: { voice?: VoiceProvider; memory?: MemoryService; onUsage?: (record: Record<string, string | number>) => void; onMemoryDiagnostic?: (record: MemoryDiagnosticRecord) => void; webRoot?: string; cloner?: VoiceCloner;
  // Development only: each message the page sends and each state the server enters, without any content.
  onDebug?: (record: Record<string, string | number>) => void;
  // accessCode: only browsers that opened the site with ?k=<code> get in (see gate.ts).
  // trustProxy: which proxies may report the client address; behind a local Caddy, only 'loopback'.
  accessCode?: string; trustProxy?: boolean | string } = {}) {
  const app = Fastify({ logger: false, trustProxy: options.trustProxy ?? true });
  await app.register(websocket, { options: { maxPayload: maxRecordingBytes } });
  if (options.accessCode) registerGate(app, options.accessCode);
  if (options.webRoot) registerWeb(app, options.webRoot);
  const viewers = new Set<WebSocket>();
  const notifyMemories = () => { for (const viewer of viewers) if (viewer.readyState === 1) viewer.send(JSON.stringify({ type: 'memory-sync' })); };
  const languageWorker = options.voice?.observeLanguage && options.memory?.saveLanguage
    ? createLanguageWorker(options.voice, options.memory, notifyMemories) : undefined;
  app.addHook('onClose', async () => { await languageWorker?.close(); });
  app.get('/api/memory/vectors', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não permitida.' });
    if (!options.memory) return { enabled: false };
    try { return { enabled: true, ...await options.memory.vectors(AbortSignal.timeout(20_000)) }; }
    catch { return reply.code(503).send({ error: 'Não foi possível carregar o mapa de memórias.' }); }
  });
  // How many facts Kelly holds; the avatar's brain glows brighter as it grows.
  app.get('/api/memory/count', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não permitida.' });
    if (!options.memory?.count) return { enabled: false };
    try { return { enabled: true, count: await options.memory.count(AbortSignal.timeout(10_000)) }; }
    catch { return reply.code(503).send({ error: 'Não foi possível contar as memórias.' }); }
  });
  // Canal de observação: não recebe áudio, não escreve no banco nem chama modelos.
  app.get('/ws/memories', { websocket: true, preValidation: async (request, reply) => {
    if (!originAllowed(request)) await reply.code(403).send({ error: 'Origem não permitida.' });
  } }, (socket) => {
    viewers.add(socket);
    socket.send(JSON.stringify({ type: 'memory-sync' }));
    socket.on('close', () => viewers.delete(socket));
    socket.on('error', () => viewers.delete(socket));
  });
  app.addHook('onClose', async () => { for (const socket of viewers) socket.close(); viewers.clear(); });

  app.get('/api/health', async () => ({ ok: true, mode: options.voice ? 'voice' : 'demo', model: options.voice?.model ?? null,
    ...(options.memory ? { memory: 'configured' } : {}), ...(options.cloner ? { voiceClone: options.cloner.status() } : {}) }));
  // Voice cloning (VOICE_CLONING=1): the page sends each clean take of the user's speech as 16-bit mono WAV.
  app.addContentTypeParser('audio/wav', { parseAs: 'buffer', bodyLimit: 2 * 1024 * 1024 }, (_request, body, done) => done(null, body));
  app.get('/api/voice', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não autorizada.' });
    if (!options.cloner) return { enabled: false };
    await options.cloner.ready();
    return options.cloner.status();
  });
  app.post('/api/voice/sample', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não autorizada.' });
    if (!options.cloner) return reply.code(404).send({ error: 'Clonagem de voz desligada.' });
    if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: 'Envie a amostra em WAV.' });
    // language: the language the take was spoken in (each language has its own clone).
    const language = (request.query as { language?: string }).language === 'en' ? 'en' : 'pt';
    try { return await options.cloner.addTake(request.body, AbortSignal.timeout(90_000), language); }
    catch { return reply.code(503).send({ error: 'Não foi possível guardar a amostra de voz agora.' }); }
  });
  app.post('/api/voice/choice', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não autorizada.' });
    if (!options.cloner) return reply.code(404).send({ error: 'Sua voz ainda não está disponível.' });
    const body = request.body as { ownVoice?: unknown } | undefined;
    if (typeof body?.ownVoice !== 'boolean') return reply.code(400).send({ error: 'Escolha inválida.' });
    try { return await options.cloner.choose(body.ownVoice, AbortSignal.timeout(30_000)); }
    catch { return reply.code(503).send({ error: 'Não foi possível trocar a voz agora.' }); }
  });
  // "Refazer minha voz": deletes the clone and every sample; collecting starts over.
  app.post('/api/voice/reset', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não autorizada.' });
    if (!options.cloner) return reply.code(404).send({ error: 'Clonagem de voz desligada.' });
    try { return await options.cloner.reset(AbortSignal.timeout(60_000)); }
    catch { return reply.code(503).send({ error: 'Não foi possível refazer a voz agora. Tente novamente.' }); }
  });
  app.get('/api/memory', async (request, reply) => {
    if (!originAllowed(request)) return reply.code(403).send({ error: 'Origem não permitida.' });
    if (!options.memory) return { enabled: false };
    try {
      const context = await options.memory.inspect(AbortSignal.timeout(20_000));
      return { enabled: true, summary: context.summary, profile: context.profile, gaps: context.gaps, version: context.version, categories: context.categories };
    } catch { return reply.code(503).send({ error: 'Não foi possível carregar suas memórias.' }); }
  });

  app.get('/ws', {
    websocket: true,
    preValidation: async (request, reply) => {
      if (!originAllowed(request)) {
        await reply.code(403).send({ error: 'Origem não permitida.' });
      }
    },
  }, (socket) => {
    // A conexão controla o áudio. Quando configurado, o banco guarda a continuidade do usuário local.
    let state: ConversationState = 'idle';
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingAudio: AudioInput | null = null;
    let controller: AbortController | undefined;
    let generation = 0;
    const history: Message[] = [];
    let introduced = false;
    let openingText = '';
    // The language of the conversation: the last one the user spoke (Kelly opens in Portuguese).
    let language: SpeechLanguage = 'pt';
    const usage: Usage = { turns: 0, sttSeconds: 0, ttsCharacters: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    // The reply being spoken, segment by segment. The first segment can start before the model has finished writing;
    // the rest is added once it has (complete). wanted: up to which segment the page may play next, since it asks for the
    // next one only when it starts playing the previous; nothing more is voiced after an interruption.
    // sleep: the user said goodbye, so the clone falls asleep once this reply has been heard.
    // onCut: how an interruption shortens what the turn remembers having said.
    type Spoken = SpeechSegment & { gestures: GestureCue[] };
    // active: speaking has started (with the first piece of audio); before that the speech is being prepared.
    // userText/turnId: what the user said for this reply, and its saved turn (for a continuation).
    type Speech = { text: string; segments: Spoken[]; complete: boolean; active: boolean; next: number; sent: number; wanted: number; sleep?: boolean; userText?: string; turnId?: string;
      onCut?: (kept: string) => void; controller: AbortController; queue: Promise<void> };
    // preparing: the next reply, voicing its first sentence before it starts speaking (cancelled like the one speaking).
    let speech: Speech | undefined, preparing: Speech | undefined;
    // The previous turn's memory write, which the next turn waits for before reading memory.
    let saving: Promise<void> = Promise.resolve();
    // held: a turn that ended mid-sentence ("e…", "mas…"), waiting a moment for the rest. continuing: the user cut the
    // clone off during its first sentence, so what they say next completes what they had said, not a new turn.
    let held: { text: string } | undefined, holdTimer: ReturnType<typeof setTimeout> | undefined, holds = 0;
    let continuing: { text: string; turnId?: string } | undefined;
    const holdSeconds = 1.6;
    function clearHold() { if (holdTimer) clearTimeout(holdTimer); holdTimer = undefined; }
    function endSpeech() { speech?.controller.abort(); preparing?.controller.abort(); speech = undefined; preparing = undefined; }
    function send(event: ServerEvent) {
      if (event.type === 'error') options.onDebug?.({ connection: 'server', state, event: 'error', message: event.message });
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    }
    const connection = randomUUID().slice(0, 8);
    const debug = (record: Record<string, string | number>) => { try { options.onDebug?.({ connection, state, ...record }); } catch { /* best effort */ } };
    function changeState(next: ConversationState, text = '') {
      debug({ event: 'state', next });
      state = next;
      send({ type: 'state', state, text });
    }
    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    function cancel() {
      endSpeech(); clearHold(); held = undefined; continuing = undefined; holds = 0;
      generation++;
      controller?.abort();
      controller = undefined;
      pendingAudio = null;
      clearTimer();
    }
    function recordUsage(service: string, metrics: Record<string, string | number>, started: number) {
      send({ type: 'usage', usage: { ...usage } });
      options.onUsage?.({ service, model: service.startsWith('llm') ? options.voice!.model : service === 'stt' ? openaiTranscriptionModel : 'sonic-3.6', elapsedMs: Date.now() - started, ...metrics });
    }
    async function voiceSegment(text: string, signal: AbortSignal, onChunk?: (pcm: Buffer) => void): Promise<TimedSpeech> {
      const voice = options.voice!, started = Date.now();
      const timed = voice.speakTimed ? await voice.speakTimed(text, signal, language, onChunk)
        : await voice.speak(text, signal, language).then((audio) => { onChunk?.(audio.subarray(44)); return { audio, phonemes: [] }; });
      // Speech that arrives after the turn was cancelled is dropped, as before, without another message to the page.
      signal.throwIfAborted();
      usage.ttsCharacters += Array.from(text).length;
      recordUsage('tts', { characters: Array.from(text).length, phonemes: timed.phonemes.length }, started);
      return timed;
    }
    // Segments with their gesture cues, from a whole spoken text.
    function spokenSegments(text: string, gestures: GestureCue[], continuing = false): Spoken[] {
      return splitSpeech(text, continuing).map((segment) => ({ ...segment, gestures: segmentGestures(gestures, segment, text.length) }));
    }
    function newSpeech(text: string, segments: Spoken[], complete: boolean, onCut?: (kept: string) => void): Speech {
      preparing?.controller.abort();
      preparing = { text, segments, complete, active: false, next: 1, sent: 0, wanted: 0, onCut, controller: new AbortController(), queue: Promise.resolve() };
      return preparing;
    }
    // Speaking starts with the first piece of audio.
    function activate(current: Speech) {
      if (current.active) return;
      if (speech && speech !== current) speech.controller.abort();
      if (preparing === current) preparing = undefined;
      current.active = true; speech = current;
      changeState('speaking', current.text);
      // Recovers the conversation if the tab stops confirming playback.
      timer = setTimeout(() => { endSpeech(); changeState('listening', openingText); }, 180_000);
    }
    // Voices one segment and streams it to the page as it is generated: an announcement, raw PCM pieces, then the
    // mouth cues once the whole segment is known. canStart: whether this turn may still start speaking.
    async function streamSegment(current: Speech, index: number, canStart: () => boolean = () => true) {
      const segment = current.segments[index];
      let announced = false;
      const live = () => speech === current && state === 'speaking' && !current.controller.signal.aborted;
      const announce = () => {
        if (announced) return live();
        if (!current.active) { if (!canStart() || current.controller.signal.aborted) return false; activate(current); }
        if (!live()) return false;
        announced = true; current.sent = Math.max(current.sent, index + 1);
        send({ type: 'audio-output', mime: 'audio/pcm', gestures: segment.gestures, segment: index,
          last: current.complete && index === current.segments.length - 1, from: segment.from, to: segment.to });
        return true;
      };
      const timed = await voiceSegment(segment.text, current.controller.signal, (pcm) => { if (announce()) socket.send(pcm, { binary: true }); });
      if (!announce()) return;
      send({ type: 'audio-done', segment: index, phonemes: timed.phonemes });
    }
    // The model finished: the whole text and all segments are known.
    function completeSpeech(current: Speech, text: string, segments: Spoken[], sleep: boolean, onCut?: (kept: string) => void) {
      const grew = current.text !== text, late = !current.complete;
      Object.assign(current, { text, segments, complete: true, sleep, ...(onCut ? { onCut } : {}) });
      if (speech !== current || state !== 'speaking') return;
      if (grew) send({ type: 'state', state: 'speaking', text });
      // Every segment already went out (the last one before anyone knew it was the last): tell the page there is no more.
      if (late && current.sent >= segments.length) send({ type: 'speech-end', segments: segments.length });
      pump(current);
    }
    function pump(current: Speech) {
      while (current.next <= current.wanted && current.next < current.segments.length) {
        const index = current.next++;
        current.queue = current.queue.then(async () => {
          if (current.controller.signal.aborted) return;
          try { await streamSegment(current, index); }
          catch {
            // The rest cannot be voiced: end the reply where the user stopped hearing it.
            if (speech !== current || current.controller.signal.aborted) return;
            interruptSpeech(current.segments[index].from, false);
          }
        });
      }
    }
    function voiceNext(segment: number) {
      const current = speech;
      if (!current || state !== 'speaking') return;
      current.wanted = Math.max(current.wanted, segment + 1);
      pump(current);
    }
    // The user cut in (or the voice failed): keep only what was heard, in the saved turn and in this connection's history.
    function interruptSpeech(heard: number, byUser = true) {
      const current = speech;
      if (!current || state !== 'speaking') return;
      endSpeech(); clearTimer();
      const said = heardPart(current.text, heard), whole = current.complete && said === current.text, kept = whole ? said : `${said}…`;
      // Cut during its first sentence: the clone answered too early, so the user's next words continue their own.
      if (byUser && current.userText && heard <= (current.segments[0]?.to ?? 0)) continuing = { text: current.userText, turnId: current.turnId };
      if (!whole) {
        if (openingText === current.text) openingText = kept;
        const last = history.at(-1);
        if (last?.role === 'assistant' && last.content === current.text) last.content = kept;
        current.onCut?.(kept);
      }
      changeState('listening', byUser ? '' : kept);
    }
    async function introduce() {
      const voice = options.voice!;
      const active = new AbortController();
      const current = ++generation;
      controller = active;
      const valid = () => current === generation && !active.signal.aborted && socket.readyState === 1;
      changeState('thinking');
      try {
        const context = options.memory ? await options.memory.inspect(active.signal) : undefined;
        if (!valid()) return;
        let started = Date.now();
        const answer = await voice.opening!(context, active.signal);
        usage.inputTokens += answer.inputTokens;
        usage.outputTokens += answer.outputTokens;
        usage.cachedTokens += answer.cachedTokens;
        if (answer.inputTokens || answer.outputTokens) recordUsage('llm', { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cachedTokens: answer.cachedTokens }, started);
        if (!valid()) return;
        // Gesture marks become animation cues and never reach the voice, the screen or the history.
        const spoken = extractGestures(answer.text);
        const segments = spokenSegments(spoken.text, spoken.gestures);
        // A abertura não inventa uma fala do usuário e não grava fatos no banco.
        openingText = spoken.text;
        introduced = true;
        const opening = newSpeech(spoken.text, segments, true);
        opening.queue = streamSegment(opening, 0, valid);
        await opening.queue;
        if (!valid()) return;
      } catch {
        if (!valid()) return;
        send({ type: 'error', message: 'Não foi possível concluir a abertura. Você pode começar a falar ou tentar despertar novamente.' });
        changeState('listening');
      } finally { if (controller === active) controller = undefined; }
    }
    // audio + input: a recording to transcribe; without them, the turn held as unfinished is answered as it is.
    async function respond(audio: Buffer | null, input: AudioInput | null) {
      const voice = options.voice!;
      const current = ++generation;
      const active = new AbortController();
      controller = active;
      const valid = () => current === generation && !active.signal.aborted && socket.readyState === 1;
      // Once the reply is under way, a newer turn (the user cut in) does not drop this one: only ending the conversation does.
      const alive = () => !active.signal.aborted && socket.readyState === 1;
      changeState('thinking');
      // Turns are chained from their start: this one reads memory only once the previous one has written it, and the
      // next one waits for this one the same way (until its memory is written, even if that happens in the background).
      const previous = saving;
      let turnDone!: () => void;
      saving = new Promise<void>((resolve) => { turnDone = resolve; });
      await previous;
      if (!valid()) { turnDone(); return; }
      const releaseMemory = options.memory?.acquire();
      if (options.memory && !releaseMemory) {
        turnDone();
        send({ type: 'error', message: 'Aguarde a outra conversa terminar antes de enviar uma nova fala.' });
        changeState('listening');
        return;
      }
      const turnId = randomUUID();
      let phase: DiagnosticStage = 'transcription';
      let phaseFailed = false, committed = false, handedOff = false;
      const diagnostic: DiagnosticSink | undefined = options.memory ? (event) => {
        if (event.stage !== 'turn') {
          phase = event.stage;
          phaseFailed = event.outcome === 'failed' || event.outcome === 'cancelled';
        }
        try { options.onMemoryDiagnostic?.({ ...event, turnId }); } catch { /* Logging must not stop a conversation. */ }
      } : undefined;
      emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'started' });
      let spoken: Speech | undefined;
      try {
        let started = Date.now();
        // A continuation replaces the turn the clone answered too early: it goes before memory is read.
        const resumed = continuing, before = held?.text;
        continuing = undefined; held = undefined; clearHold();
        if (resumed) {
          if (resumed.turnId && options.memory?.forgetTurn) await options.memory.forgetTurn(resumed.turnId, active.signal).catch(() => {});
          let at = history.length - 1;
          while (at >= 0 && !(history[at].role === 'user' && history[at].content === resumed.text)) at--;
          if (at >= 0) history.splice(at, 2);
          if (!valid()) return;
        }
        // What memory holds does not depend on what was said: it loads while the speech is transcribed.
        const base = options.memory?.loadBase?.(active.signal);
        base?.catch(() => { /* Reported when the turn awaits it. */ });
        let heard = '';
        if (audio && input) {
          const transcript = await voice.transcribe(audio, input.mime, active.signal);
          const seconds = transcript.seconds || input.seconds;
          usage.sttSeconds += seconds;
          recordUsage('stt', { seconds, secondsSource: transcript.seconds ? 'provider' : 'recording' }, started);
          if (!valid()) return;
          if (!transcript.text && !before) {
            // The provider answered; the recording had no recognizable speech (often a muted or very quiet microphone).
            emitDiagnostic(diagnostic, { stage: 'transcription', outcome: 'failed', reason: 'empty_transcript' });
            throw new Error('Não identificamos uma fala. Grave uma pergunta curta e tente novamente.');
          }
          heard = transcript.text;
          // The clone answers in the language the user just spoke; an ambiguous utterance keeps the conversation's language.
          if (heard) language = detectSpeechLanguage(heard, language);
          if (heard) send({ type: 'transcript', text: heard, language });
        }
        // The whole of what the user said: the sentence they picked up again, the part held a moment ago, and this one.
        const userSaid = [resumed?.text, before, heard].filter(Boolean).join(' ');
        // Ended mid-sentence: hold it for a moment (twice at most in a row) so the rest joins it, unless it came from that wait.
        if (audio && looksUnfinished(userSaid) && holds < 2) {
          holds++;
          held = { text: userSaid };
          holdTimer = setTimeout(() => { holdTimer = undefined; if (held && state === 'listening') void respond(null, null); }, holdSeconds * 1000);
          emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'cancelled' });
          changeState('listening');
          return;
        }
        holds = 0;
        const message: Message = { role: 'user', content: userSaid };
        phase = 'context';
        const context = options.memory ? await (base ?? options.memory.load(message.content, active.signal)) : undefined;
        if (!valid()) return;
        const recalled = (memories: StoredMemory[]) => { if (valid()) send({ type: 'recall', memories: memories.filter((item) => item.status === 'known')
          .slice(0, maxRecalled).map(({ slot, value }) => ({ slot, value })) }); };
        // The memories closest to what was said light up in the brain; with the base context they are found alongside the reply.
        if (context && base && options.memory?.recall) void options.memory.recall(message.content, AbortSignal.timeout(20_000)).then(recalled, () => {});
        else if (context) recalled(context.relevant);
        started = Date.now();
        phase = 'proposal';
        // The first sentence is voiced as soon as the model has written it, and speaking starts while it writes the rest
        // (and, with memory, the summary and what it learned).
        let firstRaw: string | undefined, firstVoice: Promise<void> | undefined, cutAt: string | undefined;
        const begin = (raw: string) => {
          firstRaw = raw;
          const first = extractGestures(raw);
          usage.turns++;
          spoken = newSpeech(first.text, [{ text: first.text, from: 0, to: first.text.length, gestures: first.gestures }], false, (kept) => { cutAt = kept; });
          spoken.userText = message.content; spoken.turnId = options.memory && context ? turnId : undefined;
          firstVoice = streamSegment(spoken, 0, valid);
          spoken.queue = firstVoice.catch(() => { /* Reported when the turn awaits it. */ });
        };
        const answer = await voice.reply([...(context?.recent ?? history),
          ...(openingText ? [{ role: 'assistant' as const, content: openingText }] : []), message], active.signal, context, diagnostic, language,
          (text, done) => { if (firstRaw === undefined && valid()) { const end = firstSentenceEnd(text, done); if (end > 0) begin(text.slice(0, end)); } });
        usage.inputTokens += answer.inputTokens;
        usage.outputTokens += answer.outputTokens;
        usage.cachedTokens += answer.cachedTokens;
        recordUsage('llm', { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cachedTokens: answer.cachedTokens }, started);
        if (!alive() || (firstRaw === undefined && !valid())) return;
        if (firstRaw === undefined) begin(answer.text.slice(0, Math.max(1, firstSentenceEnd(answer.text, true))));
        // The whole reply: the first sentence, then the rest in segments. Gesture marks never reach the voice or the history.
        const first = extractGestures(firstRaw!), rest = extractGestures(answer.text.slice(firstRaw!.length));
        const text = rest.text ? `${first.text} ${rest.text}` : first.text, offset = first.text.length + 1;
        const segments: Spoken[] = [{ text: first.text, from: 0, to: first.text.length, gestures: first.gestures },
          ...(rest.text ? spokenSegments(rest.text, rest.gestures, true).map((segment) => ({ ...segment, from: segment.from + offset, to: segment.to + offset })) : [])];
        if (!first.text) throw new Error('A IA não produziu uma resposta de voz com tamanho adequado.');
        // Known before the first sentence finished voicing: speaking starts with the whole text and every segment.
        completeSpeech(spoken!, text, segments, wantsSleep(answer.text));
        phase = 'speech';
        await firstVoice;
        if (!alive() || !spoken) return;
        // Superseded before a word was heard: the turn remembers saying nothing.
        if (!spoken.active) cutAt = '…';
        const said = () => cutAt ?? text;
        let trim: ((kept: string) => void) | undefined;
        if (options.memory && context) {
          if (!answer.learning) throw new Error('Memória: a IA não retornou os dados de continuidade.');
          const learning = answer.learning;
          phase = 'preparation';
          // Written in the background, holding the memory until done: the voice does not wait for it.
          handedOff = true;
          const saved = (async () => {
            try {
              await options.memory!.save(turnId, message.content, said(), context, learning, AbortSignal.timeout(30_000), diagnostic);
              committed = true;
              emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'completed' });
              // Só sinaliza depois do commit confirmado. O painel relê o estado real.
              notifyMemories();
              // Only committed speech is eligible. The worker never waits on playback,
              // changes socket state, or holds the foreground conversation's lock.
              languageWorker?.schedule({ turnId, context: { ...context, version: context.version + 1,
                summary: learning.summary, recent: [...context.recent, message, { role: 'assistant', content: said() }] },
                diagnostic: (event) => { try { options.onMemoryDiagnostic?.({ ...event, turnId }); } catch { /* best effort */ } },
                onUsage: (metrics) => {
                  usage.inputTokens += metrics.inputTokens; usage.outputTokens += metrics.outputTokens; usage.cachedTokens += metrics.cachedTokens;
                  recordUsage('llm-language', { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, cachedTokens: metrics.cachedTokens }, Date.now() - metrics.elapsedMs);
                } });
            } catch (error) {
              if (!phaseFailed) emitDiagnostic(diagnostic, { stage: phase, outcome: 'failed', reason: 'service_error' });
              emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'failed' });
              send({ type: 'error', message: error instanceof Error && error.message.startsWith('Memória:') ? error.message : 'Memória: não foi possível guardar esta conversa.' });
            } finally { releaseMemory?.(); turnDone(); }
          })();
          // An interruption after this point shortens the saved turn once it has landed.
          trim = (kept) => { if (options.memory?.trimReply) void saved.then(() => options.memory!.trimReply!(turnId, kept, AbortSignal.timeout(10_000))).catch(() => {}); };
        }
        // A versão sem banco mantém seu contexto temporário por conexão.
        history.push(message, { role: 'assistant', content: said() });
        openingText = '';
        while (history.length > 20 || (history.length > 2 && history.reduce((size, item) => size + item.content.length, 0) > 12000)) history.splice(0, 2);
        if (trim) spoken.onCut = trim;
      } catch (error) {
        if (valid()) {
          if (!phaseFailed) emitDiagnostic(diagnostic, { stage: phase, outcome: 'failed', reason: 'service_error' });
          emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'failed' });
        }
        if (!valid()) return;
        const message = error instanceof Error && /^(Memória:|Transcrição OpenAI:|OpenAI:|Voz Cartesia:|A transcrição |A IA |A voz |Não identificamos)/.test(error.message)
          ? error.message : 'Não foi possível concluir a conversa. Confira sua conexão e tente novamente.';
        if (spoken && speech === spoken) endSpeech();
        send({ type: 'error', message });
        changeState('listening');
      } finally {
        if (!committed && !handedOff && !valid()) emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'cancelled' });
        if (!handedOff) { releaseMemory?.(); turnDone(); }
        if (controller === active) controller = undefined;
      }
    }

    socket.on('message', (payload, isBinary) => {
      if (isBinary) debug({ event: 'binary', pending: pendingAudio ? 'yes' : 'no' });
      else { try { const value = JSON.parse(payload.toString()); debug({ event: String(value.type), ...(value.command ? { command: String(value.command) } : {}), ...(typeof value.segment === 'number' ? { segment: value.segment } : {}), ...(typeof value.mime === 'string' ? { mime: value.mime.slice(0, 60) } : {}) }); } catch { /* reported below */ } }
      if (isBinary) {
        const input = pendingAudio;
        pendingAudio = null;
        if (!options.voice || state !== 'listening' || !input) {
          send({ type: 'error', message: 'O áudio chegou fora do turno de fala.' });
          return;
        }
        clearTimer();
        const audio = Buffer.isBuffer(payload) ? payload : Array.isArray(payload) ? Buffer.concat(payload) : Buffer.from(payload);
        if (audio.length === 0 || audio.length > maxRecordingBytes) {
          send({ type: 'error', message: 'A gravação está vazia ou excede o limite.' });
          return;
        }
        void respond(audio, input);
        return;
      }
      if (payload.toString().length > 4096) {
        send({ type: 'error', message: 'Mensagem muito grande.' });
        return;
      }
      const progress = parseSpeechProgress(payload.toString());
      if (progress) {
        if (progress.type === 'playing') voiceNext(progress.segment);
        else if (progress.type === 'interrupt') interruptSpeech(progress.heard);
        // The user is talking again: a held turn waits for the rest instead of being answered on its own
        // (still answered if no recording follows).
        else if (holdTimer) { clearHold(); holdTimer = setTimeout(() => { holdTimer = undefined; if (held && state === 'listening') void respond(null, null); }, 12_000); }
        return;
      }
      const input = parseAudioInput(payload.toString());
      if (input) {
        if (!options.voice || state !== 'listening' || pendingAudio) {
          send({ type: 'error', message: 'Aguarde o turno atual terminar.' });
          return;
        }
        pendingAudio = input;
        timer = setTimeout(() => { pendingAudio = null; send({ type: 'error', message: 'A gravação não chegou. Tente novamente.' }); }, 10_000);
        return;
      }
      const command = parseClientCommand(payload.toString());
      if (!command) {
        send({ type: 'error', message: 'Comando não reconhecido.' });
        return;
      }
      if (command === 'reset') {
        cancel();
        changeState('idle');
        return;
      }
      if (command === 'listen' && state === 'idle') {
        changeState('listening');
        return;
      }
      if (command === 'start' && state === 'idle') {
        if (options.voice?.opening && !introduced) void introduce();
        else changeState('listening');
        return;
      }
      if (command === 'playback-ended' && options.voice && state === 'speaking') {
        const sleep = speech?.sleep;
        clearTimer(); endSpeech();
        // A goodbye was heard in full: the clone falls asleep (the page returns to its start screen).
        if (sleep) { changeState('idle'); return; }
        changeState('listening', openingText);
        return;
      }
      if (command === 'submit-demo' && !options.voice && state === 'listening') {
        changeState('thinking');
        // Tempos e texto demonstrativos: não há chamadas de IA ou áudio aqui.
        timer = setTimeout(() => {
          changeState('speaking', 'Qual é a menor parte dessa ideia que você consegue testar hoje?');
          timer = setTimeout(() => changeState('listening'), 2600);
        }, 900);
        return;
      }
      send({ type: 'error', message: 'Aguarde o turno atual terminar.' });
    });
    socket.on('close', cancel);
    socket.on('error', cancel);
    changeState('idle');
  });

  return app;
}
