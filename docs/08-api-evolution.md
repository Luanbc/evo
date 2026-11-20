# 8. Rotas da Evolution API v2 usadas pelo kit

Todas as chamadas levam o cabeçalho `apikey: <AUTHENTICATION_API_KEY>`. `{inst}` é o nome da instância.

| Para quê | Rota | Corpo | Resposta (o que importa) |
| --- | --- | --- | --- |
| Estado da conexão | `GET /instance/connectionState/{inst}` | — | `{ instance: { state: "open" \| "connecting" \| "close" } }` |
| Listar instâncias | `GET /instance/fetchInstances` | — | `[{ name, connectionStatus, ownerJid, updatedAt }]` |
| Criar instância | `POST /instance/create` | `{ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true }` | `{ instance: { instanceName, status } }` |
| QR Code | `GET /instance/connect/{inst}` (`?number=55…` para código de pareamento) | — | `{ base64: "data:image/png;base64,…", pairingCode, count }` |
| Desconectar | `DELETE /instance/logout/{inst}` | — | `{ status: "SUCCESS" }` |
| Reiniciar conexão | `POST /instance/restart/{inst}` | — | `{ instance: { state } }` |
| Validar número | `POST /chat/whatsappNumbers/{inst}` | `{ numbers: ["5598988887777"] }` | `[{ exists, jid, number }]` |
| Enviar texto | `POST /message/sendText/{inst}` | `{ number, text, delay }` | `{ key: { id, remoteJid, fromMe } }` |
| Enviar documento | `POST /message/sendMedia/{inst}` | `{ number, mediatype: "document", mimetype, fileName, media, caption? }` | `{ key: { id } }` |
| Buscar mensagens | `POST /chat/findMessages/{inst}` | `{ where: { key: { remoteJid } }, page, offset }` | `{ messages: { records: [...] } }` (mais recentes primeiro) |
| Baixar mídia | `POST /chat/getBase64FromMediaMessage/{inst}` | `{ message: { key: { id } }, convertToMp4: false }` | `{ base64, mimetype, fileName }` |
| Webhook | `POST /webhook/set/{inst}` | `{ webhook: { enabled, url, events: [...], byEvents, base64 } }` | `{ url, events }` |

## Pegadinhas encontradas em produção

- **O estado pode mentir.** Depois de uma queda, `connectionState` pode continuar dizendo `open` enquanto o envio responde `Error: Connection Closed` (HTTP 500 ou 428). Por isso a fila trata esse erro como **queda de conexão**: o item volta para a fila sem gastar tentativa e a rodada para.
- **O logout precisa da conexão.** Com a conexão caída, `logout` falha com `Connection Closed` e a sessão antiga fica guardada. Aí o `connect` devolve só `{ count: 0 }`, sem QR Code. A saída é apagar a sessão: veja `destravar` em [4. Script](04-script-evo.md#destravar-instância).
- **9º dígito.** Números antigos podem estar no WhatsApp sem o 9. Use o `jid` devolvido por `whatsappNumbers`, que já vem certo, para enviar e para buscar mensagens. A fila faz isso (`numero_whatsapp`).
- **`media` em base64 vai sem o prefixo** `data:application/pdf;base64,`. O cliente tira o prefixo sozinho.
- **Formato do `findMessages`.** Na v2.3 a lista vem em `messages.records`. Versões antigas devolviam um array direto. O cliente aceita os dois.
- **Mensagens de grupo e `@lid`.** Contatos novos podem aparecer como `<id>@lid` em vez do número. Para conferir envios, busque pelo `jid` do número (`<55…>@s.whatsapp.net`).
- **`DEL_INSTANCE=false`** no compose impede que a Evolution apague sozinha uma instância que ficou desconectada.
- **Não use `DELETE /instance/delete`** para "resetar": isso apaga a instância inteira, com webhook e configurações. Para trocar de número ou destravar, use `logout` ou `destravar`.

## Exemplos de chamada

```bash
K="apikey: $AUTHENTICATION_API_KEY"; U=http://127.0.0.1:8080; I=MeuProjeto

curl -s -H "$K" $U/instance/connectionState/$I
curl -s -H "$K" -H "Content-Type: application/json" -X POST $U/chat/whatsappNumbers/$I -d '{"numbers":["5598988887777"]}'
curl -s -H "$K" -H "Content-Type: application/json" -X POST $U/message/sendText/$I -d '{"number":"5598988887777","text":"Olá!","delay":1200}'
curl -s -H "$K" -H "Content-Type: application/json" -X POST $U/message/sendMedia/$I \
     -d "{\"number\":\"5598988887777\",\"mediatype\":\"document\",\"mimetype\":\"application/pdf\",\"fileName\":\"doc.pdf\",\"media\":\"$(base64 -w0 doc.pdf)\"}"
```

Respostas de erro típicas:

```json
{ "status": 500, "error": "Internal Server Error", "response": { "message": ["Error: Connection Closed"] } }
{ "status": 401, "error": "Unauthorized", "response": { "message": "Unauthorized" } }
{ "status": 404, "error": "Not Found", "response": { "message": ["The \"MeuProjeto\" instance does not exist"] } }
```

## Eventos do webhook (corpo do POST)

Com `byEvents: false` (o padrão do kit), todos os eventos vão para a mesma URL. O campo `event` diz qual é.

**Mensagem recebida** (`messages.upsert`):

```json
{
  "event": "messages.upsert",
  "instance": "MeuProjeto",
  "data": {
    "key": { "remoteJid": "5598988887777@s.whatsapp.net", "fromMe": false, "id": "3EB0C767D26A1D3A1A2B" },
    "pushName": "Maria",
    "message": { "conversation": "1" },
    "messageType": "conversation",
    "messageTimestamp": 1795000000
  },
  "date_time": "2026-11-20T10:00:00.000Z",
  "sender": "5598900000000@s.whatsapp.net",
  "apikey": "<token da instância>"
}
```

**Conexão** (`connection.update`): `{ "event": "connection.update", "instance": "MeuProjeto", "data": { "state": "close", "statusReason": 401 } }`. O `statusReason` 401 costuma indicar que o aparelho foi desconectado pelo celular ou pelo WhatsApp (logout ou banimento).

**Status de entrega** (`messages.update`): `{ "data": { "keyId": "3EB0…", "remoteJid": "…", "status": "DELIVERY_ACK" } }`. Status possíveis: `SERVER_ACK` (chegou ao servidor), `DELIVERY_ACK` (chegou ao celular), `READ` (lida) e `PLAYED` (áudio ouvido).

Os corpos trazem um campo `apikey` com o token da instância. Não registre o corpo inteiro em log.
