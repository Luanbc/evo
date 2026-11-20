# 4. Referência do `scripts/evo.sh`

```
scripts/evo.sh <comando> [argumentos]
```

O script lê `AUTHENTICATION_API_KEY` e `EVOLUTION_PORTA` de `docker/.env`. Para outra instalação:

```bash
EVO_URL=http://127.0.0.1:8080 EVO_KEY=<chave> PG_CONTAINER=postgres PG_USER=admin PG_DB=automacao scripts/evo.sh instancias
```

Números aceitam qualquer formato com DDD (`98988887777`, `(98) 98888-7777`, `5598988887777`).

---

### `instancias`

Lista todas as instâncias com estado, final do número e última atualização.

```
$ scripts/evo.sh instancias
MeuProjeto           open        numero: …7777   atualizada: 2026-11-20T18:02:11.000Z
Teste                close       numero: -       atualizada: 2026-11-19T10:15:40.000Z
```

### `estado <instância>`

`open` (conectada), `connecting` (tentando conectar) ou `close` (desconectada).

> Depois de uma queda, o estado pode continuar `open` sem a conexão funcionar. Se as mensagens não saem, mande um `teste`: o erro `Connection Closed` confirma a queda.

### `criar <instância> [url-do-webhook]`

Cria a instância (modo Baileys, ignorando grupos). Com a URL, já liga o webhook. Depois, rode `conectar`.

### `conectar <instância> [número]`

Gera o QR Code e grava em `qrcode-<instância>.png`. Com o número, mostra também um **código de pareamento**, para conectar sem ler QR Code: no celular, **Conectar com número de telefone**. Se a instância já estiver `open`, só avisa.

Se responder "Nenhum QR Code gerado" com `{"count":0}`, a sessão antiga está presa: use `destravar`.

### `logout <instância>`

Desconecta o aparelho (o número sai da lista de aparelhos conectados) e mostra o estado. Use para trocar o número da instância.

Se falhar com `Error: Connection Closed`, a conexão já caiu e a sessão ficou presa: use `destravar`.

### `reiniciar <instância>`

Reinicia a conexão sem deslogar. Resolve oscilações rápidas. Se não voltar para `open` em 1 minuto, use `conectar`.

### `destravar <instância>`

Para quando:
- o `logout` falha com `Connection Closed`;
- o estado fica preso em `open` ou `connecting` sem funcionar;
- o `conectar` não gera QR Code.

O que faz, em ordem:
1. guarda a sessão atual em `backups/sessao-<instância>-<data>.json` (permissão 600);
2. tenta o logout normal;
3. **para a Evolution** (`docker stop`): todas as instâncias caem por alguns segundos;
4. apaga **só a sessão** dessa instância (tabela `Session`) e marca a instância como `close`;
5. liga a Evolution, espera responder e gera o QR Code.

Webhook, configurações, mensagens e as outras instâncias não são tocados. Requer acesso ao Docker (`docker exec`, `docker stop/start`) no servidor.

### `webhook <instância> <url> [EVENTOS]`

Liga o webhook. Eventos padrão: `MESSAGES_UPSERT,MESSAGES_UPDATE,SEND_MESSAGE,CONNECTION_UPDATE`. Para escolher outros, passe a lista separada por vírgula, por exemplo `QRCODE_UPDATED,CONNECTION_UPDATE`.

```bash
scripts/evo.sh webhook MeuProjeto "https://seu-sistema/webhook/whatsapp?token=<segredo>"
```

### `validar <instância> <número>`

Diz se o número tem WhatsApp e mostra o `jid` (o número como o WhatsApp reconhece, às vezes sem o 9).

### `teste <instância> <número> "texto"`

Manda uma mensagem e mostra o id. Recusa se a instância não estiver `open`.

### `ajuda`

Lista os comandos.

## Códigos de saída

O script sai com `1` e uma linha `ERRO: ...` quando falta argumento, a chave não foi encontrada, o número é inválido ou a instância não está conectada (`teste`). Fora isso, mostra a resposta da API e sai com `0`.
