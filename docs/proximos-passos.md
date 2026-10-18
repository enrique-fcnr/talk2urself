# Talk2urself — escopo da demo

Meta: um clone individual muito bem acabado, estável, rodando em cloud e forte o suficiente para virar um case técnico de LinkedIn. Lista definida em 18/10/2026.

## Finalizar agora, antes dos vídeos

- [ ] Implementar a AWS / cloud.
- [ ] Validar o fluxo completo em cloud: áudio → transcrição → LLM → memória → voz → avatar.
- [ ] Testar e estabilizar a memória/RAG entre sessões.
- [ ] Validar casos em que a memória deve e não deve ser recuperada.
- [ ] Testar autonomia do clone: recomendar, discordar, explicar critérios e não inventar fatos.
- [ ] Estabilizar transcrição, TTS e latência.
- [ ] Clonagem de voz na demo: plano Pro da Cartesia (assinatura decidida em 18/10/2026), habilitar (`CARTESIA_PAUSED=0`, `VOICE_CLONING=1`, ver `clonagem-de-voz.md`) e validar de verdade.
- [ ] Validar português e inglês.
- [ ] Validar especialmente o lip-sync em inglês com voz.
- [ ] Fechar o avatar 3D: boca, olhos, piscadas, respiração, gestos e lip-sync.
- [ ] Fechar a experiência visual: despertar, legendas, temas, cérebro e visualização de memórias.
- [ ] Validar a conversa contínua: voz frase por frase e interrupção pela voz, inclusive com eco em notebook sem fone.
- [ ] Adicionar observabilidade básica: erros, latência, chamadas e, se fizer sentido, custos.
- [ ] Rodar novamente os testes automatizados.
- [ ] Rodar typecheck e build final.
- [ ] Fazer uma bateria de testes manuais com conversas reais e cenários controlados.
- [ ] Documentar arquitetura, decisões, problemas encontrados e limitações.
- [ ] Congelar uma release estável de demonstração antes de começar a gravar.

## Decisões registradas

- **Conversa contínua e interrupção pela voz entram na demo** (18/10/2026), embora a lista original as deixasse para depois. Já implementadas: o microfone reabre depois de cada resposta; falar por cima do clone o interrompe (tocar nele também); a voz é gerada frase por frase, e a próxima só quando a anterior começa a tocar, então uma interrupção desperdiça no máximo uma frase. O histórico guarda só o que foi ouvido, terminado em "…". Falta validar com voz real e eco.
- **Configurações enxutas:** Perfil (nome) e Voz (original ou a sua). Nada comercial na demo.
- **Sem créditos dos modelos 3D na interface** (decisão de 18/10/2026). Os modelos provisórios (Kelly, de skullvez; cérebro, de pranktoy) são CC BY 4.0, licença que pede atribuição; os textos das licenças continuam em `apps/web/public/avatars/*-LICENSE.md`. Para uso público sem atribuição, o caminho é trocar por modelos próprios ou CC0.
- **"Seu clone"** substitui "Kelly" na interface. O rosto provisório é feminino; um rosto neutro ou adaptado à pessoa fica para depois.
- **Inglês automático:** o clone responde no idioma da última fala, com vícios de linguagem separados por idioma (`memory.en_…` para o inglês). A abertura, os erros e a interface continuam em português.
- **Saudação de retorno no Render:** a contagem de memórias às vezes passa do limite de 2,5 s quando o servidor acorda, e a tela inicial mostra a versão de primeiro acesso. Reavaliar na AWS.

## Não vamos abranger agora

Login e autenticação multiusuário · remover o `LOCAL_USER_ID` e virar multi-tenant · isolamento completo entre usuários · billing, planos, Stripe, trial e assinaturas · onboarding comercial completo · clonagem automática pronta para qualquer usuário · avatar baseado no rosto real de cada usuário · acesso público aberto · painel administrativo · analytics comerciais, métricas de retenção e funil · rate limiting e proteção contra abuso · escala para muitos usuários simultâneos · exportação e exclusão completa de conta · camada comercial de privacidade · landing page e pricing · estrutura completa de SaaS · qualquer posicionamento envolvendo Alzheimer, terapia, benefício clínico ou saúde.
