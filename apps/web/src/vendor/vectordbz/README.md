# Componente adaptado do VectorDBZ

Origem: https://github.com/vectordbz/vectordbz
Commit: `a0af28968539166b9eb2399470a9e49a743dd960`
Arquivo original: `app/src/components/VisualizeTab/PlotlyScatterView.tsx`.
Licença MIT preservada em `LICENSE` (Copyright 2026 VectorDBZ Contributors).

Reutilizamos o renderizador de dispersão, não o aplicativo Electron completo.
Adaptações: tipos locais, rótulos com o texto da memória, seleção apenas de pontos
com metadados, preservação da câmera e módulo Plotly 3D local com wrapper React.
A consulta ao Supabase, atualização ao vivo e PCA em worker pertencem ao Talk2urself.
O módulo Plotly tem sua própria licença MIT em `node_modules/plotly.js-gl3d-dist-min/LICENSE`.
