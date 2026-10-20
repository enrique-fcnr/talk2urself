// The reply is read while the model writes it, so the first sentence can be voiced before the model has finished
// (with memory, the reply is followed by a summary and the facts learned, which take a few more seconds to write).

// The value of a string field in JSON that is still being written: what has arrived so far, and whether it closed.
// Works on the raw text of a JSON object whose fields come in schema order ("reply" first).
export function partialJsonString(raw: string, key: string): { value: string; closed: boolean } | null {
  const start = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw);
  if (!start) return null;
  let value = '';
  for (let i = start.index + start[0].length; i < raw.length; i++) {
    const char = raw[i];
    if (char === '"') return { value, closed: true };
    if (char !== '\\') { value += char; continue; }
    const next = raw[i + 1];
    if (next === undefined) break;
    if (next === 'u') {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      value += String.fromCharCode(parseInt(hex, 16)); i += 5; continue;
    }
    value += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[next] ?? next; i++;
  }
  return { value, closed: false };
}

// Reads the Responses API event stream. onText receives the reply so far (decoded) and whether it is complete;
// the returned value is the final response object, as the non-streaming call would have returned it.
export async function readReplyStream(response: Response, structured: boolean, onText: (text: string, done: boolean) => void): Promise<unknown> {
  if (!response.body) throw new Error('A IA não concluiu a resposta.');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', raw = '', shown = -1, final: unknown;
  const handle = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as { type?: string; delta?: unknown; response?: unknown };
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      raw += event.delta;
      const reply = structured ? partialJsonString(raw, 'reply') : { value: raw, closed: false };
      if (reply && (reply.value.length !== shown || reply.closed)) { shown = reply.value.length; onText(reply.value, reply.closed); }
    } else if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') final = event.response;
    else if (event.type === 'error') throw new Error('A IA não concluiu a resposta.');
  };
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) { const frame = pending.slice(0, match.index); pending = pending.slice(match.index + match[0].length); handle(frame); }
      if (pending.length > 2_000_000) throw new Error('A IA excedeu o limite de dados.');
    }
    if (pending.trim()) handle(pending);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!final) throw new Error('A IA não concluiu a resposta.');
  return final;
}

// Where the first spoken piece of a reply ends, once written: the end of a sentence (at least `min` characters), or,
// in a long sentence, a pause mark (comma, semicolon, colon, dash) after at least `clause` characters, so the voice
// starts sooner. With the whole reply in hand (done), the reply itself is the piece if nothing ended earlier.
export function firstSentenceEnd(text: string, done: boolean, min = 18, clause = 35): number {
  const length = (end: number) => text.slice(0, end).replace(/\[[^\]]*\]/gu, '').trim().length;
  for (const match of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s)|[,;:—–](?=\s)/gu)) {
    const end = match.index! + match[0].length, stop = /[.!?…]/u.test(match[0]);
    if (length(end) >= (stop ? min : clause)) return end;
  }
  return done ? text.length : -1;
}
