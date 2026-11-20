# 6. Biblioteca de envio

JavaScript (ESM) sem dependências. Roda em Node 18+, Cloudflare Workers, Deno e Bun. Importe de `lib/index.js` ou copie a pasta `lib/` para o seu projeto.

```js
import {
  criarCliente, normalizarNumero, chaveTelefone, ehErroDeConexao,   // lib/evolution.js
  criarValidador, cacheMemoria, cacheSql,                            // lib/validador.js
  criarFila, SITUACOES,                                              // lib/fila.js
  armazenamentoMemoria, armazenamentoSql, deNodeSqlite, ESQUEMA_SQL, // lib/armazenamento.js
  lerEvento, textoDaMensagem, nomeDoEvento, tokenConfere             // lib/webhook.js
} from './lib/index.js';
```

## Cliente (`lib/evolution.js`)

### `criarCliente({ url, apiKey, instancia, timeoutMs = 15000, fetch })`

Cria o cliente de uma instância. `fetch` é opcional (para testes ou ambientes sem `fetch` global).

**Nenhum método lança erro por falha de rede ou da API.** Todos devolvem `{ ok: false, status, erro, dados? }`. Com `status` 0, a API não respondeu.

| Método | Devolve | Observação |
| --- | --- | --- |
| `estado()` | `'open' \| 'connecting' \| 'close' \| null` | `null` = API sem resposta |
| `conectar(numero?)` | `{ ok, base64, pairingCode, count }` | `base64` é o QR em data URL PNG |
| `logout()` | `{ ok, dados }` | falha com "Connection Closed" se a conexão já caiu |
| `reiniciar()` | `{ ok, dados }` | |
| `verificarNumero(tel)` | `{ status, numero, jid, numeroWhatsapp, motivo }` | status: `valido`, `invalido`, `formato_invalido` ou `nao_verificado` (sem resposta) |
| `enviarTexto(tel, texto, { atrasoMs = 1200, digitando = true })` | `{ ok, id }` | `id` = key.id no WhatsApp; mostra "digitando…" antes |
| `enviarDocumento(tel, { media, nomeArquivo, mimetype, legenda })` | `{ ok, id }` | `media`: base64 (com ou sem prefixo `data:`) ou URL pública |
| `mensagensEnviadasPara(jid, desdeSeg, quantidade = 40)` | `{ ok, msgs: [{ id, ts, tipo, arquivo, texto }] }` | só as enviadas por esta instância, desde `desdeSeg` (epoch em segundos) |
| `baixarMidia(idMensagem)` | `{ ok, base64, mimetype, nomeArquivo }` | mídia de uma mensagem recebida ou enviada |
| `chamar(metodo, caminho, corpo?, tempoMs?)` | `{ ok, status, dados, erro }` | para qualquer outra rota da API |

Envie sempre para o `numeroWhatsapp` devolvido pelo `verificarNumero`: ele resolve o 9º dígito dos números antigos.

### Utilitários

| Função | Exemplo |
| --- | --- |
| `normalizarNumero(tel, ddi = '55')` | `'(98) 98888-7777'` → `'5598988887777'`; inválido → `''` |
| `chaveTelefone(tel)` | últimos 8 dígitos; identifica o mesmo telefone com ou sem 9 e DDI |
| `ehErroDeConexao(resposta)` | `true` quando a falha foi queda de conexão ou API fora (vale tentar depois), e não erro do número ou da mensagem |

## Validador (`lib/validador.js`)

### `criarValidador(cliente, cache = cacheMemoria(), { diasValido = 30, diasInvalido = 7 })`

Devolve `validar(tel, { usarCache = true })`, com o mesmo resultado de `verificarNumero` mais `doCache`. Guarda "tem WhatsApp" por 30 dias e "sem WhatsApp" por 7 dias. Cada consulta ao WhatsApp é atividade do número; o cache reduz isso e acelera a fila.

