// Only fixed labels and counters belong here: never conversation text or credentials.
export type DiagnosticStage = 'turn' | 'transcription' | 'context' | 'language_candidates' | 'language_analysis' | 'proposal' | 'validation' | 'speech' | 'preparation' | 'embedding' | 'commit';
export type DiagnosticOutcome = 'started' | 'completed' | 'accepted' | 'rejected' | 'skipped' | 'failed' | 'cancelled';
export type DiagnosticReason = 'invalid_format' | 'invalid_fields' | 'duplicate_slot' | 'missing_current_evidence' | 'empty_value' | 'unsupported_observation' | 'invalid_samples' | 'insufficient_user_utterances' | 'value_too_long' | 'no_known_updates' | 'service_error' | 'empty_transcript' | 'periodic_interval' | 'language_declined' | 'update_limit' | 'stale_context' | 'candidate_limit';
export type DiagnosticField = 'proposal' | 'slot' | 'category' | 'categoryDescription' | 'value' | 'evidence' | 'basis' | 'status' | 'supportingEvidence' | 'candidateIds';
export type DiagnosticDetail = 'invalid_type' | 'invalid_pattern' | 'empty' | 'too_short' | 'too_long' | 'invalid_choice' | 'wrong_count' | 'missing_current_sample' | 'unmatched_sources' | 'invalid_candidate' | 'candidate_sample_mismatch';
export type MemoryDiagnostic = { stage: DiagnosticStage; outcome: DiagnosticOutcome; reason?: DiagnosticReason; field?: DiagnosticField; detail?: DiagnosticDetail; candidate?: number; candidateIds?: string[]; correctedFields?: DiagnosticField[]; count?: number; languageCount?: number; language?: boolean; source?: 'conversation' | 'language' };
export type DiagnosticSink = (event: MemoryDiagnostic) => void;
export type MemoryDiagnosticRecord = MemoryDiagnostic & { turnId: string };

export function emitDiagnostic(sink: DiagnosticSink | undefined, event: MemoryDiagnostic): void {
  // A broken local log must not change the conversation or the database transaction.
  try { sink?.(event); } catch { /* Best effort, independent from the memory pipeline. */ }
}

export function serializeDiagnostic(record: MemoryDiagnosticRecord): string {
  const { turnId, stage, outcome, reason, field, detail, candidate, correctedFields, count, languageCount, language, source } = record;
  const candidateIds=record.candidateIds?.filter(id=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)).slice(0,3);
  return JSON.stringify({ at: new Date().toISOString(), turnId, stage, outcome, reason, field, detail, candidate, candidateIds, correctedFields, count, languageCount, language, source }) + '\n';
}
