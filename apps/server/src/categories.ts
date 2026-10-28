export type Category = { key: string; label: string; description: string; color: string; embedding?: number[] };
export const initialCategories = [
  ['identity', 'Identity', 'Nome, idade, origem e momento de vida', 15],
  ['family', 'Family', 'Familiares e vínculos familiares', 30],
  ['friends', 'Friends', 'Amigos e vínculos sociais', 45],
  ['personal_life', 'Personal life', 'Relacionamentos e vida pessoal', 20],
  ['work', 'Work', 'Profissão, carreira e projetos profissionais', 240],
  ['studies', 'Studies', 'Cursos, aprendizado e educação', 225],
  ['goals', 'Goals', 'Planos e objetivos pessoais', 210],
  ['principles', 'Values', 'Princípios e valores explicitamente relatados', 280],
  ['routine', 'Routine', 'Hábitos e organização do dia a dia', 160],
  ['constraints', 'Resources and limits', 'Tempo, recursos e limitações relatadas', 180],
  ['interests', 'Interests', 'Hobbies, esportes e atividades de lazer', 115],
  ['preferences', 'Preferences', 'Gostos e preferências pessoais, como cores', 95],
  ['life_events', 'Life events', 'Acontecimentos importantes da vida', 350],
  ['difficult_experiences', 'Difficult experiences', 'Experiências difíceis explicitamente relatadas', 330],
  ['speaking_preferences', 'Conversation', 'Preferências sobre a maneira de conversar', 300],
  ['expressions', 'Expressions', 'Expressões recorrentes em várias falas', 305],
  ['reasoning_style', 'Reasoning', 'Maneira observada de avaliar decisões', 285],
  ['assistant_role', 'My role', 'O que o usuário quer que o personagem faça por ele: planejar, cobrar, ter ideias, decidir', 65],
  ['finances', 'Money', 'Situação financeira e relação com dinheiro, como o usuário relata', 135],
  ['faith', 'Faith and spirituality', 'Crenças, fé e espiritualidade, como o usuário relata', 260],
  ['health', 'Health', 'Saúde física e mental e como o usuário se cuida, como ele relata', 195],
] as const;
// The core of who the clone is: until each of these is known (or the user explicitly declined it), the clone keeps
// steering the conversation toward it, one question at a time. Any one of the listed categories covers a topic.
export const identityCore: readonly { categories: readonly string[]; topic: string }[] = [
  { categories: ['identity'], topic: 'nome, idade ou fase da vida, onde mora' },
  { categories: ['personal_life', 'family', 'friends'], topic: 'com quem divide a vida: família, relacionamento, amigos próximos' },
  { categories: ['work', 'studies'], topic: 'trabalho ou estudo' },
  { categories: ['routine'], topic: 'como é um dia comum' },
  { categories: ['interests', 'preferences'], topic: 'do que gosta, o que faz no tempo livre' },
  { categories: ['goals'], topic: 'o que quer da vida agora' },
  { categories: ['finances', 'constraints'], topic: 'relação com dinheiro e situação financeira' },
  { categories: ['faith', 'principles'], topic: 'no que acredita: fé, espiritualidade, valores' },
  { categories: ['health'], topic: 'saúde e como se cuida' },
  { categories: ['assistant_role'], topic: 'como o clone pode ajudar' },
  { categories: ['speaking_preferences'], topic: 'se prefere um clone direto ou cuidadoso' },
];
// Order in which the character discovers missing topics across visits (one per visit, after what the user brings).
// Difficult experiences and patterns that are only observed are never asked about, so they are not gaps to pursue.
export const discoveryOrder = ['identity', 'assistant_role', 'work', 'goals', 'constraints', 'routine', 'principles',
  'studies', 'interests', 'friends', 'family', 'personal_life', 'finances', 'faith', 'health', 'preferences', 'speaking_preferences'] as const;
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
