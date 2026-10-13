# Memória e perfil evolutivo

## Situação

Estrutura aplicada ao projeto Talk2Urself pelo SQL Editor do navegador integrado.
As três tabelas, o pgvector e as funções de recuperação e gravação foram criados.
Conferência remota: três tabelas vazias com RLS, pgvector instalado, campos ampliados
e funções permitidas somente ao papel do servidor entre os papéis de cliente da aplicação.
O servidor carregou a secret key local e acessou o perfil vazio no banco real.
A rota de consulta confirmou os 17 assuntos desconhecidos. Gravação e recuperação
com conversa real ainda precisam ser validadas; não houve chamada paga nesta conferência.
Nenhum treinamento do modelo foi iniciado. A personalização usa contexto e instruções.

Validação local: 16 testes automatizados passaram, incluindo reconexão e falha na gravação.
O build passou. O SQL foi executado em PostgreSQL/PGlite com pgvector; criação,
busca, isolamento, correção com revisão, recusa, idempotência, versão e rollback passaram.
Os testes locais não substituem a prova de gravação e recuperação numa conversa real.

## Uma hora para entender

- 20 minutos: tabelas, chaves e transações em `db/setup-memory.sql`.
- 20 minutos: perfil, resumo, mensagens recentes e busca em `apps/server/src/memory.ts`.
- 20 minutos: siga uma fala em `app.ts` e a resposta estruturada em `voice.ts`.

## Caminho

Após a transcrição, um embedding da pergunta recupera memórias relacionadas. O servidor
carrega também o perfil, o resumo e até dez pares de falas recentes, limitados a cerca
de 12 mil caracteres. Na mesma chamada que gera a resposta, a OpenAI propõe um resumo
e até seis atualizações. O servidor exige evidência literal da fala atual e ao menos
três exemplos distintos para aceitar padrões observados. Novas memórias recebem
embeddings; turno, resumo e revisões são gravados juntos antes de reproduzir a resposta.

Os campos começam desconhecidos: nome, contexto de vida, família, amigos, trabalho,
estudos, vida pessoal, acontecimentos, experiências difíceis relatadas, objetivos,
princípios, rotina, limites, interesses, preferências de conversa, expressões e modo
de avaliar decisões. Experiências difíceis não são inferidas como traumas ou diagnósticos,
nem solicitadas apenas para preencher o perfil.
O avatar pergunta sobre uma lacuna quando o assunto precisar dela, sem questionário
obrigatório. Pode guardar outros acontecimentos em chaves `memory.*`.

As memórias representam o que foi relatado, não fatos comprovados. Ter uma citação
literal não garante que a interpretação esteja correta; revise e corrija durante os testes.
O resumo comprime a conversa e pode perder detalhes. Não garante lembrança perfeita.

## Banco

- `talk_profiles`: resumo e versão contra atualizações concorrentes.
- `talk_turns`: textos transcritos e respostas geradas; áudio não é salvo.
- `talk_memories`: conteúdo, evidência, origem, embedding e revisões anteriores.

A busca vetorial é exata nesta fase. HNSW pode ser avaliado quando o volume justificar.
Há índices por usuário e sequência. Reabrir recupera a continuidade pelo mesmo identificador.

## Configuração ao voltar

1. A estrutura já foi aplicada ao projeto. Não execute o bootstrap novamente.
   O arquivo em `supabase/migrations` foi gerado pela CLI e representa a estrutura
   inicial final. Como a aplicação remota foi pelo SQL Editor, o histórico da CLI
   precisa ser conciliado antes de um futuro `db push`; não o execute às cegas.
2. Preencha `SUPABASE_SECRET_KEY` no `.env` local. Use a secret key apenas no servidor,
   sem prefixo `VITE_`. URL e `LOCAL_USER_ID` são preparados separadamente.
3. Reinicie. `/api/memory` indica o perfil e as lacunas; sem secret key, a conversa
   existente continua usando contexto temporário e a página informa a pendência.
4. Teste declarar um objetivo, fechar/reabrir, recuperar e depois corrigir o objetivo.
   Confira a origem e as revisões no banco. Os testes locais não substituem essa prova.

## Limites

O servidor roda somente em loopback e todas as abas compartilham seu usuário local.
Um turno de memória por vez evita conflitos. Não publique esse servidor assim: a fase
pública exige autenticação por requisição e isolamento por usuário autenticado.
As tabelas têm RLS, sem acesso de `anon` ou `authenticated`; somente o servidor acessa
as funções com secret key. Nenhuma chave é devolvida à página.

As respostas salvas foram geradas, não necessariamente ouvidas até o fim. Cancelar
depois do envio ao banco pode não desfazer uma transação. Recusar um assunto retira
sua memória ativa do contexto, mas não apaga histórico ou revisões; exclusão definitiva
terá um fluxo próprio. O estilo e o conhecimento evoluem, os pesos do modelo não mudam.

A saída estruturada e os embeddings também consomem tokens. Embeddings ficam em
`.local/usage.jsonl`; consulte o consumo oficial nos fornecedores. A gravação no banco
acrescenta espera nesta versão. Streaming e pausas automáticas continuam pendentes.

Fontes: [OpenAI — saída estruturada](https://developers.openai.com/api/docs/guides/structured-outputs),
[embeddings](https://developers.openai.com/api/docs/guides/embeddings),
[Supabase — chaves](https://supabase.com/docs/guides/getting-started/api-keys),
[pgvector](https://supabase.com/docs/guides/database/extensions/pgvector).
