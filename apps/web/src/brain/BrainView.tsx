import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createHoloBrain, loadBrainShape, memoryVolume, type HoloBrain } from './holo';
import { recallKey, type BrainLayout, type BrainPoint, type Recall } from './layout';
import type { VectorSnapshot } from '../../../../shared/vector-memory';
import './brain.css';

type Status = 'loading' | 'ready' | 'disabled' | 'error';
type Focus = { point: BrainPoint; pinned: boolean };
// Scene scale: the avatar's brain is ~.6 world units wide; here it fills the view.
// The brain rises out of Kelly's head (the page animates the canvas from her brain to the centre); the camera only
// settles a little closer meanwhile.
const size = .82, cameraRest = 3.3, cameraStart = 3.9, introSeconds = 1.2, closeSeconds = .6;
// Seconds a new memory takes to fly to its place, and between memories when several arrive together.
const flySeconds = 1.6, flyStagger = .09, moveSeconds = 1.2;
const seenKey = 'talk2urself-brain-seen';
const fallbackColor = '#b58cff';
const ease = (t: number) => t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3);
function readSeen(): Set<string> | null {
  try { const raw = localStorage.getItem(seenKey); return raw ? new Set(JSON.parse(raw) as string[]) : null; } catch { return null; }
}
function writeSeen(ids: string[]) { try { localStorage.setItem(seenKey, JSON.stringify(ids)); } catch { /* Fly-ins simply repeat without storage. */ } }
const label = (point: BrainPoint) => point.memory.category?.label ?? 'Lembrança';
const color = (point: BrainPoint) => point.memory.category?.color ?? fallbackColor;

// Warm up the shape so the first opening is instant.
export function preloadBrain() { void loadBrainShape().catch(() => { /* Retried when the view opens. */ }); }

