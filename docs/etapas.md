# Plano de desenvolvimento

Cada etapa tem objetivo, estudo básico, entrega funcionando e validação.
Haverá espaço para experimentar e tirar dúvidas antes do próximo assunto.

| Etapa | Entrega | Estudo básico | Critério para avançar |
| --- | --- | --- | --- |
| 1 | Interface e servidor demonstrativo | Componentes, estado e eventos React | Entender a tela e experimentar os quatro estados |
| 2 | Primeira conversa por voz | Node, rotas, WebSocket e APIs | Falar e ouvir uma resposta; consumo registrado |
| 3 | Fluidez e conversa por turnos | Microfone, áudio e detecção do fim da fala | Respeitar pausas, reproduzir sem cortes e voltar a escutar |
| 4 | Continuidade e memória | SQL, resumos, embeddings e recuperação | Retomar após fechar e recuperar memórias relevantes |
| 5 | Personalidade e profundidade | Instruções e avaliação de respostas | Comparar Luna e Sol e avaliar os contrapontos |
| 6 | Avatar 3D e acabamento | Modelo, materiais e sincronização facial | Fidelidade ao avatar e movimentos suaves |
| 7 | Validação pessoal e portfólio | Medição de latência e custos | Experiência demonstrável e orçamento conhecido |

A viabilidade do modelo 3D deve ser investigada cedo: gerar uma base não garante
que olhos e boca estejam prontos para animar. A integração completa é a etapa 6.

## Decisões mantidas

- Web primeiro; React Native fica para uma fase posterior.
- Uma conversa contínua por usuário, sem múltiplos chats na interface.
- Conversa inicialmente sem interrupção automática por voz.
- Supabase com PostgreSQL e pgvector; embeddings da OpenAI.
- Cartesia para transcrição e voz; modelo escolhido após comparação.
- Three.js e React Three Fiber para o avatar real.
- Desenvolvimento local, testes curtos; hospedagem e assinatura depois.

## Situação atual

Etapa 1 implementada: verificação de tipos, três testes do servidor e build passaram.
A prévia foi aberta no navegador, com despertar, reflexão, retorno e repouso verificados.
Etapa 2 aplicada ao repositório: captura manual do microfone, transcrição
Cartesia, resposta OpenAI, reprodução WAV, cancelamento e registro local de uso.
Nove testes com serviços simulados e o build passaram na cópia preparada; a verificação
de tipos também passou após aplicação. O usuário confirmou a conversa real e a voz clonada.
Os testes automatizados não consomem créditos; as conversas reais consomem.
Etapa 4 parcialmente preparada: integração de memória, perfil com lacunas e consulta
das memórias na interface implementados, com 16 testes locais passando. SQL validado
em PostgreSQL/PGlite com pgvector e aplicado ao Supabase pelo SQL Editor.
Família, amigos, trabalho, estudos, vida pessoal e experiências relatadas são categorias;
cada fato relevante tem registro e embedding próprios. A migração de fatos individuais
foi aplicada preservando histórico e origens. As categorias são classificadas automaticamente,
com reaproveitamento, cores estáveis e filtros no mapa. As cores novas usam semelhança entre categorias.
A chave foi configurada e a consulta ao perfil no Supabase real funcionou.
A gravação da preferência por jogar bola e sua recuperação após reabrir foram
confirmadas pelo usuário. A correção e a recuperação semântica de memórias
episódicas ainda precisam de provas em conversas reais.
Um painel de observação em `/memories` adapta o gráfico 3D do VectorDBZ,
com atualização após commits confirmados e comparação pelos vetores originais.
Sem secret key, a conversa existente mantém contexto temporário.
A personalidade da etapa 5 está aplicada: descoberta em primeira pessoa, abertura falada,
retomada com memórias, linguagem contextual e recomendações autônomas. O despertar
usa uma animação breve das imagens existentes. A extração de padrões de linguagem
valida exemplos em três falas do usuário e preserva essas evidências.
Os 26 testes locais e o build passaram; quatro cenários fictícios foram avaliados
com o modelo configurado, sem escrever no Supabase. O retorno com a memória real
e a voz clonada foi conferido no navegador. A fidelidade continua sendo refinada
com o usuário. Consulte estudo-personagem.md e comportamento-personagem.md.
As etapas de streaming, pausas automáticas e avatar 3D seguem pendentes.
