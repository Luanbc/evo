# evo: kit Evolution API (WhatsApp)

Tudo o que é preciso para um sistema **enviar mensagens e documentos pelo WhatsApp** e **receber as respostas**, usando a [Evolution API](https://github.com/EvolutionAPI/evolution-api). Foi separado do Controle CRC-Jud, onde a robô "Rôsinha" entrega certidões pelo WhatsApp, para ser reaproveitado em outros projetos.

- **Instalação:** Evolution API v2.3.7 + Postgres + Redis em Docker, com a versão fixada e a API presa ao próprio servidor.
- **Operação:** `scripts/evo.sh` para criar a instância, gerar QR Code, ver o estado, desconectar, **destravar sessão presa**, ligar o webhook e testar. `scripts/monitor.sh` avisa quando o número cai.
- **Biblioteca** (JavaScript, sem dependências): fila com intervalo entre mensagens, validação do número, proteção contra envio em dobro, conferência do que realmente saiu e leitura do webhook. Roda em Node 18+ e no Cloudflare Workers (D1).

## Documentação

| | |
| --- | --- |
| [1. Visão geral](docs/01-visao-geral.md) | peças, caminho de uma mensagem, situações da fila (com diagramas) |
| [2. Instalação](docs/02-instalacao.md) | passo a passo, proxy com HTTPS, firewall, atualização |
| [3. Configuração](docs/03-configuracao.md) | todas as variáveis, o compose linha a linha, opções da fila |
| [4. Script `evo.sh`](docs/04-script-evo.md) | referência de cada comando |
| [5. Operação](docs/05-operacao.md) | rotina, monitoramento, como não ser bloqueado, emergência, backups |
| [6. Biblioteca](docs/06-biblioteca.md) | referência da API JavaScript, webhook, integrações (Node, Workers, n8n) |
| [7. Segurança e LGPD](docs/07-seguranca-lgpd.md) | chaves, rede, dados pessoais, o que fazer se vazar |
| [8. API da Evolution](docs/08-api-evolution.md) | rotas usadas, eventos do webhook, pegadinhas de produção |
| [9. Solução de problemas](docs/09-problemas.md) | sintoma → causa → solução |

## Começo rápido

No servidor (Linux com Docker):

```bash
git clone https://github.com/Luanbc/evo.git kit-evolution && cd kit-evolution
cp docker/.env.exemplo docker/.env
openssl rand -hex 32     # cole em AUTHENTICATION_API_KEY
openssl rand -hex 24     # cole em POSTGRES_PASSWORD
nano docker/.env && chmod 600 docker/.env
docker compose -f docker/docker-compose.yml up -d

scripts/evo.sh criar MeuProjeto
scripts/evo.sh conectar MeuProjeto      # grava qrcode-MeuProjeto.png; leia no celular em Aparelhos conectados
scripts/evo.sh estado MeuProjeto        # open
scripts/evo.sh teste MeuProjeto 98988887777 "Teste do kit"
```

No sistema que envia (Node 22+ para os exemplos):

```bash
export EVO_URL=http://127.0.0.1:8080 EVO_KEY=<a chave do .env> EVO_INSTANCIA=MeuProjeto
node exemplos/enfileirar.mjs 98988887777 "Olá! Seu documento está pronto." --chave doc-123
node exemplos/robo.mjs            # fica rodando; ou "--uma-vez" num cron a cada 10 min
```

Dentro do seu código:

```js
import { criarCliente, criarValidador, cacheSql, criarFila, armazenamentoSql } from './lib/index.js';

const cliente = criarCliente({ url: process.env.EVO_URL, apiKey: process.env.EVO_KEY, instancia: 'MeuProjeto' });
const fila = criarFila({ armazenamento: armazenamentoSql(db), cliente, validador: criarValidador(cliente, cacheSql(db)) });

await fila.adicionar({ numero: '98988887777', texto: 'Olá, Maria!', chave: 'aviso-123' });
await fila.rodada();   // agendado a cada 10 min
```

## As regras de envio (e por quê)

Cada regra veio de um problema real em produção:

| Regra | Problema que evita |
| --- | --- |
| Confere a conexão antes do lote **e antes de cada mensagem** | Mensagens "enviadas" com o número desconectado, que somem |
| Conexão caiu no meio: o item volta para a fila sem gastar tentativa | Itens presos como "para verificar" depois de uma queda |
| 60 a 180 s entre mensagens, lotes de até 10 | Bloqueio do número por disparo em massa |
| No máximo 1 mensagem a cada 10 min para o mesmo telefone | Família com vários documentos no mesmo número recebendo tudo de uma vez |
| Valida o número antes, com cache | Tentativas repetidas em número sem WhatsApp |
| Chave anti-dobro | A mesma pessoa receber o mesmo documento duas vezes |
| Item travado só volta depois de conferir no WhatsApp | Reenvio às cegas quando o processo cai no meio |

## Estrutura

```
docker/      docker-compose.yml e .env.exemplo
scripts/     evo.sh (operação) e monitor.sh (aviso de queda)
lib/         evolution.js · validador.js · fila.js · armazenamento.js · webhook.js · index.js
exemplos/    robo.mjs · enfileirar.mjs · webhook.mjs
test/        testes com Evolution falsa (npm test)
docs/        documentação completa
```

## Testes

```bash
npm test      # 23 testes, sem WhatsApp de verdade
```

## Segurança

A chave da API dá controle total do número. Ela fica só no `docker/.env` do servidor e nos segredos do sistema que envia, nunca no repositório. A API não é exposta direto na internet, só por proxy com HTTPS. A fila e a Evolution guardam dados pessoais. Detalhes em [7. Segurança e LGPD](docs/07-seguranca-lgpd.md).