// The violet brain, opened up: every saved memory is a point of light inside it, memories on the same subject share
// a region, related ones are joined by faint synapses, and the ones used for the latest answer pulse.
// onLeave fires as closing starts, so the brain can begin returning into Kelly's head while the hologram shrinks.
export default function BrainView({ origin, recall, onClose, onLeave }: { origin: { x: number; y: number }; recall: Recall | null; onClose: () => void; onLeave?: () => void }) {
  const host = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [layout, setLayout] = useState<BrainLayout | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [closing, setClosing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  // The scene reads these through refs so React re-renders never rebuild it.
  const api = useRef<{ setLayout(layout: BrainLayout): void; setRecall(recall: Recall | null): void; select(id: string | null): void; leave(): void } | null>(null);
  const focusRef = useRef<Focus | null>(null); focusRef.current = focus;
  const recallRef = useRef(recall); recallRef.current = recall;
  const closeRef = useRef<() => void>(() => {});

  function close() {
    if (closing) return;
    setClosing(true); api.current?.leave(); onLeave?.();
    setTimeout(onClose, closeSeconds * 1000);
  }
  closeRef.current = close;
  useEffect(() => {
    closeButton.current?.focus();
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { if (focusRef.current?.pinned) setFocus(null); else close(); } };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  });

  // Memories: loaded on open, and again whenever the server announces a change while the brain is open.
  useEffect(() => {
    let active = true, socket: WebSocket | undefined, worker: Worker | undefined, reconnect: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch('/api/memory/vectors', { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error();
        const data: VectorSnapshot & { enabled: boolean } = await response.json();
        if (!active) return;
        if (!data.enabled) { setStatus('disabled'); return; }
        worker?.terminate();
        worker = new Worker(new URL('./brain.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<{ layout?: BrainLayout }>) => {
          if (!active) return;
          if (event.data.layout) { setLayout(event.data.layout); setStatus('ready'); } else setStatus('error');
        };
        worker.onerror = () => { if (active) setStatus('error'); };
        worker.postMessage({ items: data.items });
      } catch { if (active) setStatus((current) => current === 'ready' ? current : 'error'); }
    }
    function connect() {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/memories`);
      socket.onmessage = (event) => { if (event.data === '{"type":"memory-sync"}') void load(); };
      socket.onclose = () => { if (active) reconnect = setTimeout(connect, 2000); };
      socket.onerror = () => socket?.close();
    }
    void load(); connect();
    return () => { active = false; worker?.terminate(); clearTimeout(reconnect); socket?.close(); };
  }, [refresh]);

  useEffect(() => { if (layout) api.current?.setLayout(layout); }, [layout]);
  useEffect(() => { api.current?.setRecall(recall); }, [recall]);
  useEffect(() => { api.current?.select(focus?.pinned ? focus.point.id : null); }, [focus]);

  // The scene.
  useEffect(() => {
    const element = host.current!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    const pixelRatio = Math.min(2, devicePixelRatio || 1);
    renderer.setPixelRatio(pixelRatio); element.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, .05, 50);
    // A three-quarter view from slightly above: the brain reads as a brain, not an egg.
    camera.position.set(2.1, .9, 2.3).setLength(reduced ? cameraRest : cameraStart);
    const controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: .08, enablePan: false, minDistance: 1.6, maxDistance: 6, autoRotate: !reduced, autoRotateSpeed: .55, rotateSpeed: .6, zoomSpeed: .7 });
    // The hologram arrives once its shape has loaded; memories and dust are placed in the same units meanwhile.
    let holo: HoloBrain | undefined, disposed = false;
    void loadBrainShape().then((geometry) => {
      if (disposed) return;
      holo = createHoloBrain(geometry); holo.group.scale.setScalar(size); scene.add(holo.group);
    }).catch(() => { /* Memories still show without the outline. */ });
    const inVolume = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).multiply(memoryVolume.radii).add(memoryVolume.centre).multiplyScalar(size);
    // Dust: faint motes drifting inside, so even an empty brain feels alive.
    const dustCount = 260, dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i++) {
      let v: THREE.Vector3;
      do v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1); while (v.length() > .92);
      dustPositions.set(inVolume(v.x, v.y, v.z).toArray(), i * 3);
    }
    const dustGeometry = new THREE.BufferGeometry(); dustGeometry.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
    const dustMaterial = new THREE.PointsMaterial({ color: 0xcdb6ff, size: .012, transparent: true, opacity: .35, depthWrite: false, blending: THREE.AdditiveBlending });
    const dust = new THREE.Points(dustGeometry, dustMaterial); scene.add(dust);

    // Memories: soft round sprites; `glow` brightens and enlarges a point (new, recalled, hovered).
    const pointMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uPixelRatio: { value: pixelRatio }, uFade: { value: 0 } },
      vertexShader: `attribute vec3 color; attribute float glow; varying vec3 vColor; varying float vGlow; uniform float uPixelRatio;
        void main(){ vColor=color; vGlow=glow; vec4 mv=modelViewMatrix*vec4(position,1.);
          if(glow<0.){ gl_Position=vec4(2.,2.,2.,1.); gl_PointSize=0.; return; }
          gl_PointSize=(22.+20.*glow)*uPixelRatio*(${cameraRest.toFixed(1)}/-mv.z); gl_Position=projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vColor; varying float vGlow; uniform float uFade;
        void main(){ float d=length(gl_PointCoord-.5)*2.; if(d>1.) discard;
          float core=smoothstep(.3,.0,d), halo=exp(-d*d*5.)*(.55+.8*vGlow);
          gl_FragColor=vec4(mix(vColor,vec3(1.),core*.65+vGlow*.3)*(core+halo)*uFade,1.); }`,
    });
    let pointGeometry = new THREE.BufferGeometry(), lineGeometry = new THREE.BufferGeometry();
    const points = new THREE.Points(pointGeometry, pointMaterial); scene.add(points);
    const lineMaterial = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const lines = new THREE.LineSegments(lineGeometry, lineMaterial); scene.add(lines);

    // Per point: where it flies from and to, when that move started and how long it takes, plus its glow channels.
    type Live = { point: BrainPoint; from: THREE.Vector3; to: THREE.Vector3; now: THREE.Vector3; start: number; duration: number; flash: number; recalled: boolean; color: THREE.Color };
    let live: Live[] = [], synapses: BrainLayout['synapses'] = [], selected: string | null = null, hovered: string | null = null;
    let recallBurst = 0, seconds = 0, lastFrame = performance.now(), leaving = -1, frame = 0, firstLayout = true;
    const toScene = (p: [number, number, number]) => inVolume(p[0], p[1], p[2]);
    function markRecall(recall: Recall | null) { for (const item of live) item.recalled = !!recall?.keys.has(recallKey(item.point.memory.slot, item.point.memory.value)); }
    function setLayout(next: BrainLayout) {
      const previous = new Map(live.map((item) => [item.point.id, item]));
      const seen = readSeen(), everSeen = new Set(seen ?? []);
      let arrivals = 0;
      live = next.points.map((point) => {
        const to = toScene(point.position), old = previous.get(point.id);
        const isNew = !old && (!firstLayout || !everSeen.has(point.id));
        const from = old ? old.now.clone() : isNew && !reduced
          ? to.clone().add(new THREE.Vector3((Math.random() - .5) * 1.5, 2.4 + Math.random(), (Math.random() - .5) * 1.5)) : to.clone();
        const delay = isNew ? arrivals++ * flyStagger : 0;
        return { point, from, to, now: from.clone(), start: seconds + delay, duration: reduced ? 0 : isNew ? flySeconds : old ? moveSeconds : 0,
          flash: isNew ? 1 : old?.flash ?? 0, recalled: false, color: new THREE.Color(color(point)) };
      });
      // Opening the brain for the first time in this browser: every memory flies in once, quickly.
      if (firstLayout && seen === null) live.forEach((item, i) => { item.start = seconds + .5 + Math.min(i * .035, 2); item.duration = reduced ? 0 : flySeconds; item.flash = 1; });
      firstLayout = false;
      synapses = next.synapses;
      markRecall(recallRef.current);
      writeSeen(live.map((item) => item.point.id));
      pointGeometry.dispose(); lineGeometry.dispose();
      pointGeometry = new THREE.BufferGeometry();
      pointGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(live.length * 3), 3));
      pointGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(live.flatMap((item) => item.color.toArray())), 3));
      pointGeometry.setAttribute('glow', new THREE.BufferAttribute(new Float32Array(live.length), 1));
      // Points move every frame; a generous fixed bound keeps picking and culling correct.
      pointGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);
      points.geometry = pointGeometry;
      lineGeometry = new THREE.BufferGeometry();
      lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(synapses.length * 6), 3));
      lineGeometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(synapses.length * 6), 3));
      lineGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 20);
      lines.geometry = lineGeometry;
    }
    api.current = {
      setLayout,
      setRecall(recall) { markRecall(recall); if (recall && Date.now() - recall.at < 30_000) recallBurst = 1; },
      // A pinned memory holds the brain still, so its card stays put while it is read.
      select(id) { selected = id; controls.autoRotate = !reduced && !id && leaving < 0; },
      leave() { leaving = seconds; controls.autoRotate = false; },
    };

    if (import.meta.env.DEV) Object.assign(window, { brainRecall: (count = 3) => { const recall = { keys: new Set(live.slice(0, count).map((item) => recallKey(item.point.memory.slot, item.point.memory.value))), at: Date.now() }; markRecall(recall); recallBurst = 1; },
      brainDebug: () => ({ seconds, points: live.length, synapses: synapses.length, sample: live.slice(0, 3).map((item) => ({ now: item.now.toArray(), start: item.start, duration: item.duration })),
      glow: Array.from((points.geometry.attributes.glow?.array ?? []) as Float32Array).slice(0, 5), camera: camera.position.toArray(),
      screen: live.map((item) => { const p = item.now.clone().project(camera), r = renderer.domElement.getBoundingClientRect(); return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height]; }) }) });
    // Hover and tap: the nearest point under the pointer.
    const ray = new THREE.Raycaster(); ray.params.Points = { threshold: .07 };
    let downAt: { x: number; y: number } | null = null;
    function pick(event: PointerEvent): Live | null {
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), camera);
      const glow = points.geometry.attributes.glow as THREE.BufferAttribute | undefined;
      const hit = ray.intersectObject(points).find((candidate) => candidate.index !== undefined && (glow?.getX(candidate.index) ?? 0) >= 0);
      return hit ? live[hit.index!] ?? null : null;
    }
    const onMove = (event: PointerEvent) => {
      if (downAt || event.pointerType === 'touch') return;
      const item = pick(event); hovered = item?.point.id ?? null;
      renderer.domElement.style.cursor = item ? 'pointer' : 'grab';
      if (!focusRef.current?.pinned) setFocus(item ? { point: item.point, pinned: false } : null);
    };
    const onDown = (event: PointerEvent) => { downAt = { x: event.clientX, y: event.clientY }; };
    const onUp = (event: PointerEvent) => {
      const moved = downAt ? Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) : 99; downAt = null;
      if (moved > 6) return;
      const item = pick(event);
      if (item) { setFocus({ point: item.point, pinned: true }); return; }
      // A tap on the brain itself only lets go of the card; a tap beside it sends the brain back into her head.
      if (focusRef.current?.pinned) { setFocus(null); return; }
      const shell = holo?.group.children[0];
      if (!shell || !ray.intersectObject(shell).length) closeRef.current();
    };
    const onLeave = () => { hovered = null; if (!focusRef.current?.pinned) setFocus(null); };
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    function resize() {
      const { clientWidth: width, clientHeight: height } = element;
      renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height);
      // Narrow screens: step back so the whole brain fits across.
      camera.fov = camera.aspect < .8 ? 38 / Math.max(.55, camera.aspect / .8) : 38; camera.updateProjectionMatrix();
    }
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const cardPosition = new THREE.Vector3();
    function draw(time: number) {
      frame = requestAnimationFrame(draw);
      const dt = Math.min((time - lastFrame) / 1000, .05); lastFrame = time; seconds += dt;
      // Arrival: glide in from far away while the page opens around the brain; leaving reverses it.
      const intro = ease(seconds / introSeconds), outro = leaving < 0 ? 0 : ease((seconds - leaving) / closeSeconds);
      const fade = Math.min(1, seconds / .5) * (1 - outro);
      holo?.set({ fade, level: 1 }); holo?.update(seconds); pointMaterial.uniforms.uFade.value = fade;
      dustMaterial.opacity = .35 * fade; dust.rotation.y = seconds * .02;
      if (!reduced && seconds < introSeconds + .05) camera.position.setLength(cameraStart + (cameraRest - cameraStart) * intro);
      if (outro > 0) camera.position.setLength(cameraRest + (cameraStart - cameraRest) * outro * .4);
      controls.update();
      recallBurst = Math.max(0, recallBurst - dt / 2.4);
      if (live.length) {
        const position = pointGeometry.attributes.position as THREE.BufferAttribute, glow = pointGeometry.attributes.glow as THREE.BufferAttribute;
        live.forEach((item, i) => {
          const t = item.duration ? ease((seconds - item.start) / item.duration) : 1;
          item.now.lerpVectors(item.from, item.to, t);
          if (t >= 1) item.flash = Math.max(0, item.flash - dt / 1.8);
          const recalledGlow = item.recalled ? .35 + .3 * Math.pow(Math.max(0, Math.sin(seconds * 3)), 4) + recallBurst * Math.abs(Math.sin(seconds * 9)) : 0;
          position.setXYZ(i, item.now.x, item.now.y, item.now.z);
          // Not yet launched: hidden until its turn to fly in.
          const waiting = seconds < item.start && item.duration > 0 && !item.from.equals(item.to);
          glow.setX(i, waiting ? -1 : Math.min(1.6, item.flash * 1.2 + recalledGlow + (item.point.id === selected ? .9 : item.point.id === hovered ? .5 : 0)));
        });
        position.needsUpdate = glow.needsUpdate = true;
        const linePosition = lineGeometry.attributes.position as THREE.BufferAttribute, lineColor = lineGeometry.attributes.color as THREE.BufferAttribute;
        synapses.forEach(([a, b, similarity], i) => {
          const pa = live[a], pb = live[b];
          if (!pa || !pb) return;
          linePosition.setXYZ(i * 2, pa.now.x, pa.now.y, pa.now.z); linePosition.setXYZ(i * 2 + 1, pb.now.x, pb.now.y, pb.now.z);
          const lit = pa.recalled || pb.recalled || [pa.point.id, pb.point.id].includes(selected ?? '') ? 2.6 : 1;
          const settled = Math.min(glow.getX(a) < 0 ? 0 : 1, glow.getX(b) < 0 ? 0 : 1);
          const strength = (.07 + .25 * (similarity - .3) / .7) * lit * settled * fade;
          for (const [k, item] of [[i * 2, pa], [i * 2 + 1, pb]] as const) lineColor.setXYZ(k, item.color.r * strength, item.color.g * strength, item.color.b * strength);
        });
        linePosition.needsUpdate = lineColor.needsUpdate = true;
      }
      // Keep the memory card next to its point as the brain turns.
      const focused = focusRef.current && live.find((item) => item.point.id === focusRef.current!.point.id);
      if (focused && card.current) {
        cardPosition.copy(focused.now).project(camera);
        // Above the point when there is room under the title, otherwise below it; never past the screen edges.
        const rect = element.getBoundingClientRect(), width = card.current.offsetWidth, height = card.current.offsetHeight;
        const x = (cardPosition.x + 1) / 2 * rect.width, y = (1 - cardPosition.y) / 2 * rect.height;
        const left = Math.min(Math.max(x - width / 2, 12), rect.width - width - 12), above = y - height - 18;
        card.current.style.setProperty('--x', `${left}px`);
        card.current.style.setProperty('--y', `${above >= 80 ? above : Math.min(y + 18, rect.height - height - 12)}px`);
      }
      renderer.render(scene, camera);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); api.current = null;
      renderer.domElement.removeEventListener('pointermove', onMove); renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp); renderer.domElement.removeEventListener('pointerleave', onLeave);
      disposed = true; holo?.dispose(); dustGeometry.dispose(); dustMaterial.dispose();
      pointGeometry.dispose(); pointMaterial.dispose(); lineGeometry.dispose(); lineMaterial.dispose();
      renderer.dispose(); renderer.domElement.remove();
    };
  }, []);

  const subjects = useMemo(() => {
    const groups = new Map<string, { label: string; color: string; count: number }>();
    for (const point of layout?.points ?? []) {
      const key = point.memory.category?.key ?? point.memory.slot, group = groups.get(key);
      if (group) group.count++; else groups.set(key, { label: label(point), color: color(point), count: 1 });
    }
    return [...groups.values()].sort((a, b) => b.count - a.count);
  }, [layout]);
  const count = layout?.points.length ?? 0;
  const recalled = (point: BrainPoint) => !!recall?.keys.has(recallKey(point.memory.slot, point.memory.value));
  // Portalled to the body: the page's stage isolates its own layers, and the brain must cover the header too.
  return createPortal(<div className={`brain-view${closing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby="brain-title"
    style={{ '--origin-x': `${origin.x}px`, '--origin-y': `${origin.y}px`, '--dx': `${origin.x - innerWidth / 2}px`, '--dy': `${origin.y - innerHeight / 2}px` } as CSSProperties}>
    <div ref={host} className="brain-scene" />
    <header className="brain-header">
      <div><h2 id="brain-title">Memórias</h2>
        <p>{status === 'ready' ? count ? `${count} ${count === 1 ? 'memória' : 'memórias'} · ${subjects.length} ${subjects.length === 1 ? 'assunto' : 'assuntos'}` : 'Ainda vazio' : status === 'loading' ? 'Acendendo…' : ''}</p></div>
      <button ref={closeButton} className="brain-close" aria-label="Fechar memórias" onClick={close}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
      </button>
    </header>
    {status === 'ready' && !count ? <p className="brain-message">Converse com a Kelly para preencher o cérebro. Cada coisa que ela aprender sobre você vira um ponto de luz aqui.</p> : null}
    {status === 'disabled' ? <p className="brain-message">A memória não está configurada no servidor.</p> : null}
    {status === 'error' ? <p className="brain-message">Não foi possível acender as memórias. <button onClick={() => { setStatus('loading'); setRefresh((n) => n + 1); }}>Tentar de novo</button></p> : null}
    {focus ? <div ref={card} className={`brain-card${focus.pinned ? ' pinned' : ''}`} role="status">
      <span className="brain-card-subject"><i style={{ background: color(focus.point) }} />{label(focus.point)}</span>
      <p>{focus.point.memory.value}</p>
      <small>{recalled(focus.point) ? 'Usada na última resposta · ' : ''}Lembrada em {new Date(focus.point.memory.createdAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' })}</small>
    </div> : null}
    <footer className="brain-footer">
      {subjects.length ? <ul className="brain-subjects" aria-label="Assuntos">{subjects.map((subject) =>
        <li key={subject.label}><i style={{ background: subject.color }} />{subject.label} <span>{subject.count}</span></li>)}</ul> : null}
      <p>{count ? 'Gire com o dedo · toque num ponto para lembrar · toque fora para voltar · ' : 'Toque fora para voltar · '}<a href="/memories" target="_blank" rel="noreferrer">Mapa detalhado ↗</a></p>
      <p className="brain-credit">Modelo do cérebro: <a href="https://sketchfab.com/3d-models/human-brain-cerebrum-brainstem-0aa0e33c5c854d1bab7bac9e1c7acaec" target="_blank" rel="noreferrer">pranktoy</a>, CC BY 4.0</p>
    </footer>
    <ul className="sr-only" aria-label="Lista de memórias">{layout?.points.map((point) =>
      <li key={point.id}><button onClick={() => setFocus({ point, pinned: true })}>{label(point)}: {point.memory.value}{recalled(point) ? ' (usada na última resposta)' : ''}</button></li>)}</ul>
  </div>, document.body);
}
