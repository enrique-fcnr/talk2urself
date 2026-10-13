import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from './app.ts';
import { parseServerEvent, type ClientCommand, type ServerEvent } from '../../../shared/protocol.ts';

class Channel {
  socket: WebSocket;
  events: ServerEvent[] = [];
  private pending: ServerEvent[] = [];
  private waiter?: (event: ServerEvent) => void;
  opened: Promise<void>;

  constructor(address: string) {
    this.socket = new WebSocket(address.replace('http:', 'ws:') + '/ws');
    this.opened = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve(), { once: true });
      this.socket.addEventListener('error', () => reject(new Error('Falha ao conectar o teste.')), { once: true });
    });
    this.socket.addEventListener('message', (message) => {
      const event = parseServerEvent(String(message.data));
      assert.ok(event, 'O servidor deve enviar mensagens válidas.');
      this.events.push(event);
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter(event);
      } else this.pending.push(event);
    });
  }
  async next(): Promise<ServerEvent> {
    const pending = this.pending.shift();
    if (pending) return pending;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error('O servidor não respondeu dentro do tempo esperado.'));
      }, 5000);
      this.waiter = (event) => { clearTimeout(timeout); resolve(event); };
    });
  }
  command(command: ClientCommand) {
    this.socket.send(JSON.stringify({ type: 'command', command }));
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.addEventListener('close', () => resolve(), { once: true });
      this.socket.close();
    });
  }
}

test('a conexão percorre os turnos e impede outra pergunta durante a resposta', async (t) => {
  const app = await createApp();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened;
  assert.deepEqual(await channel.next(), { type: 'state', state: 'idle', text: '' });
  channel.command('start');
  assert.deepEqual(await channel.next(), { type: 'state', state: 'listening', text: '' });
  channel.command('submit-demo');
  assert.deepEqual(await channel.next(), { type: 'state', state: 'thinking', text: '' });
  channel.command('submit-demo');
  assert.equal((await channel.next()).type, 'error');
  const answer = await channel.next();
  assert.equal(answer.type, 'state');
  if (answer.type === 'state') {
    assert.equal(answer.state, 'speaking');
    assert.ok(answer.text.length > 0);
  }
  assert.deepEqual(await channel.next(), { type: 'state', state: 'listening', text: '' });
});

test('repouso cancela a resposta pendente e outra conexão mantém seu próprio estado', async (t) => {
  const app = await createApp();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const first = new Channel(address);
  const second = new Channel(address);
  t.after(async () => { await Promise.all([first.close(), second.close()]); await app.close(); });
  await Promise.all([first.opened, second.opened]);
  await first.next();
  assert.deepEqual(await second.next(), { type: 'state', state: 'idle', text: '' });
  first.command('start');
  await first.next();
  first.command('submit-demo');
  await first.next();
  first.command('reset');
  assert.deepEqual(await first.next(), { type: 'state', state: 'idle', text: '' });
  const count = first.events.length;
  await delay(1100);
  assert.equal(first.events.length, count, 'Uma resposta cancelada não deve reaparecer.');
  assert.equal(second.events.length, 1, 'Uma conexão não deve alterar outra.');
});

test('mensagens inválidas preservam a conexão e origens externas são rejeitadas', async (t) => {
  const app = await createApp();
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const channel = new Channel(address);
  t.after(async () => { await channel.close(); await app.close(); });
  await channel.opened;
  await channel.next();
  for (const payload of ['not-json', 'null', '{"type":"command","command":"unknown"}']) {
    channel.socket.send(payload);
    assert.equal((await channel.next()).type, 'error');
  }
  channel.command('start');
  assert.deepEqual(await channel.next(), { type: 'state', state: 'listening', text: '' });
  const health = await app.inject('/api/health');
  assert.deepEqual(health.json(), { ok: true, mode: 'demo', model: null });
  const rejected = await app.inject({ method: 'GET', url: '/ws', headers: { origin: 'https://untrusted.example' } });
  assert.equal(rejected.statusCode, 403);
});
