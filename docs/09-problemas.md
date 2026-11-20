# 9. Solução de problemas

Comece sempre por:

```bash
scripts/evo.sh instancias
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --since 30m evolution-api | grep -iE "error|close|logout|conflict" | tail -30
```

## Tabela rápida

| Sintoma | Causa provável | Solução |
| --- | --- | --- |
| `instancias` dá erro 401 | chave errada | confira `AUTHENTICATION_API_KEY` no `.env` e no sistema |
| `instancias` não responde | Evolution parada ou subindo | `docker compose ps`; espere 40 s depois de subir; veja os logs |
| Evolution reinicia sem parar | Postgres fora ou senha errada | `docker compose logs postgres`; a senha do `.env` precisa ser a da criação do banco |
| Estado `close` | número desconectou | `conectar` e ler o QR Code |
| `conectar` responde `{"count":0}` sem QR | sessão antiga presa | `destravar` |
| `logout` falha com `Connection Closed` | conexão já caiu, sessão presa | `destravar` |
| Estado `open`, mas nada sai e `teste` dá `Connection Closed` | estado desatualizado depois de queda | `reiniciar`; se não resolver, `destravar` |
| Conecta, funciona minutos e cai, repetidas vezes | restrição do WhatsApp no número | parar envios, ver o celular, esperar 24–48 h ([abaixo](#o-número-conecta-e-cai-em-seguida)) |
| Celular mostra "conta banida" | bloqueio | [Número banido](#número-banido) |
| QR Code lido, mas o celular diz "não foi possível conectar" | QR expirado ou celular sem internet | `conectar` de novo e ler em até 40 s; ou usar o código de pareamento |
| Fila não envia nada, itens ficam PENDENTE | conexão não está `open` (a fila espera) | ver o estado; o resumo da rodada traz `motivo` |
| Fila manda 1 de 2 itens do mesmo telefone | regra de 1 por telefone a cada 10 min | esperado; o outro sai na rodada seguinte. Para avisos, junte numa mensagem só |
| Item virou SEM_WHATSAPP, mas a pessoa tem WhatsApp | número errado no cadastro, ou validado durante uma oscilação | corrigir o número; apagar o cache (`cacheSql(db).apagar(numero)`) e enfileirar de novo |
| Item ficou VERIFICAR | travou e não deu para conferir | olhar a conversa no celular; se não saiu, `adicionar({ ..., reenviar: true })` |
| Mesma pessoa recebeu duas vezes | enfileirado sem `chave`, ou com `reenviar: true` | use sempre uma `chave` por documento/aviso |
| Documento não chega, texto chega | `media` com prefixo errado, arquivo grande demais ou URL inacessível | base64 puro ou URL pública; para arquivos grandes, prefira URL |
| `findMessages` não acha mensagem que saiu | contato salvo como `@lid`, ou `DATABASE_SAVE_DATA_NEW_MESSAGE=false` | conferir pelo `jid` com `@s.whatsapp.net`; manter o `SAVE_DATA` ligado |
| Webhook não recebe nada | URL inacessível de dentro do Docker | se o sistema está no mesmo servidor, use `172.17.0.1`; teste com `curl` de dentro: `docker exec evolution-api wget -qO- <url>` |
| Webhook recebe, mas o sistema recusa | token diferente | conferir o `?token=` na URL do webhook (`scripts/evo.sh webhook ...`) |

## Casos detalhados

### A sessão presa (o caso mais comum depois de uma queda)

1. `scripts/evo.sh logout MeuProjeto` → `Error: Connection Closed`.
2. `scripts/evo.sh conectar MeuProjeto` → "Nenhum QR Code gerado" (`{"count":0}`).
3. `scripts/evo.sh destravar MeuProjeto` → guarda a sessão, apaga, reinicia e gera o QR Code.
4. Ler o QR Code e conferir com `estado`.

**Por que acontece:** com a conexão caída, a Evolution fica tentando reconectar com as credenciais guardadas. O logout precisa da conexão para avisar o WhatsApp, então falha e não apaga nada. Sem apagar, ela não gera QR Code novo.

### O número conecta e cai em seguida

Observado em produção: depois de um bloqueio, o número conectava, recebia algumas mensagens por 5 a 15 minutos e caía de novo. Isso se repetiu em todas as reconexões do mesmo dia.

1. Abra o WhatsApp no celular: procure aviso de restrição.
2. **Pare os envios:** `cancelarPendentes({ incluirProcessando: true })`.
3. **Não fique reconectando:** cada reconexão seguida reforça o sinal de automação.
4. Atenda pelo próprio celular por 24 a 48 horas.
5. Reconecte uma vez e acompanhe com o `monitor.sh` por algumas horas, sem envios, antes de voltar com volume baixo.

### Número banido

1. Pare a fila e guarde a lista do que não saiu.
2. No celular, o WhatsApp oferece "Solicitar revisão": faça, explicando o uso institucional.
3. Para continuar com outro número na mesma instância: `logout` (ou `destravar`), `conectar` e ler com o celular novo.
4. Número novo: aquecimento de 1 a 2 semanas, com poucas mensagens por dia e só para quem espera.
5. Reveja o que levou ao bloqueio: volume, público, texto repetido ([Operação → Como não ser bloqueado](05-operacao.md#como-não-ser-bloqueado)).

### A fila "parou"

Rode uma rodada à mão e leia o resumo:

```bash
EVO_URL=... EVO_KEY=... EVO_INSTANCIA=... node exemplos/robo.mjs --uma-vez
```

| No resumo | Significa |
| --- | --- |
| `motivo: "WhatsApp close"` | conexão fora; nada é pego |
| `lote: 0` e `adiados > 0` | todos os pendentes são de telefones que receberam algo há menos de 10 min |
| `lote: 0`, `adiados: 0`, sem `motivo` | não há PENDENTE, ou a validação do número não respondeu |
| `parouPorConexao: true` | a conexão caiu no meio; o resto voltou para PENDENTE |
| `travados.aguardando > 0` | itens travados esperando a API responder para conferir |

### Recuperar os itens de uma queda

Se itens ficaram ERRO ou VERIFICAR por uma queda antiga, de antes da regra de devolver para a fila, e você confirmou no celular que não saíram:

```sql
UPDATE fila_whatsapp SET status = 'PENDENTE', tentativas = 0, erro = NULL
WHERE status IN ('ERRO','VERIFICAR') AND processando_desde BETWEEN '2026-11-05T12:36:00Z' AND '2026-11-05T12:49:00Z';
```

Troque o período pelo da queda: veja no log do `monitor.sh` ou no evento `connection.update`.

## Coletar informação para pedir ajuda

```bash
scripts/evo.sh instancias
docker compose -f docker/docker-compose.yml ps
docker compose -f docker/docker-compose.yml logs --since 1h evolution-api | tail -100 > evo-log.txt
```

Antes de mandar o `evo-log.txt` para alguém, **mascare os números de telefone** e confira que não há chaves.
