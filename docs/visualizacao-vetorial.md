# Mapa de memórias ao vivo

Com `npm run dev`, abra http://127.0.0.1:5173/memories.
Também há um link em **Sobre esta prévia**. Deixe o mapa aberto em outra aba
enquanto conversa: após o servidor confirmar uma gravação no Supabase, envia
um aviso por WebSocket. O mapa relê os vetores e recalcula a projeção.

Esta integração adapta o componente 3D do [VectorDBZ](https://github.com/vectordbz/vectordbz),
com licença MIT preservada. Não instala o aplicativo Electron completo, que usa
credenciais diretas de PostgreSQL. Aproveita a conexão já configurada no servidor.

## O que você vê

- Até 200 memórias ativas mais recentes do usuário local; recusas e versões antigas ficam fora do gráfico.
- Cada ponto representa um fato duradouro independente, não cada frase pronunciada.
- Categorias são etiquetas: vários fatos podem ter a mesma categoria e a mesma cor.
- Os botões de categorias filtram pontos sem recalcular suas posições.
- Clique num ponto ou numa memória da lista para ler seu texto e sua fala de origem.
- As três memórias mais similares são comparadas usando os vetores originais.
- Uma correção substitui a memória ativa; a versão anterior continua no histórico do banco.
- Se a conexão cair, o mapa avisa e tenta reconectar; relê ao reconectar e ao retornar à aba.
- Uma consulta a cada 15 segundos reconcilia mudanças externas ou eventos perdidos.

A evolução para fatos individuais usa a migração `20261008172213_atomic_memories_categories.sql`,
aplicada ao Supabase. Não exige nova configuração de chaves. A chave fica no servidor e o usuário é
definido pela configuração local, nunca por um parâmetro do navegador. Ler o
mapa não gera embeddings nem voz e não consome créditos desses fornecedores;
há tráfego de leitura do Supabase. A interface é de observação, sem escrita.

## Categorias e cores

O modelo classifica cada fato usando um catálogo inicial amplo. Reutiliza categorias
existentes antes de propor novas. O servidor normaliza nomes e alguns sinônimos;
uma categoria nova quase equivalente (similaridade ≥ 0,96) pode reutilizar uma existente.
Essa heurística precisa ser observada em conversas reais: não é garantia de classificação perfeita.

Cada categoria inicial tem uma cor estável. Para uma nova categoria, seu embedding
é comparado com as categorias iniciais e as três mais próximas influenciam uma mistura
em OKLab. Mantemos luminosidade legível e limitamos o resultado ao gamut sRGB.
A cor hexadecimal é salva e não muda quando outra categoria chega. Categorias relacionadas
tendem a receber cores próximas; cor não é uma medida exata de similaridade entre fatos.
Não usamos todas as cores possíveis indiscriminadamente, pois algumas desaparecem no fundo.
Os nomes e filtros permitem entender o mapa sem depender apenas da cor.

Embeddings das categorias são gerados uma vez e armazenados; gerar uma categoria nova
consome uma pequena chamada adicional de embeddings. Consultar o mapa continua sem chamadas
de IA. Não há treinamento de pesos do modelo nesta mudança.

## A projeção

Usamos PCA aproximada por iteração de potência, após normalizar os vetores.
Ela considera todas as 1.536 dimensões e projeta em três eixos. O cálculo roda
num worker para não bloquear a interface de voz. A fração de variância preservada
indica quanto da dispersão numérica ficou representado; não é uma medida de
qualidade semântica. Um ponto isolado aparece no centro. Poucos pontos podem
formar uma linha ou um plano; não criamos uma nuvem fictícia para preencher o espaço.

Posições podem mudar quando chegam memórias. A projeção não preserva todas as
distâncias, e proximidade visual não prova equivalência de significado. A busca
RAG do servidor continua usando os embeddings originais; não usa o gráfico 3D.

## Estudo de uma hora

1. **20 minutos:** uma linha SQL contém texto e um vetor; acompanhe a leitura em `memory.ts`.
2. **20 minutos:** HTTP traz o conjunto de pontos; WebSocket avisa que ele mudou. Veja `/ws/memories` em `app.ts`.
3. **20 minutos:** acompanhe `MemoryMap.tsx` e `projection.ts`. Selecione a memória de jogar bola e confira a origem.

Para testar ao vivo, conte um novo fato verdadeiro no aplicativo e observe a
memória aparecer depois da gravação. Nem todo turno cria uma nova memória:
atualizações dependem do que foi relatado e da validação de evidência.