Caches prontos: `cacheMemoria()` e `cacheSql(db)`, que usa a tabela `whatsapp_numeros`. Para outro lugar (Redis, KV), implemente `{ get(numero), set(numero, { existe, jid, verificadoEm }), apagar(numero) }`.

## Fila (`lib/fila.js`)

### `criarFila({ armazenamento, cliente, validador?, opcoes?, agora?, esperar?, log? })`

| Parâmetro | Obrigatório | O que é |
| --- | --- | --- |
| `armazenamento` | sim | onde guardar os itens (abaixo) |
| `cliente` | sim | `criarCliente(...)` |
| `validador` | não | `criarValidador(...)`; sem ele, valida sem cache |
| `opcoes` | não | ver [Configuração → Opções da fila](03-configuracao.md#opções-da-fila) |
| `agora`, `esperar` | não | relógio e espera; trocados nos testes |
| `log` | não | função chamada com o resumo de cada rodada |

### `adicionar({ numero, texto, documento, chave, referencia, reenviar })`

Coloca na fila. Precisa de `texto` ou `documento` (ou os dois: o texto vai primeiro e o documento 6 s depois).

```js
const r = await fila.adicionar({
  numero: '(98) 98888-7777',
  texto: 'Olá, Maria! Sua certidão está pronta. Segue abaixo.',
  documento: { media: pdfBase64, nomeArquivo: 'Certidao_123456.pdf', mimetype: 'application/pdf', legenda: 'Certidão' },
  chave: 'certidao-123456',      // anti-dobro
  referencia: 'solicitacao-987'  // livre
});
```

| Resultado | Quando |
| --- | --- |
| `{ ok: true, id }` | entrou na fila |
| `{ ok: false, motivo: 'ja_na_fila', item }` | a mesma `chave` está PENDENTE, PROCESSANDO ou VERIFICAR |
| `{ ok: false, motivo: 'ja_enviado', item }` | a mesma `chave` já foi ENVIADO |
| `{ ok: false, motivo: 'numero_invalido' }` | sem DDD ou com dígitos a menos |
| `{ ok: false, motivo: 'vazio' }` | sem texto e sem documento |

Com `reenviar: true`, a chave é ignorada e o item entra mesmo que já tenha saído.

**Nome do arquivo:** use um nome que identifique o documento (`Certidao_<protocolo>.pdf`). Quando um item trava, a recuperação reconhece o documento pelo nome. Com nome genérico, ela não sabe se aquele documento saiu.

**Tamanho:** o `documento.media` é guardado no banco da fila. Para PDFs grandes ou muitos itens, guarde o arquivo fora (um storage) e passe uma **URL** em `media`.

### `rodada()`

Faz uma rodada completa e devolve o resumo:

```js
{ travados: { entregues, devolvidos, aguardando, verificar },
  lote, enviados, falhas, semWhatsapp, adiados, parouPorConexao, motivo }
```

1. `recuperarTravados()`;
2. `pegarLote()`: só se a conexão estiver `open`; pula telefones que receberam algo nos últimos 10 min; valida os números;
3. envia um por um com intervalo aleatório, conferindo a conexão antes de cada mensagem. Se a conexão cair, devolve o resto do lote para PENDENTE e para.

Chame de forma agendada: cron, `setInterval`, Cron Trigger, n8n. **Nunca duas rodadas ao mesmo tempo** para a mesma instância.

### Outras funções

| Função | O que faz |
| --- | --- |
| `pegarLote(limite?)` | separa e trava o próximo lote; `{ itens, semWhatsapp, adiados, motivo }` |
| `enviarItem(item)` | envia um item travado; `{ ok }`, `{ ok: false }` ou `{ ok: false, conexao: true }` |
| `recuperarTravados()` | itens em PROCESSANDO há mais de `minutosTrava`: confere no WhatsApp se saíram |
| `cancelarPendentes({ incluirProcessando })` | marca como CANCELADO o que não saiu; devolve quantos |

### Situações (`SITUACOES`)

| Situação | Significado | Ação |
| --- | --- | --- |
| `PENDENTE` | esperando a vez | — |
| `PROCESSANDO` | no lote em andamento | se o processo cair, a próxima rodada confere |
| `ENVIADO` | saiu; `id_mensagem` = id no WhatsApp | — |
| `SEM_WHATSAPP` | número sem conta | corrigir o telefone e enfileirar de novo |
| `ERRO` | falhou `tentativasMax` vezes (não por queda) | ver o campo `erro` |
| `VERIFICAR` | travou e não deu para confirmar | conferir no celular antes de reenviar |
| `CANCELADO` | tirado da fila | — |

## Armazenamento (`lib/armazenamento.js`)

| Pronto | Uso |
| --- | --- |
| `armazenamentoMemoria()` | testes e protótipos |
| `armazenamentoSql(db)` | SQLite ou Cloudflare D1 (`db` no formato D1: `prepare().bind().all/first/run`) |
| `deNodeSqlite(new DatabaseSync('fila.db'))` | faz o `node:sqlite` (Node 22+) falar como D1 |

`armazenamentoSql(db).criarTabelas()` cria as tabelas. Ou rode `ESQUEMA_SQL` na sua migração.

Tabela `fila_whatsapp`: `id`, `chave`, `referencia`, `numero`, `numero_whatsapp`, `texto`, `documento` (JSON), `status`, `tentativas`, `criado_em`, `processando_desde`, `enviado_em`, `id_mensagem`, `erro`. Tabela `whatsapp_numeros`: cache do validador.

### Outro banco

Implemente estes métodos assíncronos (veja `armazenamentoMemoria()` como modelo):

| Método | Contrato |
| --- | --- |
| `inserir(item)` | grava o item |
| `buscarPorChave(chave, situacoes)` | o item mais recente com a chave numa das situações, ou `null` |
| `pendentes(limite)` | PENDENTE por ordem de criação |
| `telefonesRecentes(desdeIso)` | números com item PROCESSANDO ou ENVIADO desde a data |
| `travar(ids, agoraIso)` | PENDENTE → PROCESSANDO (+1 tentativa) **só se ainda estiver PENDENTE**; devolve os ids travados |
| `atualizar(id, campos, statusEsperado?)` | atualiza; com `statusEsperado`, só se o item estiver nele |
| `travadosAntes(limiteIso, limite)` | PROCESSANDO desde antes da data |
| `cancelar(situacoes, agoraIso)` | marca CANCELADO; devolve quantos |
| `listar({ status, limite })` | para telas e relatórios |

O `travar` condicional (`UPDATE ... WHERE id = ? AND status = 'PENDENTE'`) é o que impede dois processos de pegarem o mesmo item.

## Webhook: respostas e avisos de conexão

Ligue com `scripts/evo.sh webhook <inst> "<url>?token=<segredo>"`. A Evolution faz um POST com JSON a cada evento.

### `lerEvento(corpo)`

| `tipo` | Campos | Evento original |
| --- | --- | --- |
| `mensagem_recebida` | `id, jid, numero, nome, texto, tipoMensagem, temMidia, ehGrupo, quando` | `messages.upsert` (fromMe false) |
| `mensagem_enviada` | os mesmos | `messages.upsert` (fromMe true) / `send.message` |
| `status_mensagem` | `id, status` (`DELIVERY_ACK`, `READ`…) | `messages.update` |
| `conexao` | `estado, motivo` | `connection.update` |
| `qrcode` | `base64, pairingCode` | `qrcode.updated` |
| `outro` | `evento` | qualquer outro |

`numero` vem `null` quando o contato aparece como `@lid`, um identificador sem o número que o WhatsApp usa para alguns contatos. Use o `jid` como chave da conversa.

### Segurança do webhook

- Exija um segredo de 32+ caracteres na URL (`?token=`) e confira com `tokenConfere(recebido, esperado)`, que compara em tempo constante e recusa segredo vazio ou curto.
- Responda `200` **logo** e processe depois: a Evolution não deve ficar esperando.
- Limite o tamanho do corpo (o exemplo recusa acima de 5 MB).
- Ignore grupos (`ehGrupo`) se não usa.

Exemplo completo: `exemplos/webhook.mjs`.

## Integrações

### Node (servidor próprio)

`exemplos/robo.mjs` já é um robô completo: SQLite local, rodada a cada `RODADA_MIN` minutos. Para rodar como serviço:

```bash
# com PM2
pm2 start exemplos/robo.mjs --name evo-robo
pm2 save
```

Ou pelo cron, a cada 10 min: `*/10 * * * * cd /caminho/kit-evolution && EVO_URL=... EVO_KEY=... EVO_INSTANCIA=... node exemplos/robo.mjs --uma-vez`.

### Cloudflare Workers + D1

```js
import { criarCliente, criarValidador, cacheSql, criarFila, armazenamentoSql } from './lib/index.js';

function montar(env) {
  const cliente = criarCliente({ url: env.EVO_URL, apiKey: env.EVO_KEY, instancia: env.EVO_INSTANCIA });
  return criarFila({
    armazenamento: armazenamentoSql(env.DB), cliente,
    validador: criarValidador(cliente, cacheSql(env.DB)),
    opcoes: { loteMax: 1 }      // 1 por execução: o intervalo entre mensagens vem do cron
  });
}

export default {
  async fetch(req, env) {                 // POST /enfileirar  { numero, texto, chave }
    if (req.method !== 'POST') return new Response('use POST', { status: 405 });
    const r = await montar(env).adicionar(await req.json());
    return Response.json(r, { status: r.ok ? 201 : 409 });
  },
  async scheduled(evento, env, ctx) {     // wrangler.toml: [triggers] crons = ["*/2 * * * *"]
    ctx.waitUntil(montar(env).rodada());
  }
};
```

No Workers, a rodada não pode ficar esperando de 1 a 3 minutos entre mensagens. Com `loteMax: 1` e um cron a cada 2 ou 3 minutos, o intervalo vem do próprio cron. `EVO_URL` precisa ser o endereço público com HTTPS ([Instalação → proxy](02-instalacao.md#acesso-de-fora-do-servidor-proxy-com-https)). `EVO_KEY` vai como segredo: `wrangler secret put EVO_KEY`. Proteja a rota de enfileirar com autenticação própria.

### n8n ou outra ferramenta

A fila precisa de um processo que chame `rodada()`. Exponha uma rota que faça isso, por exemplo `POST /fila/rodada` protegida por chave, e chame pelo n8n (Schedule Trigger → HTTP Request) a cada 10 minutos. Para disparar na hora depois de enfileirar, chame a mesma rota logo em seguida. A trava evita mensagem repetida, mas não chame em paralelo com o cron.

## Testes

```bash
npm test
```

Rodam com uma Evolution falsa (`test/evolution-falsa.js`), em memória e em SQLite. Cobrem:
- envio de texto e documento;
- anti-dobro;
- intervalo por telefone;
- conexão fora;
- queda no meio do lote;
- número sem WhatsApp;
- erro repetido;
- recuperação de travados;
- cache do validador;
- leitura de eventos do webhook;
- token do webhook.

Para testar o seu código sem WhatsApp, use a mesma Evolution falsa:

```js
import { evolutionFalsa } from './test/evolution-falsa.js';
const evo = evolutionFalsa({ estado: 'open', semWhatsapp: ['5598900000000'] });
const cliente = criarCliente({ url: 'http://x', apiKey: 'chave-teste', instancia: 'T', fetch: evo.fetch });
// evo.s.enviadas = o que "saiu"; evo.s.estado = 'close' simula queda
```
