import test from 'node:test';
import assert from 'node:assert/strict';
import { extractGestures, parseGestureCues } from './gestures.ts';
import { parseServerEvent } from './protocol.ts';

test('marcas de gesto saem da fala e viram posições proporcionais', () => {
  const { text, gestures } = extractGestures('[inclina] Talvez. Depende do que você quer, [ombros] mas [concorda] faz sentido.');
  assert.equal(text, 'Talvez. Depende do que você quer, mas faz sentido.');
  assert.deepEqual(gestures.map((cue) => cue.gesture), ['tilt', 'shrug']);
  assert.equal(gestures[0].at, 0);
  assert.equal(text.slice(Math.round(gestures[1].at * text.length)), 'mas faz sentido.');
});

test('marcas desconhecidas são removidas sem deixar espaços sobrando', () => {
  assert.deepEqual(extractGestures('Isso mesmo [risos].'), { text: 'Isso mesmo.', gestures: [] });
  assert.deepEqual(extractGestures('Sim[concorda]claro'), { text: 'Sim claro', gestures: [{ gesture: 'nod', at: 4 / 9 }] });
  assert.deepEqual(extractGestures('Sem gestos aqui.'), { text: 'Sem gestos aqui.', gestures: [] });
});

test('o protocolo aceita só gestos conhecidos dentro da fala', () => {
  const event = (gestures: unknown) => parseServerEvent(JSON.stringify({ type: 'audio-output', mime: 'audio/wav', gestures }));
  assert.deepEqual(event([{ gesture: 'nod', at: 0.5 }]), { type: 'audio-output', mime: 'audio/wav', gestures: [{ gesture: 'nod', at: 0.5 }] });
  assert.equal(event([{ gesture: 'dance', at: 0.5 }]), null);
  assert.equal(event([{ gesture: 'nod', at: 2 }]), null);
  assert.equal(parseGestureCues([{ gesture: 'nod', at: 0 }, { gesture: 'nod', at: 0.5 }, { gesture: 'nod', at: 1 }]), null);
});
