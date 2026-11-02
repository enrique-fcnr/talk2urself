# talk2urself

**A real-time voice AI that learns who you are, remembers it and, over time, talks back in your own voice.** You speak, a 3D avatar answers out loud, and every conversation adds facts and speech patterns to a long-term memory you can see light up as a brain.

**Live:** https://talk2urself.com (private demo behind an access code) · Built by [Enrique Fernandes](https://www.linkedin.com/in/enrique-fernandes-b21754217)

## What happens in one turn

```text
mic ─► Silero VAD (browser) ─► turn-end check ─► OpenAI transcription
                                                        │
          pgvector recall (facts + speech patterns) ◄───┤
                                                        ▼
          LLM reply, streamed as structured JSON (reply → summary → facts learned)
                                                        │ first sentence ready
                                                        ▼
          Cartesia TTS (SSE), sentence by sentence ─► PCM over WebSocket ─► avatar lip-sync
                                                        │ after the reply
                                                        ▼
          validate facts against the user's words ─► embed ─► commit turn (Postgres function)
          background: speech-pattern observer · voice-clone sampling
```

## Engineering decisions

- **Speak before the answer exists.** The model writes one JSON object whose first field is the reply. The server parses the string while it streams and sends the first full sentence to TTS right away; the summary and the learned facts arrive after the user already hears the voice.
- **Barge-in that wastes at most one sentence.** The next sentence is only synthesized when the previous one starts playing. Talking over the clone (or tapping it) stops playback, and the history keeps only what was actually heard, ending in "…".
- **Turn end by meaning, not only silence.** Silero VAD runs in the browser (ONNX, ~1 ms per 32 ms frame) to separate speech from noise and breathing. A pause after "and…", "but…" or "tipo…" is treated as thinking, so the turn is held instead of answered half-said.
- **Memory the model can't make up.** Each learned fact must quote evidence that literally appears in the user's current words, or it is rejected. Facts are atomic, categorized and embedded with `text-embedding-3-small` (1536 dims); recall is a cosine-similarity search in pgvector (threshold 0.35, top 12) inside one Postgres function, and each turn is committed by another.
- **It learns how you talk.** A background observer reads only the user's lines, proposes vocabulary, slang and phrasing with verified evidence, and an expression must show up in at least three separate lines, even far apart in time, before it can be confirmed and used in replies. The reply never waits for it.
- **Your voice, per language.** With cloning on, clean takes of accepted speech are kept privately; after a few minutes the best ones (up to 60 s, single speaker) become a Cartesia instant clone, refined twice and then frozen, with the raw takes deleted. English gets its own clone so it keeps the user's real accent.
- **Lip-sync from timestamps.** English uses Cartesia's phoneme timestamps; Portuguese only gets word timestamps, so the server derives mouth shapes from each word's spelling inside its time span.
- **Memory you can see.** `/memories` projects the stored vectors to 3D (PCA in a web worker, adapted from VectorDBZ) and the brain view lights up as memories are recalled. The projection is approximate; retrieval uses the original vectors.
- **Keys never reach the browser.** OpenAI, Cartesia and Supabase are called only by the server; the page talks to it over a WebSocket. All tables have row-level security.

## Stack

TypeScript · React 19 · Vite · Three.js · Node.js (Fastify + WebSocket) · OpenAI (transcription, Responses API with strict JSON schema, embeddings) · Cartesia Sonic (TTS over SSE, instant voice cloning) · Silero VAD (onnxruntime-web) · Supabase (PostgreSQL + pgvector, Storage) · AWS Lightsail · Caddy · systemd · GitHub Actions

## Deployment

A push to `main` triggers a GitHub Actions job that SSHes into the Lightsail server with a deploy key restricted to a single command (`deploy/update.sh`): pull, build, restart the systemd service, then a health check on https://talk2urself.com. Caddy handles HTTPS. The hosted demo is closed by an access code: until the browser holds a signed access cookie, the app, files, API and WebSockets are refused and visitors see a small public page; failed attempts are rate-limited.

## Tests

128 tests with Node's built-in test runner, against a real local server with mocked providers (no credits used): turns, cancellation and barge-in, connection isolation, invalid messages, the access gate, streamed-JSON parsing, turn-end detection, speech timing and lip-sync, memory validation and recall, the language observer, voice cloning, captions and the 3D layouts.

```bash
npm run check   # TypeScript
npm test
npm run build
```

## Run locally

Requires Node.js 22.12+, an OpenAI key and a Cartesia key. Supabase is optional: without it the conversation works with no long-term memory.

```bash
npm install
cp .env.example .env   # fill in the keys; see the comments in the file
npm run dev
```

Open http://127.0.0.1:5173. The database schema is in `supabase/migrations/`.

## Structure

```text
apps/web/src/      React UI, avatar, brain view, VAD, recorder, speech player, memory map
apps/server/src/   Fastify server: turns, voice, memory, language observer, voice cloning, access gate
shared/            message protocol, lip-sync and gesture logic shared by both sides
supabase/          migrations: tables, RLS, recall and commit functions
deploy/            Caddyfile, systemd unit, setup and update scripts
docs/              design notes and development log (Portuguese)
```

## Limits

- Single-user by design: one profile per deployment (`LOCAL_USER_ID`). No accounts, no multi-tenancy.
- Barge-in without headphones on a laptop speaker is not validated yet (echo).
- Not a medical, therapeutic or mental-health tool.

## Credits

- Avatar: "Kelly" by skullvez, CC BY 4.0, adapted in Blender. Brain: by pranktoy, CC BY 4.0. License texts in `apps/web/public/avatars/`.
- Vector view adapted from [VectorDBZ](https://github.com/vectordbz/vectordbz) (MIT). Voice activity detection: Silero VAD (MIT).
