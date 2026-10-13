import type { MemoryContext, MemoryService } from './memory.ts';
import type { VoiceProvider } from './voice.ts';
import { languageAnalysisPlan } from './language.ts';
import { emitDiagnostic, type DiagnosticSink } from './memory-diagnostics.ts';

type LanguageUsage = { inputTokens: number; outputTokens: number; cachedTokens: number; elapsedMs: number };
type Job = { turnId: string; context: MemoryContext; diagnostic?: DiagnosticSink; onUsage?: (usage: LanguageUsage) => void };

// One worker belongs to the local user's MemoryService, shared by all sockets.
// Pending turns coalesce to the latest snapshot; there is no growing task queue.
export function createLanguageWorker(voice: VoiceProvider, memory: MemoryService, notify: () => void) {
  let pending: Job | undefined;
  let running: Promise<void> | undefined;
  let active: AbortController | undefined;
  let stopped = false;
  function start() {
    if (!running && !stopped && pending) running = Promise.resolve().then(drain).finally(() => { running = undefined; start(); });
  }
  async function drain() {
    while (pending && !stopped) {
      const job = pending; pending = undefined;
      const report: DiagnosticSink = (event) => emitDiagnostic(job.diagnostic, { ...event, source: 'language' });
      const controller = new AbortController(); active = controller;
      try {
        const latest = await memory.inspect(controller.signal);
        if (latest.version !== job.context.version) {
          emitDiagnostic(report, { stage: 'language_analysis', outcome: 'skipped', reason: 'stale_context' }); continue;
        }
        let messages = job.context.recent.filter((message) => message.role === 'user');
        const context = { ...latest, recent: job.context.recent };
        if (memory.languageContext) {
          context.language = await memory.languageContext(job.turnId,controller.signal);
          emitDiagnostic(report,{stage:'language_candidates',outcome:'completed',count:context.language.candidates.length,
            ...(context.language.atLimit ? {reason:'candidate_limit' as const} : {})});
          messages = context.language.sources.map(source => ({ role:'user' as const,content:source.text }));
        }
        const plan = languageAnalysisPlan(messages, context);
        if (plan !== 'ready') { emitDiagnostic(report, { stage: 'language_analysis', outcome: 'skipped', reason: plan }); continue; }
        emitDiagnostic(report, { stage: 'language_analysis', outcome: 'started' });
        const started = Date.now();
        const result = await voice.observeLanguage!(messages, controller.signal, context, report);
        try { job.onUsage?.({ inputTokens: result.inputTokens, outputTokens: result.outputTokens, cachedTokens: result.cachedTokens, elapsedMs: Date.now() - started }); } catch { /* usage logging is best effort */ }
        controller.signal.throwIfAborted();
        emitDiagnostic(report, { stage: 'language_analysis', outcome: 'completed', count: result.updates.length });
        if (!result.updates.length && !result.rejectedCandidates?.length) continue;
        const saved = await memory.saveLanguage!(job.turnId, context, result.updates, controller.signal, report,result.rejectedCandidates);
        if (saved.applied) notify();
      } catch {
        emitDiagnostic(report, { stage: 'language_analysis', outcome: controller.signal.aborted ? 'cancelled' : 'failed', reason: 'service_error' });
      } finally { if (active === controller) active = undefined; }
    }
  }
  return {
    schedule(job: Job) {
      if (stopped) return;
      pending = { ...job, context: structuredClone(job.context) };
      start();
    },
    async idle() { while (running) await running; },
    async close() { stopped = true; pending = undefined; active?.abort(); await running; },
  };
}
