import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { maxRecalled, maxRecordingBytes, parseAudioInput, parseClientCommand, parseSpeechProgress, type AudioInput, type ConversationState, type ServerEvent, type Usage } from '../../../shared/protocol.ts';
import { extractGestures } from '../../../shared/gestures.ts';
import { openaiTranscriptionModel, type Message, type VoiceProvider } from './voice.ts';
import { randomUUID } from 'node:crypto';
import type { MemoryService } from './memory.ts';
import type { WebSocket } from 'ws';
import { emitDiagnostic, type DiagnosticSink, type DiagnosticStage, type MemoryDiagnosticRecord } from './memory-diagnostics.ts';
import { createLanguageWorker } from './language-worker.ts';
import { originAllowed, registerWeb } from './access.ts';
import type { VoiceCloner } from './voice-clone.ts';
import { detectSpeechLanguage, type SpeechLanguage } from './speech-language.ts';
import { heardPart, segmentGestures, splitSpeech, type SpeechSegment } from './speech-segments.ts';
import type { GestureCue } from '../../../shared/gestures.ts';
import type { TimedSpeech } from './speech-timing.ts';

// webRoot: serve the built web app from there (production).
export async function createApp(options: { voice?: VoiceProvider; memory?: MemoryService; onUsage?: (record: Record<string, string | number>) => void; onMemoryDiagnostic?: (record: MemoryDiagnosticRecord) => void; webRoot?: string; cloner?: VoiceCloner } = {}) {
  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(websocket, { options: { maxPayload: maxRecordingBytes } });
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
    try { return await options.cloner.addTake(request.body, AbortSignal.timeout(90_000)); }
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
    // The reply being spoken, segment by segment. next: the first segment not yet voiced. Later segments are voiced
    // one at a time, when the page starts playing the previous one, and never after an interruption.
    type Speech = { text: string; segments: SpeechSegment[]; gestures: GestureCue[]; next: number; turnId?: string; controller: AbortController; queue: Promise<void> };
    let speech: Speech | undefined;
    function endSpeech() { speech?.controller.abort(); speech = undefined; }

    function send(event: ServerEvent) {
      if (socket.readyState === 1) socket.send(JSON.stringify(event));
    }
    function changeState(next: ConversationState, text = '') {
      state = next;
      send({ type: 'state', state, text });
    }
    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
    function cancel() {
      endSpeech();
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
    async function voiceSegment(text: string, signal: AbortSignal): Promise<TimedSpeech> {
      const voice = options.voice!, started = Date.now();
      const timed = voice.speakTimed ? await voice.speakTimed(text, signal, language) : { audio: await voice.speak(text, signal, language), phonemes: [] };
      // Speech that arrives after the turn was cancelled is dropped, as before, without another message to the page.
      signal.throwIfAborted();
      usage.ttsCharacters += Array.from(text).length;
      recordUsage('tts', { characters: Array.from(text).length, phonemes: timed.phonemes.length }, started);
      return timed;
    }
    function sendSegment(current: Speech, index: number, timed: TimedSpeech) {
      const segment = current.segments[index];
      send({ type: 'audio-output', mime: 'audio/wav', phonemes: timed.phonemes, gestures: segmentGestures(current.gestures, segment, current.text.length),
        segment: index, last: index === current.segments.length - 1, from: segment.from, to: segment.to });
      socket.send(timed.audio, { binary: true });
    }
    // The first segment is already voiced: start speaking and keep the rest for when the page asks.
    function startSpeech(text: string, gestures: GestureCue[], segments: SpeechSegment[], first: TimedSpeech, turnId?: string) {
      endSpeech();
      speech = { text, segments, gestures, next: 1, turnId, controller: new AbortController(), queue: Promise.resolve() };
      changeState('speaking', text);
      sendSegment(speech, 0, first);
      // Recovers the conversation if the tab stops confirming playback.
      timer = setTimeout(() => { endSpeech(); changeState('listening', openingText); }, 180_000);
    }
    function voiceNext(segment: number) {
      const current = speech;
      if (!current || state !== 'speaking' || segment !== current.next - 1 || current.next >= current.segments.length) return;
      const index = current.next++;
      current.queue = current.queue.then(async () => {
        if (current.controller.signal.aborted) return;
        try {
          const timed = await voiceSegment(current.segments[index].text, current.controller.signal);
          if (speech === current && state === 'speaking' && !current.controller.signal.aborted) sendSegment(current, index, timed);
        } catch {
          // The rest cannot be voiced: end the reply where the user stopped hearing it.
          if (speech !== current || current.controller.signal.aborted) return;
          interruptSpeech(current.segments[index].from, false);
        }
      });
    }
    // The user cut in (or the voice failed): keep only what was heard, in the saved turn and in this connection's history.
    function interruptSpeech(heard: number, byUser = true) {
      const current = speech;
      if (!current || state !== 'speaking') return;
      endSpeech(); clearTimer();
      const said = heardPart(current.text, heard), kept = said === current.text ? said : `${said}…`;
      if (said !== current.text) {
        if (openingText === current.text) openingText = kept;
        const last = history.at(-1);
        if (last?.role === 'assistant' && last.content === current.text) last.content = kept;
        if (current.turnId && options.memory?.trimReply) void options.memory.trimReply(current.turnId, kept, AbortSignal.timeout(10_000)).catch(() => {});
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
        const segments = splitSpeech(spoken.text);
        const first = await voiceSegment(segments[0].text, active.signal);
        if (!valid()) return;
        // A abertura não inventa uma fala do usuário e não grava fatos no banco.
        openingText = spoken.text;
        introduced = true;
        startSpeech(spoken.text, spoken.gestures, segments, first);
      } catch {
        if (!valid()) return;
        send({ type: 'error', message: 'Não foi possível concluir a abertura. Você pode começar a falar ou tentar despertar novamente.' });
        changeState('listening');
      } finally { if (controller === active) controller = undefined; }
    }
    async function respond(audio: Buffer, input: AudioInput) {
      const releaseMemory = options.memory?.acquire();
      if (options.memory && !releaseMemory) {
        send({ type: 'error', message: 'Aguarde a outra conversa terminar antes de enviar uma nova fala.' });
        return;
      }
      const voice = options.voice!;
      const current = ++generation;
      const active = new AbortController();
      const turnId = randomUUID();
      let phase: DiagnosticStage = 'transcription';
      let phaseFailed = false;
      const diagnostic: DiagnosticSink | undefined = options.memory ? (event) => {
        if (event.stage !== 'turn') {
          phase = event.stage;
          phaseFailed = event.outcome === 'failed' || event.outcome === 'cancelled';
        }
        try { options.onMemoryDiagnostic?.({ ...event, turnId }); } catch { /* Logging must not stop a conversation. */ }
      } : undefined;
      let committed = false;
      emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'started' });
      controller = active;
      const valid = () => current === generation && !active.signal.aborted && socket.readyState === 1;
      changeState('thinking');
      try {
        let started = Date.now();
        const transcript = await voice.transcribe(audio, input.mime, active.signal);
        const seconds = transcript.seconds || input.seconds;
        usage.sttSeconds += seconds;
        recordUsage('stt', { seconds, secondsSource: transcript.seconds ? 'provider' : 'recording' }, started);
        if (!valid()) return;
        if (!transcript.text) {
          // The provider answered; the recording had no recognizable speech (often a muted or very quiet microphone).
          emitDiagnostic(diagnostic, { stage: 'transcription', outcome: 'failed', reason: 'empty_transcript' });
          throw new Error('Não identificamos uma fala. Grave uma pergunta curta e tente novamente.');
        }
        send({ type: 'transcript', text: transcript.text });
        // Kelly answers in the language the user just spoke; an ambiguous utterance keeps the conversation's language.
        language = detectSpeechLanguage(transcript.text, language);
        const message: Message = { role: 'user', content: transcript.text };
        phase = 'context';
        const context = options.memory ? await options.memory.load(transcript.text, active.signal) : undefined;
        if (!valid()) return;
        if (context) send({ type: 'recall', memories: context.relevant.filter((item) => item.status === 'known')
          .slice(0, maxRecalled).map(({ slot, value }) => ({ slot, value })) });
        started = Date.now();
        phase = 'proposal';
        const answer = await voice.reply([...(context?.recent ?? history),
          ...(openingText ? [{ role: 'assistant' as const, content: openingText }] : []), message], active.signal, context, diagnostic, language);
        usage.inputTokens += answer.inputTokens;
        usage.outputTokens += answer.outputTokens;
        usage.cachedTokens += answer.cachedTokens;
        recordUsage('llm', { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens, cachedTokens: answer.cachedTokens }, started);
        if (!valid()) return;
        const spoken = extractGestures(answer.text);
        phase = 'speech';
        // Only the first sentence is voiced before speaking starts; the rest follows while it plays.
        const segments = splitSpeech(spoken.text);
        usage.turns++;
        const first = await voiceSegment(segments[0].text, active.signal);
        if (!valid()) return;
        if (options.memory && context) {
          if (!answer.learning) throw new Error('Memória: a IA não retornou os dados de continuidade.');
          phase = 'preparation';
          await options.memory.save(turnId, message.content, spoken.text, context, answer.learning, active.signal, diagnostic);
          committed = true;
          emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'completed' });
          // Só sinaliza depois do commit confirmado. O painel relê o estado real.
          notifyMemories();
          // Only committed speech is eligible. The worker never waits on playback,
          // changes socket state, or holds the foreground conversation's lock.
          languageWorker?.schedule({ turnId, context: { ...context, version: context.version + 1,
            summary: answer.learning.summary, recent: [...context.recent, message, { role: 'assistant', content: spoken.text }] },
            diagnostic: (event) => { try { options.onMemoryDiagnostic?.({ ...event, turnId }); } catch { /* best effort */ } },
            onUsage: (metrics) => {
              usage.inputTokens += metrics.inputTokens; usage.outputTokens += metrics.outputTokens; usage.cachedTokens += metrics.cachedTokens;
              recordUsage('llm-language', { inputTokens: metrics.inputTokens, outputTokens: metrics.outputTokens, cachedTokens: metrics.cachedTokens }, Date.now() - metrics.elapsedMs);
            } });
          if (!valid()) return;
        }
        // A versão sem banco mantém seu contexto temporário por conexão.
        history.push(message, { role: 'assistant', content: spoken.text });
        openingText = '';
        while (history.length > 20 || (history.length > 2 && history.reduce((size, item) => size + item.content.length, 0) > 12000)) history.splice(0, 2);
        startSpeech(spoken.text, spoken.gestures, segments, first, options.memory && context ? turnId : undefined);
      } catch (error) {
        if (valid()) {
          if (!phaseFailed) emitDiagnostic(diagnostic, { stage: phase, outcome: 'failed', reason: 'service_error' });
          emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'failed' });
        }
        if (!valid()) return;
        const message = error instanceof Error && /^(Memória:|Transcrição OpenAI:|OpenAI:|Voz Cartesia:|A transcrição |A IA |A voz |Não identificamos)/.test(error.message)
          ? error.message : 'Não foi possível concluir a conversa. Confira sua conexão e tente novamente.';
        send({ type: 'error', message });
        changeState('listening');
      } finally {
        if (!committed && !valid()) emitDiagnostic(diagnostic, { stage: 'turn', outcome: 'cancelled' });
        releaseMemory?.();
        if (controller === active) controller = undefined;
      }
    }

    socket.on('message', (payload, isBinary) => {
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
        else interruptSpeech(progress.heard);
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
      if (command === 'start' && state === 'idle') {
        if (options.voice?.opening && !introduced) void introduce();
        else changeState('listening');
        return;
      }
      if (command === 'playback-ended' && options.voice && state === 'speaking') {
        clearTimer(); endSpeech();
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
