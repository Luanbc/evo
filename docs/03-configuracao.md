# 3. Configuração

## `.env` (docker/.env)

| Variável | Obrigatória | Exemplo | O que é |
| --- | --- | --- | --- |
| `AUTHENTICATION_API_KEY` | sim | `openssl rand -hex 32` | Chave global da API. Toda chamada leva `apikey: <chave>`. Dá controle total de todas as instâncias. |
| `POSTGRES_PASSWORD` | sim | `openssl rand -hex 24` | Senha do Postgres da Evolution. Defina **antes** da primeira subida: depois que o banco existe, trocar aqui não troca a senha dele. |
| `SERVER_URL` | não | `https://wpp.seu-dominio.com.br` | Endereço público. Aparece em respostas e em links de mídia. |
| `EVOLUTION_PORTA` | não | `8080` | Porta local onde a API escuta (sempre em `127.0.0.1`). |
| `NOME_APARELHO` | não | `Meu Projeto` | Nome que aparece em "Aparelhos conectados" no celular. |

Do lado do sistema que envia (exemplos e sua aplicação):

| Variável | Exemplo | O que é |
| --- | --- | --- |
| `EVO_URL` | `http://127.0.0.1:8080` | Endereço da API (ou do proxy) |
| `EVO_KEY` | a mesma `AUTHENTICATION_API_KEY` | Chave da API |
| `EVO_INSTANCIA` | `MeuProjeto` | Instância que envia |
| `FILA_DB` | `fila.db` | Arquivo SQLite da fila (exemplos) |
| `RODADA_MIN` | `10` | Minutos entre rodadas do robô de exemplo |
| `LOTE` | `10` | Mensagens por rodada |
| `INTERVALO_MIN_SEG` / `INTERVALO_MAX_SEG` | `60` / `180` | Espera aleatória entre mensagens |
| `WEBHOOK_TOKEN` | 32+ caracteres | Segredo que o webhook de exemplo exige em `?token=` |

O `scripts/evo.sh` aceita `EVO_URL`, `EVO_KEY`, `ENV_ARQ` (outro `.env`), `PG_CONTAINER`, `PG_USER`, `PG_DB` e `EVO_CONTAINER` para funcionar com outra instalação, como a do Controle CRC-Jud, que usa outros nomes de container.

## O que cada linha do compose faz

| Configuração | Valor | Por quê |
| --- | --- | --- |
| `image` | digest da v2.3.7 | Versão testada em produção; não muda num `pull` |
| `ports` | `127.0.0.1:8080:8080` | API acessível só de dentro do servidor |
| `DATABASE_PROVIDER` / `DATABASE_CONNECTION_URI` | Postgres do próprio compose | Instâncias, sessões e mensagens persistem |
| `DATABASE_SAVE_DATA_*` | `true` | Guarda mensagens, contatos e chats, o que a conferência de envio precisa (`findMessages`) |
| `REDIS_URI` / `CACHE_REDIS_*` | Redis do compose, bancos 1 e 2 | Cache da Evolution |
| `CACHE_LOCAL_ENABLED` | `false` | Evita cache duplicado em memória |
| `WEBSOCKET_ENABLED` | `false` | Não usado; eventos vão por webhook |
| `CHATWOOT_ENABLED` | `false` | Fora do escopo do kit; ponha `true` se for ligar um Chatwoot |
| `DEL_INSTANCE` | `false` | A Evolution **não** apaga sozinha instância desconectada |
| `QRCODE_LIMIT` | `30` | Quantos QR Codes seguidos ela gera antes de desistir |
| `CONFIG_SESSION_PHONE_CLIENT` / `_NAME` | `NOME_APARELHO` / `Chrome` | Como o aparelho aparece no celular |
| `LOG_LEVEL` | `ERROR,WARN,INFO` | Logs úteis sem excesso (`docker compose logs evolution-api`) |
| `healthcheck` do Postgres | `pg_isready` | A Evolution só sobe depois do banco estar pronto |

## Volumes (pastas de dados)

| Pasta | Conteúdo | Backup? |
| --- | --- | --- |
| `docker/dados/postgres` | instâncias, sessão (credencial do número), mensagens, contatos | **sim** |
| `docker/dados/redis` | cache | não precisa |

As duas ficam fora do repositório pelo `.gitignore`.

## Opções da criação de instância

O `scripts/evo.sh criar` usa estes valores, que você pode mudar no script:

| Opção | Valor | Efeito |
| --- | --- | --- |
| `integration` | `WHATSAPP-BAILEYS` | Modo "aparelho conectado" |
| `qrcode` | `true` | Gera QR Code na criação |
| `groupsIgnore` | `true` | Ignora mensagens de grupos (menos tráfego e menos webhook) |
| `rejectCall` | `false` | Não recusa ligações automaticamente |
| `alwaysOnline` | `false` | Não fica "online" o tempo todo. Ficar online sempre parece robô. |
| `readMessages` | `false` | Não marca como lida automaticamente |
| `syncFullHistory` | `false` | Não baixa o histórico inteiro ao conectar |

## Opções da fila

| Opção | Padrão | Efeito |
| --- | --- | --- |
| `loteMax` | 10 | Mensagens por rodada |
| `intervaloMinSeg` / `intervaloMaxSeg` | 60 / 180 | Espera aleatória entre mensagens |
| `intervaloMesmoNumeroMin` | 10 | Mesmo telefone: no máximo 1 mensagem nesse intervalo |
| `tentativasMax` | 3 | Falhas (sem contar quedas de conexão) até virar ERRO |
| `minutosTrava` | 45 | Item em PROCESSANDO há mais que isso = processo caiu |
| `horasParaVerificar` | 6 | Travado sem como conferir por tanto tempo → VERIFICAR |
| `validarAntes` | true | Confere se o número tem WhatsApp antes de enviar |

O validador (`criarValidador`) aceita `diasValido` (30) e `diasInvalido` (7).
