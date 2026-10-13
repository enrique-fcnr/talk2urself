import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const MemoryMap = lazy(() => import('./vectors/MemoryMap'));
createRoot(document.getElementById('root')!).render(<StrictMode>{location.pathname === '/memories'
  ? <Suspense fallback={<p>Carregando mapa de memórias…</p>}><MemoryMap /></Suspense>
  : <App />}</StrictMode>);
