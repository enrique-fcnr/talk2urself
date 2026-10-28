import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Plotly, { type PlotElement } from 'plotly.js-gl3d-dist-min';
type PlotClick = { points?: Array<{ pointIndex?: number; customdata?: unknown }> };
export default function Plot({ data, layout, config, style, onClick }: {
  data: Record<string, unknown>[]; layout: Record<string, unknown>; config: Record<string, unknown>;
  style: CSSProperties; useResizeHandler?: boolean; onClick: (event: PlotClick) => void;
}) {
  const container = useRef<PlotElement>(null);
  const callback = useRef(onClick);
  const [error, setError] = useState('');
  useEffect(() => { callback.current = onClick; }, [onClick]);
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(() => { if (element.data) void Plotly.Plots.resize(element).catch(() => {}); });
    observer.observe(element);
    return () => { observer.disconnect(); element.removeAllListeners?.('plotly_click'); Plotly.purge(element); };
  }, []);
  useEffect(() => {
    let active = true;
    const element = container.current!;
    void Plotly.react(element, data, layout, config).then(() => {
      if (active) { element.removeAllListeners?.('plotly_click'); element.on('plotly_click', (event) => callback.current(event)); setError(''); }
    }).catch(() => { if (active) setError('Could not draw the chart. Check WebGL; the memories are still in the list.'); });
    return () => { active = false; };
  }, [data, layout, config]);
  return <>{error ? <p role="alert">{error}</p> : null}<div ref={container} style={style} aria-label="Mapa tridimensional dos embeddings" /></>;
}
