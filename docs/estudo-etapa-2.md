# Etapa 2: primeira conversa por voz

Objetivo: gravar uma pergunta curta, enviá-la ao servidor e ouvir uma resposta.
Atualização de 11 de outubro de 2026: a transcrição principal passou para
OpenAI GPT-Transcribe, usando a mesma chave do modelo de resposta. Cartesia
gera somente a voz clonada. O painel temporário de comparação foi removido.
As pistas iniciais de vocabulário são véi, velho, pô e tá ligado; servem para
preservar formas pronunciadas, não para inserir palavras ausentes no áudio.
Os segundos no contador usam a duração devolvida pelo serviço ou, quando
ausente, a duração medida pelo navegador. São uma estimativa de uso, não a fatura.
Veja [o modelo de transcrição](https://developers.openai.com/api/docs/models/gpt-transcribe).

Primeiro validamos as três APIs. Detecção automática de pausas e áudio em streaming
serão refinados na etapa 3. O avatar ainda usa as imagens de referência.

## Uma hora de estudo

- 20 minutos: servidor Node, funções assíncronas, `fetch`, `await` e respostas de APIs.
- 20 minutos: microfone → arquivo de áudio → transcrição → resposta em texto → voz.
- 20 minutos: leia `voice.ts`, depois acompanhe o comando no servidor e na página.

O WebSocket liga página e servidor. Nesta primeira integração, o servidor chama
os endpoints HTTP da Cartesia e da OpenAI. A gravação é enviada inteira depois
do clique e a voz gerada é reproduzida como um arquivo. Isso valida a integração;
ainda não é a transmissão contínua da etapa de fluidez.

## Configurar as contas

1. Cartesia: comece com os créditos Free e escolha uma voz do catálogo que fale
   português. Copie seu Voice ID e crie uma chave da API na sua conta.
2. OpenAI: prepare seu acesso à API e crie uma chave para este projeto.
3. Copie `.env.example` para `.env`, na raiz, e preencha as duas chaves e o Voice ID.
4. Reinicie `npm run dev`. O servidor lê `.env`; o navegador não recebe as chaves.
5. Comece com uma pergunta de 5 a 10 segundos. A gravação tem limite de 30 segundos.

Sem os três valores, a prévia continua demonstrativa e não chama APIs.
Não cole chaves em arquivos de interface, no chat ou em commits. `.env` é ignorado
pelo Git. Alterar o modelo ou as chaves exige reiniciar o servidor.

## O que observar

- A transcrição representa o que você falou?
- A resposta é pertinente e desenvolve uma reflexão útil?
- A voz escolhida soa natural em português?
- Depois da reprodução, você consegue iniciar outra fala?
- Voltar ao repouso cancela a reprodução e descarta uma resposta pendente?

A conversa recente existe somente enquanto a conexão está aberta nesta etapa.
Fechar ou recarregar ainda perde esse contexto. Persistência, resumos e RAG são a etapa 4.
Os contadores registram segundos transcritos, caracteres de voz e tokens informados
pela OpenAI. São medidas de uso; a cobrança oficial deve ser conferida nos painéis.
Cancelamento evita reproduzir respostas antigas, mas pode não desfazer consumo já
processado pelos serviços.

## Referências

- [Cartesia: transcrição de arquivos](https://docs.cartesia.ai/api-reference/stt/transcribe)
- [Cartesia: geração de voz](https://docs.cartesia.ai/api-reference/tts/bytes)
- [Cartesia: planos, incluindo Free](https://www.cartesia.ai/pricing)
- [Cartesia: regras de consumo](https://docs.cartesia.ai/pricing)
- [OpenAI: geração de texto](https://developers.openai.com/api/docs/guides/text)
- [OpenAI: GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)

Na primeira versão Cartesia, o consumo da transcrição dependia do endpoint. A documentação consultada em
8 de outubro de 2026 informa 1 crédito por 2 segundos no batch Ink-Whisper e
aproximadamente 1 crédito por caractere no TTS. Não use a antiga estimativa de
transcrição em tempo real como se fosse a tarifa desta primeira integração.
