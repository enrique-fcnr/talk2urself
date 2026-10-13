export type Category = { key: string; label: string; description: string; color: string; embedding?: number[] };
export const initialCategories = [
  ['identity', 'Identidade', 'Nome, idade, origem e momento de vida', 15],
  ['family', 'Família', 'Familiares e vínculos familiares', 30],
  ['friends', 'Amizades', 'Amigos e vínculos sociais', 45],
  ['personal_life', 'Vida pessoal', 'Relacionamentos e vida pessoal', 20],
  ['work', 'Trabalho', 'Profissão, carreira e projetos profissionais', 240],
  ['studies', 'Estudos', 'Cursos, aprendizado e educação', 225],
  ['goals', 'Objetivos', 'Planos e objetivos pessoais', 210],
  ['principles', 'Valores', 'Princípios e valores explicitamente relatados', 280],
  ['routine', 'Rotina', 'Hábitos e organização do dia a dia', 160],
  ['constraints', 'Recursos e limites', 'Tempo, recursos e limitações relatadas', 180],
  ['interests', 'Interesses', 'Hobbies, esportes e atividades de lazer', 115],
  ['preferences', 'Preferências', 'Gostos e preferências pessoais, como cores', 95],
  ['life_events', 'Acontecimentos', 'Acontecimentos importantes da vida', 350],
  ['difficult_experiences', 'Experiências difíceis', 'Experiências difíceis explicitamente relatadas', 330],
  ['speaking_preferences', 'Conversa', 'Preferências sobre a maneira de conversar', 300],
  ['expressions', 'Expressões', 'Expressões recorrentes em várias falas', 305],
  ['reasoning_style', 'Raciocínio', 'Maneira observada de avaliar decisões', 285],
] as const;
export const categoryForProfile: Record<string, string> = { name: 'identity', life_context: 'identity',
  ...Object.fromEntries(initialCategories.map(([key]) => [key, key])) };
const aliases: Record<string, string> = { estudo: 'studies', estudos: 'studies', educacao: 'studies', education: 'studies',
  trabalho: 'work', carreira: 'work', career: 'work', familia: 'family', amigos: 'friends', amizades: 'friends',
  interesses: 'interests', hobbies: 'interests', preferencias: 'preferences', objetivos: 'goals', rotina: 'routine' };
export function categoryKey(value: string): string {
  const key = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return aliases[key] ?? key;
}
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
// Interpolação em OKLab: não se faz média dos dígitos hexadecimais.
function rgb(l: number, a: number, b: number): number[] {
  const ll = (l + .3963377774 * a + .2158037573 * b) ** 3;
  const mm = (l - .1055613458 * a - .0638541728 * b) ** 3;
  const ss = (l - .0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * ll - 3.3077115913 * mm + .2309699292 * ss,
    -1.2684380046 * ll + 2.6097574011 * mm - .3413193965 * ss,
    -.0041960863 * ll - .7034186147 * mm + 1.707614701 * ss];
}
function hex(a: number, b: number): string {
  let channels = rgb(.81, a, b);
  for (let i = 0; i < 30 && channels.some((v) => v < 0 || v > 1); i++) { a *= .9; b *= .9; channels = rgb(.81, a, b); }
  return '#' + channels.map((v) => {
    const value = Math.min(1, Math.max(0, v));
    const srgb = value <= .0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - .055;
    return Math.round(srgb * 255).toString(16).padStart(2, '0');
  }).join('');
}
export function initialColor(key: string): string {
  const hue = initialCategories.find(([candidate]) => candidate === key)?.[3] ?? 270;
  return hex(.12 * Math.cos(hue * Math.PI / 180), .12 * Math.sin(hue * Math.PI / 180));
}
export function semanticColor(embedding: number[], categories: Category[]): string {
  // Âncoras fixas e gravadas: a chegada de uma categoria não muda cores anteriores.
  const anchors = initialCategories.map(([key, , , hue]) => ({ hue,
    similarity: cosine(embedding, categories.find((item) => item.key === key)?.embedding ?? []) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const weights = anchors.map((anchor) => Math.exp(12 * (anchor.similarity - anchors[0].similarity)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let a = 0, b = 0;
  anchors.forEach((anchor, i) => { a += weights[i] / total * .12 * Math.cos(anchor.hue * Math.PI / 180);
    b += weights[i] / total * .12 * Math.sin(anchor.hue * Math.PI / 180); });
  return hex(a, b);
}
