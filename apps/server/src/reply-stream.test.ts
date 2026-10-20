import { test } from 'node:test';
import assert from 'node:assert/strict';
import { firstSentenceEnd, partialJsonString, readReplyStream } from './reply-stream.ts';

test('lê o campo reply de um JSON ainda incompleto, com escapes', () => {
  assert.equal(partialJsonString('{"rep', 'reply'), null);
  assert.deepEqual(partialJsonString('{"reply":"Oi, tudo b', 'reply'), { value: 'Oi, tudo b', closed: false });
  assert.deepEqual(partialJsonString('{"reply":"Ele disse \\"sim\\".\nE', 'reply'), { value: 'Ele disse "sim".\nE', closed: false });
  assert.deepEqual(partialJsonString('{"reply":"Pronto.","summary":"x', 'reply'), { value: 'Pronto.', closed: true });
  assert.deepEqual(partialJsonString('{"reply":"caf'+'\\u00e9 e p'+'\\u00', 'reply'), { value: 'café e p', closed: false });
});

test('a primeira frase termina na pontuação seguida de espaço, com um tamanho mínimo', () => {
  assert.equal(firstSentenceEnd('Oi. Tudo bem com você hoje? Sim', false), 'Oi. Tudo bem com você hoje?'.length);
  assert.equal(firstSentenceEnd('Ainda escrevendo a primeira frase', false), -1);
  assert.equal(firstSentenceEnd('Frase única sem ponto final', true), 'Frase única sem ponto final'.length);
  assert.equal(firstSentenceEnd('[concorda] Isso faz bastante sentido. E', false), '[concorda] Isso faz bastante sentido.'.length);
  // A long first sentence starts at a comma once it has some length; a short opening clause does not.
  assert.equal(firstSentenceEnd('Na real, eu não sairia ainda sem entender se o problema é o emprego, ou', false), 'Na real, eu não sairia ainda sem entender se o problema é o emprego,'.length);
});

test('o fluxo de eventos entrega o texto aos poucos e devolve a resposta final', async () => {
  const deltas = ['{"reply":"Primeira frase', ' pronta. Segunda', '.","summary":"r","updates":[]}'];
  const events = [...deltas.map((delta) => ({ type: 'response.output_text.delta', delta })), { type: 'response.completed', response: { status: 'completed', output: [] } }];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const seen: [string, boolean][] = [];
  const final = await readReplyStream(new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }), true, (text, done) => seen.push([text, done]));
  assert.deepEqual(final, { status: 'completed', output: [] });
  assert.deepEqual(seen, [['Primeira frase', false], ['Primeira frase pronta. Segunda', false], ['Primeira frase pronta. Segunda.', true]]);
});
