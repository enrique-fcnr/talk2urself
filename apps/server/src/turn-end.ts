// Turn ends by meaning: a pause after "e…", "mas…" or "tipo…" is the user thinking, not finishing. Such a turn is held
// for a moment so the rest can join it, instead of being answered half-said.
const connectors = new Set(['e', 'mas', 'porque', 'que', 'tipo', 'então', 'entao', 'aí', 'ai', 'ou', 'pra', 'para', 'de', 'do', 'da', 'dos', 'das',
  'com', 'quando', 'se', 'como', 'o', 'a', 'os', 'as', 'um', 'uma', 'meu', 'minha', 'no', 'na', 'em', 'por', 'pelo', 'pela', 'sobre', 'até', 'nem',
  'é', 'hum', 'hmm', 'ahn', 'eh', 'tá', 'assim',
  'and', 'but', 'because', 'or', 'like', 'the', 'a', 'an', 'to', 'of', 'with', 'when', 'if', 'that', 'my', 'for', 'about', 'um', 'uh']);

export function looksUnfinished(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A question or an exclamation is a finished turn; trailing dots, a comma or a dash are not.
  if (/[?!]["'”’)]*$/u.test(trimmed)) return false;
  if (/(\.\.\.|…|,|;|:|—|–|-)$/u.test(trimmed)) return true;
  const last = trimmed.toLocaleLowerCase('pt-BR').replace(/[.]+$/u, '').match(/[\p{L}']+$/u)?.[0];
  return !!last && connectors.has(last);
}
