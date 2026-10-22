import test from 'node:test';
import assert from 'node:assert/strict';
import { captionLines, cipherSchedule, lineAt } from './Captions.tsx';

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

test('a fala do clone decodifica da esquerda para a direita, em cerca de um segundo', () => {
  const schedule = cipherSchedule(34);
  assert.equal(schedule[0].start, 0);
  assert.ok(schedule.every((letter, i) => i === 0 || letter.start > schedule[i - 1].start), 'cada letra começa depois da anterior');
  assert.ok(schedule.at(-1)!.end <= 1.1 + 1e-9, 'a linha inteira trava em até 1,1 s');
  assert.ok(cipherSchedule(5).at(-1)!.end < schedule.at(-1)!.end, 'linhas curtas decodificam mais rápido');
  assert.deepEqual(cipherSchedule(1), [{ start: 0, end: .32 }]);
});
