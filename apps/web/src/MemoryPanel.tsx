import { useEffect, useState } from 'react';

type Memory = { slot: string; category?: string; value: string; evidence: string; basis: string; status: 'known' | 'declined' };
type View = { enabled: boolean; summary?: string; profile?: Memory[]; gaps?: string[]; version?: number;
  categories?: { key: string; label: string; color: string }[] };
const labels: Record<string, string> = { identity:'Identidade',preferences:'Preferências', name: 'Nome', life_context: 'Momento de vida', family: 'Família', friends: 'Amigos', goals: 'Objetivos', principles: 'Princípios',
  work: 'Trabalho e carreira', studies: 'Estudos', personal_life: 'Vida pessoal', life_events: 'Acontecimentos marcantes', difficult_experiences: 'Experiências difíceis relatadas',
  routine: 'Rotina', constraints: 'Tempo e recursos', interests: 'Interesses', speaking_preferences: 'Preferências de conversa',
  expressions: 'Expressões', reasoning_style: 'Como você avalia decisões' };

export function MemoryPanel() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(''); setView(null);
    void fetch('/api/memory', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (typeof result.enabled !== 'boolean' || (result.enabled && (!Array.isArray(result.profile) || !Array.isArray(result.gaps)))) throw new Error();
      if (!controller.signal.aborted) setView(result);
    }).catch(() => { if (!controller.signal.aborted) setError('Não foi possível carregar suas memórias.'); });
    return () => controller.abort();
  }, [revision]);
  return <section aria-label="Suas memórias">
    <strong>Suas memórias</strong>
    {error ? <p role="alert">{error}</p> : !view ? <p>Carregando…</p> : !view.enabled ?
      <p>A memória duradoura ainda está pendente. Por enquanto, a conversa mantém contexto apenas enquanto esta conexão estiver aberta.</p> : <>
        {view.profile?.length ? <ul>{view.profile.map((memory) => <li key={memory.slot}>
          <strong>{view.categories?.find((category) => category.key === memory.category)?.label ?? labels[memory.slot] ?? 'Lembrança'}:</strong> {memory.status === 'declined' ? 'Informação retirada do perfil ativo.' : memory.value}
          <details><summary>De onde veio</summary><p>Você disse: “{memory.evidence}”</p>
            <p>{memory.basis === 'observed' ? 'Padrão observado em várias falas.' : 'Informação relatada por você.'}</p></details>
        </li>)}</ul> : <p>Ainda estamos começando a conhecer você.</p>}
        {view.gaps?.length ? <p>Ainda não temos relatos sobre: {view.gaps.map((slot) => labels[slot] ?? slot).join(', ')}. Não é necessário responder tudo agora.</p> : null}
        {view.summary ? <details><summary>Onde a conversa parou</summary><p>{view.summary}</p></details> : null}
        <p>Você pode corrigir uma informação na conversa. Retirar um assunto do perfil não apaga o histórico.</p>
      </>}
    <button className="guide-toggle" onClick={() => setRevision((value) => value + 1)}>Atualizar memórias</button>
  </section>;
}
