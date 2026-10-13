# Estudo da etapa 1 — aproximadamente uma hora

Objetivo: reconhecer como a tela é montada e como um evento muda o que aparece.
Você não precisa dominar React, TypeScript ou WebSocket para acompanhar esta entrega.

## Componentes e JSX — 15 minutos

Leia [Seu primeiro componente](https://react.dev/learn/your-first-component).
Abra `apps/web/src/App.tsx`. A função `App` é o componente principal;
o conteúdo depois de `return` é a estrutura da tela escrita em JSX.
Procure o cabeçalho, o avatar, a área de resposta e os botões.

Experimento: altere o título “Um espaço para pensar em voz alta.” e veja o navegador atualizar.

## Estado — 15 minutos

Leia [Estado: a memória de um componente](https://react.dev/learn/state-a-components-memory).
Em `App.tsx`, `showGuide` guarda se a explicação da prévia está aberta.
`setShowGuide` altera esse valor e o React atualiza a tela.

Os estados de conversa vêm do servidor e são guardados pelo hook `useConversation`:
`idle`, `listening`, `thinking` e `speaking`. Não é necessário estudar a conexão agora.
Observe como `state` escolhe o texto e a imagem.

Experimento: abra e feche “Sobre esta prévia” e localize a condição que exibe esse painel.

## Eventos — 15 minutos

Leia [Responder a eventos](https://react.dev/learn/responding-to-events).
Localize os `onClick`. São as funções chamadas quando você toca nos botões.
O botão de despertar envia uma mensagem; o servidor responde com um estado novo,
e a interface mostra os olhos abertos.

Experimento: clique em Despertar, Simular pergunta e Voltar ao repouso.
Explique a diferença entre o evento do clique e o estado da tela.

## Leitura guiada — 15 minutos

Siga esta ordem em `App.tsx`:

1. `labels`: títulos e instruções para cada estado.
2. `useConversation()`: dados recebidos e função para enviar comandos.
3. `useState(false)`: estado local do painel explicativo.
4. `image` e `busy`: valores calculados a partir do estado atual.
5. `return`: a tela, suas condições e seus eventos.

Ao final, tente responder:

- Onde altero um título?
- O que faz os olhos aparecerem abertos?
- Por que o botão fica desabilitado durante a resposta?
- Qual estado é local e qual vem do servidor?

Essas respostas bastam para esta etapa. A ligação com o servidor será o próximo estudo.
