import { useEffect, useMemo, useState } from 'react';
import type { VectorSnapshot } from '../../../../shared/vector-memory';
import { cosineSimilarity, type Projection, type ProjectedPoint } from './projection';
import PlotlyScatterView from '../vendor/vectordbz/PlotlyScatterView';
import './map.css';

const topics: Record<string, string> = { interests: 'Interesses', family: 'Família', friends: 'Amigos', work: 'Trabalho', studies: 'Estudos',
  goals: 'Objetivos', name: 'Nome', routine: 'Rotina', principles: 'Princípios', constraints: 'Limites', personal_life: 'Vida pessoal',
  life_context: 'Momento de vida', life_events: 'Acontecimentos', difficult_experiences: 'Experiências relatadas',
  expressions: 'Expressões', speaking_preferences: 'Conversa', reasoning_style: 'Raciocínio' };
const topic = (slot: string) => topics[slot] ?? 'Lembrança';
const color = (point: ProjectedPoint) => point.document.category?.color ?? '#a68ae8';
const pointTopic = (point: ProjectedPoint) => point.document.category?.label ?? topic(point.document.slot);

export default function MemoryMap() {
  const [snapshot, setSnapshot] = useState<VectorSnapshot | null>(null);
  const [projection, setProjection] = useState<Projection>({ points: [], retainedVariance: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [projecting, setProjecting] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState('all');

  useEffect(() => {
    let active = true, pending = false, again = false;
    let socket: WebSocket | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let fingerprint = '';
    async function load() {
      if (!active) return;
      if (pending) { again = true; return; }
      pending = true;
      controller = new AbortController();
      try {
        const response = await fetch('/api/memory/vectors', { cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) });
        if (!response.ok) throw new Error();
        const data: VectorSnapshot & { enabled: boolean } = await response.json();
        if (!active) return;
        if (!data.enabled) { setSnapshot(null); setProjection({ points: [], retainedVariance: 0 }); setError('Configure a memória do Supabase no servidor para abrir o mapa.'); return; }
        const next = JSON.stringify(data);
        if (next !== fingerprint) { fingerprint = next; setSnapshot(data); }
        setUpdatedAt(new Date()); setError('');
      } catch { if (active) setError('Não foi possível sincronizar. O último mapa pode estar desatualizado; vamos tentar novamente.'); }
      finally { pending = false; if (active) { setLoading(false); if (again) { again = false; void load(); } } }
    }
    function connect() {
      if (!active) return;
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/memories`);
      socket.onopen = () => { if (active) { setOnline(true); void load(); } };
      socket.onmessage = (event) => { if (event.data === '{"type":"memory-sync"}') void load(); };
      socket.onclose = () => { if (active) { setOnline(false); reconnect = setTimeout(connect, 1500); } };
      socket.onerror = () => socket?.close();
    }
    connect(); void load();
    // Reconcilia mudanças externas e eventos perdidos, sem chamar APIs de modelos.
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    const visible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { active = false; controller?.abort(); clearInterval(interval); clearTimeout(reconnect); socket?.close(); document.removeEventListener('visibilitychange', visible); };
  }, [refresh]);

  useEffect(() => {
    if (!snapshot) return;
    setProjecting(true);
    const worker = new Worker(new URL('./projection.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ projection?: Projection; error?: string }>) => {
      if (event.data.projection) { setProjection(event.data.projection); setProjecting(false); }
      else { setError('Não foi possível projetar as memórias. Tente atualizar.'); setProjecting(false); }
    };
    worker.onerror = () => { setError('Não foi possível iniciar a projeção.'); setProjecting(false); };
    worker.postMessage({ items: snapshot.items });
    return () => worker.terminate();
  }, [snapshot]);

  const categories = useMemo(() => [...new Map((snapshot?.items ?? []).filter((item) => item.category)
    .map((item) => [item.category!.key, item.category!])).values()].sort((a,b) => a.label.localeCompare(b.label,'pt-BR')), [snapshot]);
  // Filtro só oculta pontos: não recalcula PCA nem muda a posição das memórias.
  const visiblePoints = useMemo(() => projection.points.filter((point) => categoryFilter === 'all' || point.document.category?.key === categoryFilter), [projection,categoryFilter]);
  const selected = visiblePoints.find((point) => point.id === selectedId) ?? null;
  const neighbors = useMemo(() => selected ? visiblePoints.filter((point) => point.id !== selected.id)
    .map((point) => ({ point, similarity: cosineSimilarity(selected.document.embedding, point.document.embedding) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, 3) : [], [visiblePoints, selected]);
  return <div className="memory-map">
    <header className="map-header"><a className="map-brand" href="/">talk<span>2</span>urself.</a>
      <a href="/" target="_blank" rel="noreferrer">Abrir conversa ↗</a></header>
    <main>
      <div className="map-intro"><div><p className="map-kicker">LABORATÓRIO DE MEMÓRIA · VECTORDBZ ADAPTADO</p>
        <h1>O que fica da conversa.</h1><p>Cada ponto é um fato lembrado, com sua própria origem e seu embedding.</p></div>
        <div className="map-sync"><span className={online && !error ? 'map-live' : ''} role="status">{online && !error ? '● Atualização ao vivo' : '○ Sincronização pendente'}</span>
          <button onClick={() => setRefresh((v) => v + 1)}>Atualizar agora</button></div></div>
      <div className="map-stats"><span><strong>{snapshot?.items.length ?? '—'}</strong> memórias exibidas</span><span><strong>1.536 → 3</strong> dimensões</span><span>PCA aproximada · vetores normalizados</span>
        <span>{updatedAt ? `Consultado às ${updatedAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Consultando banco…'}</span></div>
      {error ? <p className="map-error" role="alert">{error}</p> : null}
      {snapshot?.truncated ? <p>Exibindo as {snapshot.limit} memórias ativas mais recentes. As demais continuam no banco.</p> : null}
      <div className="map-categories" aria-label="Categorias de memórias">
        <button aria-pressed={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>Todas · {projection.points.length}</button>
        {categories.map((category) => <button key={category.key} aria-pressed={categoryFilter === category.key} onClick={() => setCategoryFilter(category.key)}>
          <span className="map-swatch" style={{backgroundColor:category.color}} aria-hidden="true" />{category.label} · {snapshot?.items.filter((item) => item.category?.key === category.key).length}</button>)}
      </div>
      <div className="map-workspace"><section className="map-scene" aria-label="Visualização 3D">
        <div className="map-scene-label"><span>MAPA DE SIGNIFICADOS</span><span>{projecting ? 'Recalculando projeção…' : 'Arraste para girar · role para ampliar'}</span></div>
        {visiblePoints.length ? <PlotlyScatterView projectedPoints={visiblePoints} dimension={3} selectedPoint={selected} nearestNeighbors={neighbors}
          getPointColor={color} pointSize={7} onSelectPoint={(point) => setSelectedId(point.id)} theme="dark" />
          : <div className="map-empty">{loading || projecting ? 'Preparando mapa…' : 'Suas memórias aparecerão aqui depois de serem salvas numa conversa.'}</div>}
        <p className="map-legend"><span>Cor = categoria · um ponto por fato</span><span>{projection.points.length > 1 ? `${(projection.retainedVariance * 100).toFixed(1)}% da variância preservada` : 'Um ponto ainda não revela relações entre memórias.'}</span></p>
      </section><aside className="map-inspector"><p className="map-kicker">MEMÓRIA EM FOCO</p>
        {selected ? <><h2><span className="map-swatch" style={{backgroundColor:color(selected)}} aria-hidden="true" />{pointTopic(selected)}</h2><p className="map-value">{selected.document.value}</p><h3>Sua fala de origem</h3><blockquote>{selected.document.evidence}</blockquote>
          <p>Salva em {new Date(selected.document.createdAt).toLocaleString('pt-BR')}.</p><h3>Mais similares neste conjunto</h3>
          {neighbors.length ? neighbors.map(({ point, similarity }) => <button className="map-neighbor" key={point.id} onClick={() => setSelectedId(point.id)}>{point.document.value}<small>Similaridade cosseno: {similarity.toFixed(3)}</small></button>) : <p>Ainda não há outra memória para comparar.</p>}</>
          : <><h2>Explore suas lembranças.</h2><p>Clique num ponto ou escolha uma memória na lista para ler o texto e a fala que a originou.</p></>}
      </aside></div>
      <section className="map-list" aria-label="Lista acessível de memórias"><h2>Memórias no mapa</h2>
        {visiblePoints.map((point) => <button key={point.id} aria-pressed={selectedId === point.id} onClick={() => setSelectedId(point.id)}><small><span className="map-swatch" style={{backgroundColor:color(point)}} aria-hidden="true" />{pointTopic(point)}</small>{point.document.value}</button>)}</section>
      <p className="map-note">A projeção 3D é uma aproximação: pontos próximos não garantem equivalência de significado. A similaridade usa os 1.536 valores originais. Novas memórias podem mudar a posição dos pontos; correções substituem a versão ativa.</p>
      <p className="map-note">Categorias são classificadas automaticamente, reaproveitando assuntos existentes. Cores de novas categorias são aproximadas a assuntos relacionados em OKLab e mantidas estáveis. A cor não mede a distância entre dois fatos; use as similaridades originais para comparar memórias.</p>
    </main><footer>Visualização adaptada do componente aberto do VectorDBZ · <a href="/vectordbz-license.txt" target="_blank" rel="noreferrer">Licença MIT</a> · <a href="/plotly-license.txt" target="_blank" rel="noreferrer">Plotly</a> · Leituras do banco não geram voz nem novos embeddings.</footer>
  </div>;
}
