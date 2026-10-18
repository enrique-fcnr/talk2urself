import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSpeechLanguage, forLanguage, tagSlot } from './speech-language.ts';
import { memoryContextText, type MemoryContext } from './memory.ts';

test('detects the language of each utterance, keeping the previous one when unclear', () => {
  assert.equal(detectSpeechLanguage('Pô, eu não sei o que fazer com isso, tá ligado?'), 'pt');
  assert.equal(detectSpeechLanguage("I don't know, it's kinda weird, you know?"), 'en');
  assert.equal(detectSpeechLanguage('Can you help me plan my week?'), 'en');
  assert.equal(detectSpeechLanguage('Quero falar sobre o meu trabalho hoje.'), 'pt');
  assert.equal(detectSpeechLanguage('Okay.', 'en'), 'en');
  assert.equal(detectSpeechLanguage('Enrique', 'pt'), 'pt');
});

test('expressions are tagged and filtered by language; reasoning and preferences apply to both', () => {
  assert.equal(tagSlot({ slot: 'memory.you_know', category: 'expressions' }, 'en').slot, 'memory.en_you_know');
  assert.equal(tagSlot({ slot: 'memory.en_po', category: 'expressions' }, 'pt').slot, 'memory.po');
  assert.equal(tagSlot({ slot: 'memory.estrutura', category: 'reasoning_style' }, 'en').slot, 'memory.estrutura');
  assert.equal(tagSlot({ slot: 'memory.declined_expressions', category: 'expressions' }, 'en').slot, 'memory.declined_expressions');
  const facts = [{ slot: 'memory.po', category: 'expressions' }, { slot: 'memory.en_you_know', category: 'expressions' },
    { slot: 'memory.estrutura', category: 'reasoning_style' }, { slot: 'memory.nome', category: 'identity' }];
  assert.deepEqual(forLanguage(facts, 'en').map((item) => item.slot), ['memory.en_you_know', 'memory.estrutura', 'memory.nome']);
  assert.deepEqual(forLanguage(facts, 'pt').map((item) => item.slot), ['memory.po', 'memory.estrutura', 'memory.nome']);
});

test('the reply context only carries expressions of the reply language', () => {
  const fact = (slot: string, category: string, value: string) => ({ slot, category, value, evidence: value, basis: 'observed', status: 'known' as const });
  const context: MemoryContext = { summary: '', recent: [], version: 1, gaps: [], relevant: [],
    profile: [fact('memory.po', 'expressions', 'Usa pô para dar ênfase'), fact('memory.en_like', 'expressions', 'Usa like como pausa')] };
  assert.doesNotMatch(memoryContextText(context, 'en'), /Usa pô/);
  assert.match(memoryContextText(context, 'en'), /Usa like/);
  assert.doesNotMatch(memoryContextText(context, 'pt'), /Usa like/);
  assert.match(memoryContextText(context), /Usa pô.*Usa like/);
});
