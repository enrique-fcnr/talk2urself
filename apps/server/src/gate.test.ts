import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.ts';
import { accessCookie, readAccessCode } from './gate.ts';

const code = 'a'.repeat(16) + 'B7c9D1e3F5g7';
function webRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 't2u-web-'));
  mkdirSync(path.join(root, 'assets'));
  writeFileSync(path.join(root, 'index.html'), '<div id="root"></div>');
  writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
  return root;
}

test('readAccessCode: off when unset, refuses a short code', () => {
  assert.equal(readAccessCode({}), undefined);
  assert.equal(readAccessCode({ ACCESS_CODE: '  ' }), undefined);
  assert.throws(() => readAccessCode({ ACCESS_CODE: 'curto' }));
  assert.equal(readAccessCode({ ACCESS_CODE: ` ${code} ` }), code);
});

test('without an access code the site stays open', async () => {
  const app = await createApp({ webRoot: webRoot() });
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/')).body, '<div id="root"></div>');
  await app.close();
});

test('with an access code nothing is served without the cookie', async () => {
  const app = await createApp({ webRoot: webRoot(), accessCode: code });
  const page = await app.inject({ url: '/', headers: { 'accept-language': 'pt-BR,pt;q=0.9' } });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /acesso ainda é restrito/);
  assert.match(page.body, /linkedin\.com\/in\/enrique-fernandes/);
  assert.doesNotMatch(page.body, /id="root"/, 'the app itself is not sent');
  assert.match((await app.inject({ url: '/configuracoes', headers: { 'accept-language': 'en-US,en' } })).body, /Access is restricted/);
  for (const url of ['/api/health', '/api/memory', '/api/voice', '/api/memory/vectors', '/ws', '/ws/memories', '/assets/app.js', '/index.html']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 401, url);
    assert.deepEqual(response.json(), { error: 'Acesso restrito.' }, url);
  }
  const voice = await app.inject({ method: 'POST', url: '/api/voice/reset' });
  assert.equal(voice.statusCode, 401);
  assert.equal((await app.inject({ url: '/', headers: { cookie: `${accessCookie}=forjado` } })).statusCode, 200);
  assert.doesNotMatch((await app.inject({ url: '/', headers: { cookie: `${accessCookie}=forjado` } })).body, /id="root"/);
  await app.close();
});

test('a real WebSocket without the cookie is refused, with it the conversation opens', async () => {
  const app = await createApp({ accessCode: code });
  const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace('http:', 'ws:');
  const refused = new WebSocket(address + '/ws');
  assert.equal(await new Promise((resolve) => { refused.onopen = () => resolve('open'); refused.onerror = () => resolve('error'); }), 'error');
  const entry = await app.inject(`/?k=${code}`);
  const { WebSocket: Socket } = await import('ws');
  const allowed = new Socket(address + '/ws', { headers: { cookie: String(entry.headers['set-cookie']).split(';')[0] } });
  assert.equal(await new Promise((resolve) => { allowed.on('open', () => resolve('open')); allowed.on('error', () => resolve('error')); }), 'open');
  allowed.close();
  await app.close();
});

test('opening the site with the code sets the cookie and drops the code from the address', async () => {
  const app = await createApp({ webRoot: webRoot(), accessCode: code });
  const entry = await app.inject(`/configuracoes?k=${code}&x=1`);
  assert.equal(entry.statusCode, 303);
  assert.equal(entry.headers.location, '/configuracoes?x=1');
  assert.equal(entry.headers['referrer-policy'], 'no-referrer');
  const cookie = String(entry.headers['set-cookie']);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Max-Age=31536000/);
  assert.doesNotMatch(cookie, new RegExp(code), 'the cookie never carries the code');
  const pair = cookie.split(';')[0];
  assert.equal((await app.inject({ url: '/', headers: { cookie: `outro=1; ${pair}` } })).body, '<div id="root"></div>');
  assert.equal((await app.inject({ url: '/assets/app.js', headers: { cookie: pair } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/health', headers: { cookie: pair } })).statusCode, 200);
  // Behind HTTPS the cookie only travels over HTTPS.
  assert.match(String((await app.inject({ url: `/?k=${code}`, headers: { 'x-forwarded-proto': 'https' } })).headers['set-cookie']), /Secure/);
  await app.close();
  // A new code locks out every browser that entered with the old one.
  const renewed = await createApp({ webRoot: webRoot(), accessCode: code + 'novo' });
  assert.equal((await renewed.inject({ url: '/api/health', headers: { cookie: pair } })).statusCode, 401);
  await renewed.close();
});

test('wrong codes are refused and, after ten tries, blocked even for the right one', async () => {
  const app = await createApp({ webRoot: webRoot(), accessCode: code });
  const wrong = await app.inject('/?k=errado');
  assert.equal(wrong.statusCode, 200);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.body, /talk<span>2<\/span>urself/);
  for (let i = 0; i < 9; i++) await app.inject('/?k=errado');
  const blocked = await app.inject(`/?k=${code}`);
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.headers['set-cookie'], undefined);
  // Another address is not affected.
  assert.equal((await app.inject({ url: `/?k=${code}`, remoteAddress: '10.0.0.9' })).statusCode, 303);
  await app.close();
});
