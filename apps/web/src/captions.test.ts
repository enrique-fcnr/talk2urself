import test from 'node:test';
import assert from 'node:assert/strict';
import { captionLines, lineAt } from './Captions.tsx';

test('legenda quebra em linhas curtas sem cortar palavras', () => {
  const lines = captionLines('Oi! Que bom te ver de novo. Como foi o seu dia hoje, conseguiu descansar?', 20);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.equal(lines.join(' '), 'Oi! Que bom te ver de novo. Como foi o seu dia hoje, conseguiu descansar?');
  assert.deepEqual(captionLines('  ', 20), []);
  assert.deepEqual(captionLines('palavragrandedemaisparaumalinha curta', 10), ['palavragrandedemaisparaumalinha', 'curta']);
});

test('a linha da legenda acompanha o andamento do áudio', () => {
  const lines = ['primeira linha', 'segunda', 'terceira linha aqui'];
  assert.equal(lineAt(lines, 0), 0);
  assert.equal(lineAt(lines, .3), 0);
  assert.equal(lineAt(lines, .45), 1);
  assert.equal(lineAt(lines, .9), 2);
  assert.equal(lineAt(lines, 1), 2);
  assert.equal(lineAt([], .5), 0);
});
