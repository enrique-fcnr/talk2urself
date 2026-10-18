// Kelly answers in the language of the user's latest utterance (Portuguese or English). Speech habits are kept apart by
// language: an English pattern's slot starts with memory.en_, everything else is Portuguese, so a Portuguese slang word
// never shows up in an English reply and the other way round.
import { categoryKey } from './categories.ts';

export type SpeechLanguage = 'pt' | 'en';
export const languageNames: Record<SpeechLanguage, string> = { pt: 'português brasileiro', en: 'inglês' };

const portuguese = new Set(['de','que','não','nao','é','eu','você','voce','pra','para','com','uma','um','isso','tá','ta','né','ne','tô','mas','meu','minha',
  'muito','também','tambem','então','entao','por','mais','como','quando','ele','ela','vou','tem','foi','era','aqui','agora','sim','oi','olá','ola','obrigado','obrigada',
  'gente','cara','pô','po','tipo','assim','fazer','estou','está','esta','estava','porque','qual','quem','onde','sobre','nós','seu','sua','bem','bom','boa','da','na','os','o','e','em','se']);
const english = new Set(['the','and','is','are','was','were','i','you','to','of','it','that','this','what','with','for','my','your','have','has','do','does','did','not',
  "don't","i'm","it's","can't",'can','will','would','just','like','know','think','so','but','about','how','why','when','where','who','yeah','yes','hey','hi','hello','thanks',
  'thank','please','want','going','gonna','really','very','be','been','me','we','they','he','she','our','their','an','in','on','at','or','if','because','well','okay','ok']);

// Word-level vote: common function words of each language, plus Portuguese-only letters. Ties keep the previous language.
export function detectSpeechLanguage(text: string, previous: SpeechLanguage = 'pt'): SpeechLanguage {
  const words = text.toLocaleLowerCase('pt-BR').match(/[\p{L}']+/gu) ?? [];
  let pt = /[ãõçêâáéíóú]/.test(text.toLocaleLowerCase('pt-BR')) ? 1.5 : 0, en = 0;
  for (const word of words) { if (portuguese.has(word)) pt++; if (english.has(word)) en++; }
  if (pt === en) return previous;
  return en > pt ? 'en' : 'pt';
}

const englishPrefix = 'memory.en_';
export function slotLanguage(slot: string): SpeechLanguage { return slot.startsWith(englishPrefix) ? 'en' : 'pt'; }
// Only expressions (words, slang, phrasing) belong to a language; how the user reasons and what they asked for apply to both.
export const languageBound = (category: string | null | undefined) => !!category && categoryKey(category) === 'expressions';

// Marks a learned expression with the language it was heard in.
export function tagSlot<T extends { slot: string; category: string }>(update: T, language: SpeechLanguage): T {
  if (!languageBound(update.category) || !update.slot.startsWith('memory.') || update.slot.startsWith('memory.declined_')) return update;
  const key = update.slot.slice('memory.'.length).replace(/^en_/, '');
  return { ...update, slot: language === 'en' ? `${englishPrefix}${key}`.slice(0, 'memory.'.length + 48) : `memory.${key}` };
}

// Drops the other language's expressions from what the reply sees.
export function forLanguage<T extends { slot: string; category?: string | null }>(items: T[], language: SpeechLanguage): T[] {
  return items.filter((item) => !languageBound(item.category) || slotLanguage(item.slot) === language);
}
