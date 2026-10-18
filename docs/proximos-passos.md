# Talk2urself — próximos passos

Lista do que já foi decidido acrescentar, em ordem aproximada de prioridade. Cada item vira uma tarefa quando entrar em desenvolvimento.

## 1. Página de configurações (engrenagem)

A engrenagem abre uma página cheia (no celular, uma tela que desliza por cima), em cartões no estilo de vidro do app.

| Seção | Conteúdo |
|---|---|
| Conta | Nome, e-mail, foto; login (link por e-mail, Google, Apple); sessões ativas; sair; excluir conta |
| Assinatura | Plano atual e próxima cobrança; uso do mês contra o limite; upgrade, troca e cancelamento; pagamento e faturas (portal da Stripe) |
| Kelly | Papel, tom, voz (catálogo ou clonada); "Refazer minha voz" |
| Conversa | Mãos-livres ou tocar para falar; pausa para encerrar; microfone com teste de volume; legendas |
| Memória e privacidade | Ver memórias; pausar aprendizado; assuntos proibidos; exportar dados; apagar tudo |
| Aparência | Tema claro, escuro ou automático; reduzir movimento |
| Ajuda e sobre | Ajuda, contato, versão, termos, privacidade, créditos 3D |

Ordem sugerida:
1. Página com as seções que já funcionam para um usuário (Kelly, Conversa, Memória, Aparência, Ajuda); Conta e Assinatura como "em breve".
2. Login de verdade (Supabase Auth), memórias por usuário com RLS, no lugar do `LOCAL_USER_ID` fixo.
3. Assinatura com Stripe (checkout, portal, webhook) e limites de uso por plano, usando o contador que o servidor já tem.
4. Hospedagem paga (Render pago ou AWS) antes de abrir para outras pessoas.

## 2. Kelly falando inglês — feito (automático)

A Kelly responde no idioma da última fala do usuário, português ou inglês; uma fala ambígua ("Okay.") mantém o idioma da conversa. Ela abre sempre em português.

| Peça | Como ficou |
|---|---|
| Transcrição | Aceita `pt` e `en`; o texto de apoio pede para transcrever no idioma falado, sem traduzir |
| Idioma da fala | `detectSpeechLanguage` (`speech-language.ts`): votação por palavras comuns de cada idioma e acentos |
| Resposta | Regra IDIOMA nas instruções e `replyLanguage` em cada turno; sem misturar idiomas na mesma fala |
| Vícios de linguagem | Expressões aprendidas em inglês ganham a chave `memory.en_…`; as demais são do português. A análise de linguagem só usa falas do mesmo idioma como prova, e a resposta só recebe as expressões do idioma dela. Jeito de argumentar e preferências declaradas valem para os dois |
| Memórias | Continuam escritas em português; evidências ficam literais no idioma falado |
| Voz | Cartesia recebe `en` ou `pt-BR` |
| Boca | Em inglês, usa os fonemas que a Cartesia devolve (ainda não testado com a voz ligada); em português, segue pela grafia das palavras |

Ainda em português: a abertura do primeiro contato, as mensagens de erro e a interface.

## 3. Pendências menores

- Créditos dos modelos 3D (CC BY 4.0, exigem atribuição): saíram da interface em 17/10/2026. Antes do lançamento, colocar em "Termos e privacidade": "Kelly, woman head with blendshapes", de skullvez, e "Human brain, Cerebrum & Brainstem", de pranktoy, ambos CC BY 4.0, com links e as mudanças feitas. Os textos estão em `apps/web/public/avatars/*-LICENSE.md`.

- Rosto do clone: a interface chama a personagem de "seu clone", mas o modelo 3D provisório (Kelly) é um rosto feminino. Antes do lançamento, um rosto mais neutro e estilizado, ou um avatar que se adapte à pessoa.

- Ligar a clonagem de voz quando o plano Pro da Cartesia estiver ativo (`CARTESIA_PAUSED=0`, `VOICE_CLONING=1`; ver `clonagem-de-voz.md`).
- Saudação de retorno no Render: a contagem de memórias às vezes passa do limite de 2,5 s quando o servidor acorda, e a tela inicial mostra a versão de primeiro acesso.
