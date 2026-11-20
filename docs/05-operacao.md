# 5. Operação

O dia a dia de um número conectado à Evolution. Os comandos rodam no servidor, na pasta do kit. A referência completa dos comandos está em [4. Script](04-script-evo.md); os problemas e as soluções, em [9. Solução de problemas](09-problemas.md).

## Rotina

| Quando | O quê | Como |
| --- | --- | --- |
| Automático, a cada 5 min | Avisar quando uma instância cair | `scripts/monitor.sh` no cron (abaixo) |
| Todo dia | Todas as instâncias em `open`? | `scripts/evo.sh instancias` |
| Antes de um envio grande | Conexão firme? | `estado` + um `teste` para um número da equipe |
| Toda semana | Celular ligado, com internet, WhatsApp atualizado | olhar o aparelho |
| Toda semana | Itens em ERRO, SEM_WHATSAPP ou VERIFICAR | `armazenamento.listar({ status: 'ERRO' })` ou consulta no banco da fila |
| Todo mês | Backup testado (restaurar num lugar de teste) | abaixo |
| A cada atualização | Testar numa instância de teste antes | [Instalação → Atualizar](02-instalacao.md#atualizar-a-evolution) |

O celular do número **precisa ficar ligado e com internet**. Se ficar cerca de 14 dias sem abrir o WhatsApp, os aparelhos conectados (a Evolution) caem.

## Monitoramento

```bash
crontab -e
# avisa quando alguma instância mudar de estado
*/5 * * * * /home/usuario/kit-evolution/scripts/monitor.sh >> /home/usuario/evo-monitor.log 2>&1
```

Com `ALERTA_URL=<url de webhook>` no `docker/.env`, o monitor manda um aviso (`{"text": "...", "content": "..."}`) para Slack, Google Chat, Discord ou o seu sistema **só quando algo muda**, por exemplo "MeuProjeto DESCONECTADA". Sem `ALERTA_URL`, ele só grava no log.

Pelo webhook da própria Evolution, o evento `connection.update` também avisa em tempo real (veja `exemplos/webhook.mjs`).

## Conectar, reconectar e trocar o número

| Situação | Comando |
| --- | --- |
| Primeira conexão | `criar` → `conectar` → ler o QR Code |
| Caiu (`close`) | `conectar` → ler o QR Code |
| Oscilou e não voltou | `reiniciar`; se não voltar em 1 min, `conectar` |
| `logout` falha / sem QR Code | `destravar` → ler o QR Code |
| Trocar o número da instância | `logout` (ou `destravar`) → `conectar` → ler com o celular novo |

Trocar o número **não muda nada no sistema**, porque tudo é feito pelo nome da instância. Mas quem responder no número antigo não chega mais. Se possível, deixe uma resposta automática no celular antigo avisando o número novo.

## Como não ser bloqueado

O modo "aparelho conectado" segue as regras do WhatsApp comum. Números que mandam muito para quem não os conhece são restringidos ou banidos.

- **Público:** mande só para quem conhece e espera a mensagem, como quem foi atendido ou pediu o documento.
- **Volume:** comece devagar com número novo ou recém-desbloqueado. Nos primeiros dias, dezenas de mensagens por dia, não centenas. Aumente aos poucos ao longo de semanas.
- **Ritmo:** mantenha os intervalos da fila (60 a 180 s; 1 mensagem por telefone a cada 10 min) e lotes pequenos. Não rode duas rodadas ao mesmo tempo.
- **Texto:** mensagens diferentes entre si, com o nome da pessoa e a referência dela. Texto idêntico para centenas de números chama atenção.
- **Conversa:** convide a responder. Número que recebe respostas parece legítimo; número que só dispara, não.
- **Links:** evite encurtadores e muitos links na mesma mensagem.
- **Perfil:** foto, nome e descrição preenchidos. Prefira o WhatsApp Business com o perfil da instituição.
- **Sinais de alerta:** se a conexão começar a cair sozinha, ou se muita gente bloquear ou denunciar, **pare os envios** (`cancelarPendentes`) e reveja público e texto.

## Avisos em massa (lista de números)

Para mandar um mesmo aviso para uma lista, como "seu documento está pronto, retire amanhã":

1. Junte quem divide o mesmo telefone numa **mensagem só**, com os nomes de todos. A regra de 1 por telefone a cada 10 min mandaria as mensagens separadas, com 10 min de diferença.
2. Personalize com o primeiro nome. Evite texto 100% igual.
3. Use uma `chave` por pessoa e por aviso, por exemplo `retirada-2026-11-11-<id>`, para não mandar duas vezes se a lista for colocada de novo.
4. Coloque na fila e acompanhe. Com 60 a 180 s entre mensagens, 20 avisos levam de 20 a 60 minutos.

## Emergência: o número caiu ou foi bloqueado no meio de um envio

1. **Pare a fila:** `await fila.cancelarPendentes({ incluirProcessando: true })` e pare o robô ou o cron. Os itens viram CANCELADO; nada sai pelo número novo sem querer.
2. **Guarde a lista** do que foi cancelado (`armazenamento.listar({ status: 'CANCELADO' })`) para reenviar depois.
3. **Veja o celular:** há aviso de restrição? Siga [9. Solução de problemas](09-problemas.md).
4. **Volte devagar:** enfileire de novo em lotes pequenos, só depois que a conexão estiver firme por algumas horas.

## Backups

| O quê | Como | Frequência |
| --- | --- | --- |
| Banco da Evolution | `docker exec evo-postgres pg_dump -U evolution evolution \| gzip > evolution-$(date +%F).sql.gz` | diário |
| Banco da fila | copie o arquivo (`fila.db`) ou faça o dump do banco que você usa | diário |
| `docker/.env` | guarde num cofre de senhas, não junto com os backups | a cada mudança |
| `backups/` (sessões do `destravar`) | contêm a credencial do número: guarde com cuidado e apague as antigas | — |

Restaurar o banco da Evolution:

```bash
cd docker && docker compose stop evolution-api
gunzip -c evolution-2026-11-20.sql.gz | docker exec -i evo-postgres psql -U evolution -d evolution
docker compose start evolution-api
```

Restaurar o banco devolve as instâncias e as sessões daquele dia. Se o número foi reconectado depois do backup, a sessão restaurada não vale mais: rode `conectar`, ou `destravar` se for preciso.
