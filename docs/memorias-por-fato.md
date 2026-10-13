# Memórias por fato

O resumo de continuidade continua no perfil. As memórias duradouras agora usam
uma chave estável por fato, um texto, uma fala de origem, uma categoria e um embedding.
Categoria é etiqueta, não um registro que acumula todos os fatos do assunto.

Exemplo real: o bloco antigo juntava futebol e cor azul. Foi dividido em
`memory.esporte_preferido` e `memory.cor_favorita`, cada um ligado à sua própria fala.
A altura já era independente e recebeu apenas a etiqueta Identidade. O bloco antigo
e todas as falas permanecem no banco, mas o bloco agregado fica fora do contexto ativo.

Na conversa, o modelo consulta as chaves existentes para reconhecer repetição e correção.
Repetições exatas também são reconhecidas no servidor. Uma correção reutiliza a chave do
fato e cria uma revisão, mantendo a anterior inativa. Não altera fatos vizinhos na categoria.
Extração e classificação ainda são decisões probabilísticas; valide casos ambíguos no aplicativo.
Lacunas indicam assuntos sem relatos; ter uma informação numa categoria não significa
conhecer todos os aspectos daquele assunto. A IA deve reconhecer o que não foi contado.

O RAG recupera fatos semelhantes usando os vetores originais. Perfil básico, resumo,
mensagens recentes e catálogo de até 200 fatos completam o contexto. Categoria não é
um filtro obrigatório do RAG: perguntas podem cruzar trabalho, família e objetivos.
Quando esse catálogo crescer além do limite, será preciso evoluir a deduplicação antes
de prometer reconhecimento de todas as memórias antigas.

## Migração e recuperação

A migração gerada pela CLI mantém as funções v1 e acrescenta funções v2, metadados
e `talk_categories`. Todas as tabelas têm RLS; acesso é exclusivo pelo servidor.
O SQL inicial é para banco novo. Para reproduzir a estrutura completa, aplique a migração
inicial e depois a migração de fatos. Não reaplique o bootstrap em produção.

As migrações foram aplicadas pelo SQL Editor, sem registrar histórico da CLI.
Concilie esse histórico antes de usar `supabase db push`.

O snapshot anterior e o resultado da conversão ficam em `.local/atomic-migration`,
ignorados pelo Git. `scripts/backfill-atomic.mjs` é uma conversão específica dos dois
fatos verificados deste projeto, não um extrator universal de qualquer histórico.
Falas de teste não são importadas. O endpoint de conversão verifica origem, versão e
propriedade; repetir um commit não cria outra cópia dos fatos.

Se for necessário recuperar o estado anterior imediatamente, pare o servidor,
restaure os arquivos em `.local/before-atomic-memories`, e use
`db/rollback-atomic-backfill.sql` com o identificador do bloco e a versão registrados
no resultado da conversão. Não execute após novas conversas sem revisão: a verificação
de versão impede sobrescrever dados posteriores. A recuperação arquiva os fatos novos
e reativa o bloco anterior; não apaga tabelas, categorias ou histórico. Não foi executada
no banco real.

## Estudo de uma hora

1. 20 minutos: compare resumo, fato, categoria e embedding no seu próprio exemplo.
2. 20 minutos: acompanhe a validação e a gravação em `apps/server/src/memory.ts`.
3. 20 minutos: selecione os três pontos, confira suas origens e use filtros no mapa.

Teste seguinte: conte dois fatos verdadeiros na mesma fala, confirme dois pontos;
depois corrija somente um e confira que o outro continua intacto.
