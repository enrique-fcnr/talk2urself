import { test } from 'node:test';
import assert from 'node:assert/strict';
import { looksUnfinished } from './turn-end.ts';

test('uma pausa depois de "e", "mas", "tipo" ou reticências não encerra a fala', () => {
  for (const text of ['Eu queria falar do meu trabalho e', 'Tô pensando em sair, mas', 'É que tipo...', 'Então eu acho que…', 'I was thinking about the', 'Eu fui lá e.'])
    assert.equal(looksUnfinished(text), true, text);
  for (const text of ['Tô pensando em mudar de emprego.', 'O que você acha?', 'Pô, que legal!', 'I think so.', 'Meu nome é Enrique'])
    assert.equal(looksUnfinished(text), false, text);
});
