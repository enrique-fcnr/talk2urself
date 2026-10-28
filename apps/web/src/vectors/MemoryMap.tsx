import { useEffect, useMemo, useState } from 'react';
import type { VectorSnapshot } from '../../../../shared/vector-memory';
import { cosineSimilarity, type Projection, type ProjectedPoint } from './projection';
import PlotlyScatterView from '../vendor/vectordbz/PlotlyScatterView';
import './map.css';

const topics: Record<string, string> = { interests: 'Interests', family: 'Family', friends: 'Friends', work: 'Work', studies: 'Studies',
  goals: 'Goals', name: 'Name', routine: 'Routine', principles: 'Principles', constraints: 'Limits', personal_life: 'Personal life',
  life_context: 'Stage of life', life_events: 'Life events', difficult_experiences: 'Reported experiences',
  expressions: 'Expressions', speaking_preferences: 'Conversation', reasoning_style: 'Reasoning' };
const topic = (slot: string) => topics[slot] ?? 'Memory';
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
        if (!data.enabled) { setSnapshot(null); setProjection({ points: [], retainedVariance: 0 }); setError('Set up the Supabase memory on the server to open the map.'); return; }
        const next = JSON.stringify(data);
        if (next !== fingerprint) { fingerprint = next; setSnapshot(data); }
        setUpdatedAt(new Date()); setError('');
      } catch { if (active) setError('Could not sync. The last map may be out of date; we will try again.'); }
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
    // Catches up with outside changes and missed events, without calling any model API.
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
      else { setError('Could not project the memories. Try refreshing.'); setProjecting(false); }
    };
    worker.onerror = () => { setError('Could not start the projection.'); setProjecting(false); };
    worker.postMessage({ items: snapshot.items });
    return () => worker.terminate();
  }, [snapshot]);

  const categories = useMemo(() => [...new Map((snapshot?.items ?? []).filter((item) => item.category)
    .map((item) => [item.category!.key, item.category!])).values()].sort((a,b) => a.label.localeCompare(b.label,'en')), [snapshot]);
  // The filter only hides points: it does not recompute the PCA or move the memories.
  const visiblePoints = useMemo(() => projection.points.filter((point) => categoryFilter === 'all' || point.document.category?.key === categoryFilter), [projection,categoryFilter]);
  const selected = visiblePoints.find((point) => point.id === selectedId) ?? null;
  const neighbors = useMemo(() => selected ? visiblePoints.filter((point) => point.id !== selected.id)
    .map((point) => ({ point, similarity: cosineSimilarity(selected.document.embedding, point.document.embedding) }))
    .sort((a, b) => b.similarity - a.similarity).slice(0, 3) : [], [visiblePoints, selected]);
  return <div className="memory-map">
    <header className="map-header"><a className="map-brand" href="/">talk<span>2</span>urself.</a>
      <a href="/" target="_blank" rel="noreferrer">Open the conversation ↗</a></header>
    <main>
      <div className="map-intro"><div><p className="map-kicker">MEMORY LAB · ADAPTED FROM VECTORDBZ</p>
        <h1>What stays from the conversation.</h1><p>Each point is a remembered fact, with its own source and its own embedding.</p></div>
        <div className="map-sync"><span className={online && !error ? 'map-live' : ''} role="status">{online && !error ? '● Live updates' : '○ Sync pending'}</span>
          <button onClick={() => setRefresh((v) => v + 1)}>Refresh now</button></div></div>
      <div className="map-stats"><span><strong>{snapshot?.items.length ?? '—'}</strong> memories shown</span><span><strong>1,536 → 3</strong> dimensions</span><span>Approximate PCA · normalised vectors</span>
        <span>{updatedAt ? `Checked at ${updatedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Querying the database…'}</span></div>
      {error ? <p className="map-error" role="alert">{error}</p> : null}
      {snapshot?.truncated ? <p>Showing the {snapshot.limit} most recent active memories. The others stay in the database.</p> : null}
      <div className="map-categories" aria-label="Memory categories">
        <button aria-pressed={categoryFilter === 'all'} onClick={() => setCategoryFilter('all')}>All · {projection.points.length}</button>
        {categories.map((category) => <button key={category.key} aria-pressed={categoryFilter === category.key} onClick={() => setCategoryFilter(category.key)}>
          <span className="map-swatch" style={{backgroundColor:category.color}} aria-hidden="true" />{category.label} · {snapshot?.items.filter((item) => item.category?.key === category.key).length}</button>)}
      </div>
      <div className="map-workspace"><section className="map-scene" aria-label="3D view">
        <div className="map-scene-label"><span>MAP OF MEANINGS</span><span>{projecting ? 'Recomputing the projection…' : 'Drag to rotate · scroll to zoom'}</span></div>
        {visiblePoints.length ? <PlotlyScatterView projectedPoints={visiblePoints} dimension={3} selectedPoint={selected} nearestNeighbors={neighbors}
          getPointColor={color} pointSize={7} onSelectPoint={(point) => setSelectedId(point.id)} theme="dark" />
          : <div className="map-empty">{loading || projecting ? 'Preparing the map…' : 'Your memories will appear here once a conversation saves them.'}</div>}
        <p className="map-legend"><span>Colour = category · one point per fact</span><span>{projection.points.length > 1 ? `${(projection.retainedVariance * 100).toFixed(1)}% of the variance preserved` : 'A single point does not show relations between memories yet.'}</span></p>
      </section><aside className="map-inspector"><p className="map-kicker">MEMORY IN FOCUS</p>
        {selected ? <><h2><span className="map-swatch" style={{backgroundColor:color(selected)}} aria-hidden="true" />{pointTopic(selected)}</h2><p className="map-value">{selected.document.value}</p><h3>What you said</h3><blockquote>{selected.document.evidence}</blockquote>
          <p>Saved on {new Date(selected.document.createdAt).toLocaleString('en-US')}.</p><h3>Most similar in this set</h3>
          {neighbors.length ? neighbors.map(({ point, similarity }) => <button className="map-neighbor" key={point.id} onClick={() => setSelectedId(point.id)}>{point.document.value}<small>Cosine similarity: {similarity.toFixed(3)}</small></button>) : <p>There is no other memory to compare yet.</p>}</>
          : <><h2>Explore your memories.</h2><p>Click a point or pick a memory from the list to read it and what you said that created it.</p></>}
      </aside></div>
      <section className="map-list" aria-label="Accessible list of memories"><h2>Memories on the map</h2>
        {visiblePoints.map((point) => <button key={point.id} aria-pressed={selectedId === point.id} onClick={() => setSelectedId(point.id)}><small><span className="map-swatch" style={{backgroundColor:color(point)}} aria-hidden="true" />{pointTopic(point)}</small>{point.document.value}</button>)}</section>
      <p className="map-note">The 3D projection is an approximation: nearby points do not guarantee the same meaning. Similarity uses the original 1,536 values. New memories may move the points; corrections replace the active version.</p>
      <p className="map-note">Categories are assigned automatically, reusing existing subjects. Colours of new categories are matched to related subjects in OKLab and kept stable. Colour does not measure the distance between two facts; use the original similarities to compare memories.</p>
    </main><footer>View adapted from the open VectorDBZ component · <a href="/vectordbz-license.txt" target="_blank" rel="noreferrer">MIT license</a> · <a href="/plotly-license.txt" target="_blank" rel="noreferrer">Plotly</a> · Reading the database creates no voice and no new embeddings.</footer>
  </div>;
}
