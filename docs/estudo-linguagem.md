# Como o personagem aproxima seu jeito de falar

A resposta da conversa e a observação da linguagem agora são tarefas separadas.
O observador recebe até seis falas recentes do usuário e os padrões já conhecidos.
Também recebe até doze candidatos persistidos com evidências de falas anteriores,
mesmo quando essas falas já saíram da janela recente. Veja o
[guia dos candidatos e evidências](estudo-candidatos.md).
Respostas do personagem nunca servem de exemplo para aprender a linguagem do usuário.

Ele procura gírias, vocabulário, construção de frases, formalidade, afetividade,
intensidade, humor e organização das explicações. Não estima sotaque ou prosódia
a partir do texto, nem transforma palavras em diagnóstico ou traço de personalidade.
Também não inventa notas de complexidade ou intensidade.

## Quando aprende

Após pelo menos três falas, o observador pode propor até três padrões por análise.
Cada inferência precisa de três trechos literais em falas distintas, incluindo a
atual. Uma preferência explicitamente declarada dispensa a repetição. Três falas
permitem validar; não obrigam a criar memória se o padrão não estiver sustentado.

Enquanto nenhum padrão estiver salvo, os próximos turnos elegíveis fazem a análise.
Depois, a versão persistida determina uma análise a cada terceiro turno. Isso evita
uma chamada extra em toda resposta depois do primeiro aprendizado. A análise usa
o mesmo modelo da conversa e acrescenta consumo de tokens. Ela começa depois que
a conversa é salva, em segundo plano: a resposta não espera essa chamada terminar.
Existe uma análise ativa por usuário local e uma pendência com a rodada mais
recente. Falas novas não são acrescentadas à chamada que já começou. Quando ela
termina, a pendência é avaliada usando as falas recentes e o perfil atualizado.
Tem limite de espera; se falhar, a conversa principal segue funcionando.

## Como muda a resposta

Padrões validados e salvos entram no contexto das respostas seguintes e seguem
carregados no perfil nas próximas visitas. A resposta em andamento usa o estilo
que já conhecia. O RAG continua buscando fatos pelo significado com os vetores
originais. O estilo não depende de perguntar sobre linguagem para aparecer no contexto.

O personagem usa os padrões para escolher palavras, organizar frases e desenvolver
ideias. Não precisa usar uma gíria em toda resposta. Uma explicação profunda pode
usar palavras simples e familiares. Correções e recusas explícitas têm prioridade
sobre observações; as memórias são revisáveis.

O servidor gera os embeddings e grava a linguagem numa transação separada,
através de `talk_apply_language_v2`, usando a fala real já salva como origem.
Não cria turnos fictícios, não muda o resumo e não incrementa a versão da conversa.
Se outra fala foi salva enquanto a análise rodava, seu resultado fica desatualizado
e é descartado. A próxima pendência pode analisar o contexto recente. Preferências
explícitas e recusas têm prioridade sobre inferências.

O worker funciona enquanto o servidor está ligado. Reiniciar o servidor cancela
a análise ativa e perde a pendência em memória; as conversas e os padrões já salvos
continuam no Supabase e poderão alimentar análises em novos turnos elegíveis.
Os candidatos e suas referências também continuam no banco. A coleta acompanha
a gravação de cada fala, mesmo enquanto uma análise anterior está rodando.

## Onde estudar em uma hora

1. **15 minutos:** `apps/server/src/language.ts` — entrada com falas do usuário,
   cadência, pistas de repetição e filtragem.
2. **15 minutos:** `apps/server/src/language-worker.ts` e `voice.ts` — uma análise
   ativa, pendência mais recente e chamada separada ao modelo.
3. **15 minutos:** `apps/server/src/memory.ts` — evidência literal, três falas e
   gravação dos fatos individuais com embeddings.
4. **15 minutos:** `apps/server/src/app.ts`, `character.ts` e
   `docs/diagnostico-memoria.md` — uso natural do estilo e diagnóstico do resultado.

## Teste no aplicativo

Converse normalmente e consulte **Suas memórias**. O aprendizado pode aparecer
alguns segundos depois da resposta, quando a análise e a gravação terminarem.
Se aparecer um padrão, confira seus exemplos. Reabra a página e converse sobre
outro assunto: o perfil deve continuar disponível. O log distingue proposta,
validação e gravação. A qualidade e a familiaridade da fala ainda dependem da
avaliação do usuário, não apenas de passar nos testes de código.
