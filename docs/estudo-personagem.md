# Personagem: do despertar à continuidade

Esta entrega aplica a personalidade definida no brainstorm à conversa existente. Não treina os pesos do modelo: combina instruções, exemplos de conduta, memórias e evidências do histórico.

## O caminho no projeto

1. `apps/web/src/App.tsx` mostra a natureza digital do personagem antes do primeiro toque. O hook `useConversation.ts` envia o comando de despertar e faz uma animação breve com as imagens atuais. A preferência por movimento reduzido é respeitada.
2. `apps/server/src/app.ts` consulta as memórias ao despertar. Um perfil vazio recebe a pergunta falada “Qual é meu nome?”. Um perfil com história recebe uma abertura curta baseada nessa continuidade. Nenhum usuário fictício ou fato é criado para produzir essa fala. O retorno ao repouso cancela operações pendentes.
3. `apps/server/src/character.ts` concentra identidade ficcional, descoberta em primeira pessoa, universo espelhado, linguagem contextual, profundidade e autonomia nas recomendações. Os dados pessoais continuam separados das instruções do modelo.
4. `apps/server/src/voice.ts` aplica essas regras em cada resposta, junto com o contexto recuperado. A abertura também usa a voz configurada; o contador inclui seus caracteres e os tokens usados numa retomada. Uma abertura não conta como resposta a uma fala do usuário.
5. `apps/server/src/memory.ts` valida os fatos e as hipóteses de linguagem. Uma informação explícita continua exigindo uma citação da fala atual. Um padrão observado pode usar três trechos diferentes de três falas do usuário; falas do personagem não contam. Os exemplos ficam preservados no texto da memória. As categorias e as tabelas existentes são reaproveitadas.

Preferências declaradas de linguagem ficam em Conversa. Padrões observados de vocabulário, expressão, intensidade e construção das frases ficam em Expressões; padrões de avaliação, em Raciocínio. Cada dimensão relevante pode ter sua própria memória, mantendo um fato por ponto. A classificação não cria níveis numéricos sem evidência.

A data de referência ajuda a contextualizar expressões como “hoje”; datas de registro das memórias ficam disponíveis para o modelo e não são confundidas com datas dos acontecimentos. O resumo deve distinguir estados passageiros, acontecimentos e sugestões ainda não executadas. A interpretação temporal e a fidelidade da personalidade ainda precisam ser avaliadas nas conversas.

## Uma hora de estudo

- **15 minutos:** leia `character.ts`. Observe como o comportamento é descrito sem colocar suas informações pessoais dentro das instruções.
- **15 minutos:** siga o comando `start` em `app.ts`, a consulta às memórias, a abertura e a reprodução. Depois siga o envio de uma fala verdadeira.
- **15 minutos:** veja `validateLearning` em `memory.ts`. Compare uma informação declarada com um padrão observado e suas três evidências.
- **15 minutos:** abra a prévia, desperte e avalie uma conversa curta. Anote a resposta que recebeu, o que não o representa e a resposta que gostaria de receber. Não precisa aprender a arquitetura inteira de uma vez.

## Como avaliar

Teste descoberta, retomada, decisão com contexto suficiente, ausência de dado decisivo, mudança de opinião e estilo de fala. O personagem deve perguntar uma coisa por vez na descoberta; quando já puder ajudar, deve recomendar, justificar e aceitar sua correção. Uma hipótese de linguagem é revisável. Não é necessário repetir “como seu avatar” em cada fala.

`scripts/evaluate-character.ts` contém quatro cenários fictícios separados do seu perfil. É uma avaliação opcional com chamadas à OpenAI; não usa transcrição, não gera voz e não escreve no Supabase. As respostas ficam em `.local/character-evaluation.json`, ignorado pelo Git. Rodar novamente consome tokens. Revisar exemplos aprovados e corrigidos pode ajudar numa avaliação ou treinamento futuro; esse arquivo não inicia fine-tuning.

## Limites desta entrega

A reação de despertar usa as três imagens atuais, sem modelagem 3D ou animação facial. Streaming de áudio, detecção automática das pausas e o avatar 3D seguem para as próximas etapas. A retirada de memórias do contexto já segue os pedidos do usuário; um controle específico de consentimento para relatos sensíveis ainda é uma proposta a revisar. A fidelidade da representação é avaliada por você, não garantida por estas instruções.
