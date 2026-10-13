# Diagnóstico das memórias

O servidor registra o caminho de cada fala em `.local/memory-diagnostics.jsonl`.
O arquivo é local e está ignorado pelo Git. Não contém transcrições, respostas,
resumos, evidências, vetores nem chaves. Não há chamadas extras às APIs para gerar
esse registro. O histórico pessoal continua no Supabase, separado do diagnóstico.

Uma identificação (`turnId`) reúne os eventos da mesma fala. A fala seguinte tem
outra identificação. Cada linha é um objeto JSON com data, etapa, resultado e,
quando necessário, motivo e contadores.

| Etapa | O que observar |
| --- | --- |
| `language_candidates` | Quantos candidatos com três evidências foram fornecidos à análise, até doze. `candidate_limit` sinaliza que o usuário atingiu o teto de candidatos armazenados. Zero não significa que a coleta falhou: pode haver candidatos ainda sem três provas ou sem ocorrência na fala atual. |
| `language_analysis` | Análise separada do jeito de falar: iniciou, concluiu, foi pulada pela cadência ou falhou. `source: language` diferencia o observador da conversa principal. |
| `proposal` | `count` é o total de propostas da IA; `languageCount` conta propostas de linguagem ou raciocínio. Zero significa que não houve proposta naquela resposta. |
| `validation` | `accepted` ou `rejected`, com posição da proposta (`candidate`) e motivo. `completed` traz os totais aceitos. |
| `preparation` | Na conversa, resolve categorias e repetições antes de gerar os vetores. Com `source: language` e `count: 3`, vincula um candidato escolhido às três falas originais antes da validação. `correctedFields` informa quais campos foram ajustados, sem copiar valores. |
| `embedding` | Confirma geração dos vetores dos fatos. `skipped` significa que não havia fatos conhecidos para vetorizar, inclusive quando só houve uma retirada. |
| `commit` | `completed` confirma a gravação. Na conversa, `count: 0` salva histórico e resumo sem fatos novos. Com `source: language`, conta apenas padrões gravados na transação separada; `skipped` com `stale_context` indica resultado desatualizado. |
| `turn` | Resultado da tentativa completa: concluída, falhou ou foi cancelada. |

Motivos de validação:

- `missing_current_evidence`: evidência não está literalmente na fala atual.
- `insufficient_user_utterances`: faltam três falas distintas do usuário com as provas fornecidas; respostas do personagem não contam.
- `invalid_samples`: os trechos de prova não respeitam o formato ou não incluem a fala atual.
- `unsupported_observation`: tentou inferir padrão fora das categorias permitidas.
- `invalid_fields` / `invalid_format`: formato ou limites inválidos.
- `duplicate_slot`: duas propostas tentam ocupar a mesma chave nesta resposta.
- `empty_value` / `value_too_long`: conteúdo vazio ou acima do limite.

Falhas externas ficam como `service_error`, sem copiar mensagens do serviço.
Para `invalid_fields`, o log também informa `field` (nome fixo do campo) e
`detail` (`invalid_type`, `invalid_pattern`, `empty`, `too_short`, `too_long` ou
`invalid_choice`). Por exemplo, `field: evidence` e `detail: too_short` significa
que a evidência tem menos de três caracteres úteis. Nenhum valor do campo é copiado.
Esses detalhes valem para novas tentativas; rejeições antigas permanecem genéricas.
Na análise separada, `candidateIds` contém apenas referências aos candidatos
fornecidos pelo banco, sem copiar expressões ou falas. Isso permite associar a
rejeição ao candidato. Para `supportingEvidence`, o detalhe distingue quantidade
errada, tipo/tamanho inválido, ausência da fala atual e falta de três origens
distintas. A checagem de `candidateIds` distingue referência desconhecida de
provas que não correspondem à expressão. Uma proposta sem referência reconhecida
continua sem associação; o diagnóstico não inventa uma.
Uma falha ao escrever o log não interrompe a voz nem altera a transação no banco.

O log em si não chama APIs. O observador de linguagem faz uma chamada adicional
à OpenAI nos turnos elegíveis, em segundo plano, com uso registrado como `llm-language`. Ele começa
após três falas do usuário; enquanto não houver padrão salvo, tenta nos próximos
turnos. Depois, usa a versão persistida para analisar a cada terceiro turno.
`periodic_interval` indica intervalo; `language_declined` indica recusa do aprendizado.
Uma falha nessa análise preserva a conversa principal. As propostas aceitas são
gravadas por `talk_apply_language_v2`, numa transação separada com o `turnId` da fala
real como origem. O resumo não muda. Uma análise atrasada gera `stale_context` e
não sobrescreve a conversa nova. Falhas de vetor e banco indicam a etapa exata.

## Teste com uma expressão recorrente

Converse normalmente no aplicativo. Depois que a resposta terminar, consulte as
linhas da última tentativa. Há três situações diferentes:

1. Nenhuma proposta de linguagem: a IA não sugeriu guardar esse padrão.
2. Proposta rejeitada: o motivo explica qual regra não foi atendida.
3. Proposta aceita: confira os vetores e a confirmação de gravação.

Ter três falas com uma expressão permite validar a observação, mas não obriga a IA
a propor uma memória. Uma preferência declarada usa outra regra e dispensa essa
contagem. Uma memória salva também não obriga o personagem a usar a expressão em
todas as respostas.

Esses registros começam após carregar esta implementação no servidor. Não
reconstituem o motivo de propostas omitidas ou rejeitadas nas conversas anteriores.

As tabelas de candidatos e evidências preservam referências às falas originais.
Não são logs e não têm embeddings próprios. O registro de diagnóstico mostra
apenas contadores e etapas; veja [o guia dos candidatos](estudo-candidatos.md).
