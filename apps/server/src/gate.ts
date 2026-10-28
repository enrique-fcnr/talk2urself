import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Private access for a hosted demo: with ACCESS_CODE set, nothing is served (page, files, API, WebSockets) until the
// browser holds the access cookie. Opening any address with ?k=<code> once sets it and reloads without the code.
// Everyone else gets a small public page. Changing the code invalidates every cookie handed out before.
export const accessCookie = 't2u_access';
const contactUrl = 'https://www.linkedin.com/in/enrique-fernandes-b21754217/';
const maxFailures = 10, failureWindowMs = 15 * 60_000;

export function readAccessCode(env: Record<string, string | undefined> = process.env) {
  const code = env.ACCESS_CODE?.trim();
  if (!code) return undefined;
  if (code.length < 24) throw new Error('ACCESS_CODE precisa de pelo menos 24 caracteres aleatórios.');
  return code;
}

const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function cookieValue(header: string | undefined) {
  for (const part of (header ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === accessCookie) return value.join('=');
  }
  return undefined;
}

export function registerGate(app: FastifyInstance, code: string) {
  // The cookie holds a token derived from the code, never the code itself.
  const token = createHmac('sha256', code).update('talk2urself-access').digest('base64url');
  const failures = new Map<string, { count: number; since: number }>();
  const blocked = (ip: string, now: number) => {
    const entry = failures.get(ip);
    return Boolean(entry && now - entry.since < failureWindowMs && entry.count >= maxFailures);
  };
  const fail = (ip: string, now: number) => {
    if (failures.size > 10_000) failures.clear();
    const entry = failures.get(ip);
    if (!entry || now - entry.since >= failureWindowMs) failures.set(ip, { count: 1, since: now });
    else entry.count++;
  };

  app.addHook('onRequest', async (request, reply) => {
    // The address never travels on to other sites, so a code in it cannot leak through a link.
    reply.header('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, 'http://local');
    const offered = url.searchParams.get('k');
    if (offered !== null) {
      const now = Date.now();
      if (blocked(request.ip, now)) return restricted(request, reply, 429);
      if (!same(offered, code)) { fail(request.ip, now); return restricted(request, reply, 403); }
      failures.delete(request.ip);
      url.searchParams.delete('k');
      const secure = request.protocol === 'https' ? '; Secure' : '';
      reply.header('Set-Cookie', `${accessCookie}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
      return reply.header('Cache-Control', 'no-store').redirect(url.pathname + url.search, 303);
    }
    const held = cookieValue(request.headers.cookie);
    if (held && same(held, token)) return;
    return restricted(request, reply, 401);
  });
}

// API, WebSockets and files get a bare refusal; any page address gets the public page.
function restricted(request: FastifyRequest, reply: FastifyReply, status: 401 | 403 | 429) {
  const route = request.url.split('?')[0];
  reply.header('Cache-Control', 'no-store');
  if (route.startsWith('/api/') || route.startsWith('/ws') || /\.[a-z0-9]+$/i.test(route)) {
    return reply.code(status).send({ error: 'Access restricted.' });
  }
  // The interface is in English, and so is the public page.
  return reply.code(status === 429 ? 429 : 200).type('text/html; charset=utf-8').send(restrictedPage(true));
}

const copy = {
  pt: { lang: 'pt-BR', tagline: 'Um clone seu, que conversa por voz e aprende quem você é.',
    body: 'O acesso ainda é restrito enquanto o projeto está em fase de demonstração.',
    invite: 'Se você é recrutador ou quer testar o app, fale comigo no LinkedIn.', action: 'Falar no LinkedIn' },
  en: { lang: 'en', tagline: 'A clone of you that talks by voice and learns who you are.',
    body: 'Access is restricted while the project is in its demo phase.',
    invite: "If you're a recruiter or would like to try the app, reach out on LinkedIn.", action: 'Message me on LinkedIn' },
};

export function restrictedPage(english: boolean) {
  const text = english ? copy.en : copy.pt;
  return `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Talk2urself</title>
<meta name="description" content="${text.tagline}">
<meta property="og:title" content="Talk2urself">
<meta property="og:description" content="${text.tagline}">
<style>
:root { --bg: #faf9f7; --ink: #302f3d; --muted: #716c80; --accent: #8724fb; --line: #e5e1ec; --panel: #fffdfb; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d0e17; --ink: #f2eff9; --muted: #b4acc4; --accent: #8724fb; --line: #363044; --panel: #1a1925; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 24px 16px; background: var(--bg); color: var(--ink);
  font-family: Inter, 'Segoe UI', system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 460px; text-align: center; }
.wordmark { font-size: 34px; letter-spacing: -1.5px; font-weight: 650; margin: 0; }
.wordmark span { color: var(--accent); }
.tagline { font-size: 18px; line-height: 1.5; margin: 14px 0 28px; }
.card { border: 1px solid var(--line); border-radius: 20px; background: var(--panel); padding: 24px 22px; }
.card p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.6; }
.card p + p { margin-top: 10px; }
a.action { display: inline-block; margin-top: 22px; padding: 12px 24px; border-radius: 40px; background: #8724fb; color: #fff;
  font-weight: 600; font-size: 15px; text-decoration: none; }
a.action:hover, a.action:focus-visible { filter: brightness(1.08); }
a.action:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
</style>
</head>
<body>
<main>
<h1 class="wordmark">talk<span>2</span>urself<span>.</span></h1>
<p class="tagline">${text.tagline}</p>
<div class="card">
<p>${text.body}</p>
<p>${text.invite}</p>
<a class="action" href="${contactUrl}" target="_blank" rel="noopener noreferrer">${text.action}</a>
</div>
</main>
</body>
</html>
`;
}
