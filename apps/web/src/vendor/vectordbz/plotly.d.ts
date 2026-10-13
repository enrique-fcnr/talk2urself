declare module 'plotly.js-gl3d-dist-min' {
  export interface PlotElement extends HTMLDivElement {
    data?: unknown;
    on(name: string, callback: (event: { points?: Array<{ pointIndex?: number; customdata?: unknown }> }) => void): void;
    removeAllListeners?(name: string): void;
  }
  const Plotly: {
    react(element: HTMLDivElement, data: Record<string, unknown>[], layout: Record<string, unknown>, config: Record<string, unknown>): Promise<PlotElement>;
    purge(element: HTMLDivElement): void;
    Plots: { resize(element: HTMLDivElement): Promise<void> };
  };
  export default Plotly;
}
