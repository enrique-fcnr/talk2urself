# Deploy na AWS (Lightsail)

Um servidor só serve a página, a API e as conversas por voz. O Caddy, na frente, cuida do HTTPS (obrigatório para o
microfone). O acesso é restrito por código: só entra quem abrir o site uma vez com `?k=<código>`.

| Peça | Onde |
|---|---|
| Servidor | AWS Lightsail, Linux/Ubuntu 24.04, 1 GB (US$ 7/mês, 3 meses grátis), região `us-east-1` |
| Banco e voz | Supabase, East US (North Virginia) |
| OpenAI e Cartesia | EUA |

## Arquivos

- `deploy/setup.sh`: instala tudo num servidor novo (swap, Node 22, Caddy, usuário do serviço, chave de leitura do
  GitHub, código, build, serviços). Pode rodar de novo a qualquer momento.
- `deploy/update.sh`: atualiza para o último commit da branch e reinicia.
- `deploy/talk2urself.service`: serviço do sistema (reinicia sozinho se cair).
- `deploy/Caddyfile`: HTTPS automático e proxy para o app.

## Primeira instalação

1. Lightsail: instância Linux/Unix, Ubuntu 24.04 LTS, plano de 1 GB com IPv4, `us-east-1`. IP estático anexado.
   Firewall com as portas 22, 80 e 443 abertas.
2. Copie o script para o servidor (o repositório é privado, então ele não pode ser baixado de lá) e rode:
   ```bash
   scp -i <chave-lightsail.pem> deploy/setup.sh ubuntu@<ip>:~
   ssh -i <chave-lightsail.pem> ubuntu@<ip> sudo bash setup.sh
   ```
3. Na primeira vez o script para e mostra uma chave pública: adicione em GitHub > Settings > Deploy keys
   (somente leitura) e rode `sudo bash setup.sh` de novo.
4. Preencha as chaves em `/etc/talk2urself.env` (`sudo nano /etc/talk2urself.env`) e reinicie:
   `sudo systemctl restart talk2urself`.
5. O script termina mostrando o endereço público e o link de acesso. Abra o link uma vez em cada aparelho; o código
   some da barra de endereço e o navegador fica liberado por um ano.

## Domínio próprio

Aponte o domínio (registro A) para o IP estático e rode `sudo DOMAIN=seudominio.com bash /opt/talk2urself/deploy/setup.sh`.
Até lá, o endereço é `<ip-com-traços>.sslip.io`.

## Dia a dia

- Atualizar: `sudo bash /opt/talk2urself/deploy/update.sh`
- Logs: `sudo journalctl -u talk2urself -f` (Caddy: `sudo journalctl -u caddy -f`)
- Trocar o código de acesso (corta todos os navegadores): edite `ACCESS_CODE` em `/etc/talk2urself.env` e reinicie.
- Custos: alerta `talk2urself-mensal` (US$ 10) no AWS Budgets. Limites de gasto também nos painéis da OpenAI e da Cartesia.
