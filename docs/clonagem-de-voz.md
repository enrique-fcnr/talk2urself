# Talk2urself — clonagem automática da voz

A Kelly passa a falar com a voz do próprio usuário, aprendida das falas dele durante as conversas. Usa a clonagem instantânea da Cartesia (sem clonagem profissional). **Desligada por padrão.**

## Como ligar

1. Plano da Cartesia com clonagem instantânea (Pro ou acima; o Free não clona).
2. No `.env` (local) ou em `/etc/talk2urself.env` no servidor (docs/deploy-aws.md): `CARTESIA_PAUSED=0` e `VOICE_CLONING=1`. Supabase precisa estar configurado (as amostras ficam no Storage).
3. Reiniciar o servidor. O log mostra "Clonagem de voz ligada".

Com `VOICE_CLONING=0` (ou voz pausada) nada é coletado, nenhuma rota faz trabalho e a Kelly usa `CARTESIA_VOICE_ID`.

## Ciclo

| Fala limpa acumulada | O que acontece |
|---|---|
| ~2,5 min | Primeira clonagem; a Kelly passa a usar a voz nova |
| ~10 min | Reclonagem com as melhores falas |
| ~20 min | Reclonagem final; a voz congela |

- **Coleta.** Depois que a transcrição confirma que houve fala, a página converte a gravação do turno em WAV 16 kHz mono e envia para `/api/voice/sample`.
- **Filtro.** O servidor aceita só falas de 3 a 30 s, com volume suficiente, sem estouro (clipping), com fala na maior parte do tempo e fundo silencioso (relação sinal/ruído ≥ ~18 dB). As rejeitadas não são guardadas.
- **Armazenamento.** Bucket privado `talk-voice` no Supabase Storage, pasta do `LOCAL_USER_ID`: `takes/*.wav`, `state.json` e, no fim, `final.wav`. Entre clonagens ficam só as melhores falas (até ~90 s); o resto é apagado na hora.
- **Clonagem.** A Cartesia aceita um único clipe: o servidor junta as melhores falas até 60 s, com pausas curtas, e envia para `POST /voices/clone` (idioma `pt`). A voz anterior é apagada na Cartesia quando a nova fica pronta.
- **Congelamento.** Após a terceira clonagem, todas as falas cruas são apagadas; fica só `final.wav`, o clipe da voz final.
- **Refazer minha voz** (Configurações): apaga a voz na Cartesia, as falas e o `final.wav`, e recomeça a coleta do zero. Pede confirmação.

## Custos

Criar o clone é grátis; a fala custa o mesmo crédito por caractere que uma voz do catálogo. O Storage usa poucos MB.

## Onde está no código

| Peça | Arquivo |
|---|---|
| Configuração, filtro de qualidade, WAV, armazenamento e clonagem | `apps/server/src/voice-clone.ts` |
| Rotas `/api/voice`, `/api/voice/sample`, `/api/voice/reset` e status em `/api/health` | `apps/server/src/app.ts` |
| A voz clonada substitui `CARTESIA_VOICE_ID` na fala | `currentVoice` em `apps/server/src/voice.ts`, ligado em `index.ts` |
| Conversão da gravação em WAV e envio | `apps/web/src/voice-sample.ts`, `useConversation.ts` |
| Botão "Refazer minha voz" | `apps/web/src/App.tsx` |
| Testes | `voice-clone.test.ts`, `app.test.ts` |
