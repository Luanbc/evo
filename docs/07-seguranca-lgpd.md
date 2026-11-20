# 7. Segurança e LGPD

## O que precisa ser protegido

| Item | Onde fica | Risco se vazar | Como proteger |
| --- | --- | --- | --- |
| `AUTHENTICATION_API_KEY` | `docker/.env` e segredos do sistema que envia | Controle total do número: enviar, ler conversas, desconectar | `.env` com `chmod 600`, fora do repositório; segredo do Workers ou variável de ambiente no sistema; troque se suspeitar |
| `POSTGRES_PASSWORD` | `docker/.env` | Acesso ao banco com sessões e mensagens | Banco sem porta exposta (só a rede interna do Docker) |
| Sessão do número | Postgres (`Session`) e `backups/` | Quem tiver a sessão pode agir como o número | Backups com acesso restrito; apague cópias antigas do `destravar` |
| Mensagens e contatos | Postgres da Evolution | Dados pessoais de terceiros | Acesso ao servidor restrito; backups criptografados |
| Fila | banco da fila | Telefones e textos (dados pessoais) | Mesmo cuidado de qualquer banco com dados pessoais |
| Token do webhook | URL configurada na Evolution | Alguém forjar eventos no seu sistema | 32+ caracteres aleatórios; `tokenConfere`; HTTPS |

## Rede

- A API escuta só em `127.0.0.1`. Para fora, **só por proxy com HTTPS** ([Instalação](02-instalacao.md#acesso-de-fora-do-servidor-proxy-com-https)).
- Postgres e Redis **não têm porta publicada**: só a Evolution fala com eles, pela rede interna do Docker.
- Se usar Cloudflare Tunnel, dá para limitar quem acessa `wpp.` com uma política de acesso da Cloudflare, por IP ou por token de serviço.
- O webhook deve apontar para um endereço HTTPS, ou para `172.17.0.1` se o sistema estiver no mesmo servidor.

## Chaves

- Gere com `openssl rand -hex 32`. Nunca use chave curta ou repetida de outro sistema.
- Nunca coloque chave em código, planilha, e-mail ou chat. O `.gitignore` do kit já exclui `.env`, `backups/`, `qrcode-*.png` e bancos SQLite.
- **Trocar a chave da API:** mude `AUTHENTICATION_API_KEY` no `.env`, rode `docker compose up -d` e atualize os sistemas que usam. As instâncias continuam conectadas.
- Antes de cada envio para o repositório, confira se nenhum segredo entrou: `git diff --cached | grep -iE "apikey|senha|password|token"`.

## LGPD

O envio de documentos e avisos por WhatsApp trata dados pessoais: nome, telefone e, às vezes, dados sensíveis no documento.

- **Finalidade:** mande só o que a pessoa espera receber, ligado ao atendimento dela. Avisos em massa só para quem tem relação com o serviço.
- **Mínimo necessário:** a mensagem não deve expor mais do que o preciso. Documento sensível vai só para o número cadastrado pela própria pessoa.
- **Telefone compartilhado:** famílias costumam usar o mesmo número. Confirme antes de mandar documento de uma pessoa para o telefone de outra.
- **Retenção:** defina por quanto tempo guardar a fila, as mensagens da Evolution e os backups, e apague o que passar disso. Exemplo de limpeza da fila:
  ```sql
  -- remove o conteúdo de itens antigos já resolvidos, mantendo o registro do envio
  UPDATE fila_whatsapp SET texto = NULL, documento = NULL
  WHERE status IN ('ENVIADO','CANCELADO','SEM_WHATSAPP') AND criado_em < date('now','-180 days');
  ```
- **Registro:** a fila guarda quando cada mensagem saiu e o id no WhatsApp (`enviado_em`, `id_mensagem`). Isso serve para comprovar a entrega.
- **Logs:** não registre texto de mensagem nem documento em log. Os exemplos registram só o resumo da rodada e, no webhook, o texto recebido; ajuste conforme a sua política.
- **Acesso:** quem acessa o servidor e o banco deve ser o mínimo de pessoas, com contas próprias.
- **Ferramentas de IA:** ao pedir ajuda com problemas, mascare telefones (só os 4 últimos dígitos) e nunca cole chaves ou documentos.

## Se algo vazar

1. **Chave da API:** troque já (veja acima) e confira em `scripts/evo.sh instancias` se apareceu instância estranha.
2. **Sessão do número:** rode `logout` ou `destravar` e reconecte. No celular, em **Aparelhos conectados**, desconecte tudo o que não reconhecer.
3. **Dados pessoais:** comunique o encarregado de dados (DPO) da instituição, que avalia a comunicação à ANPD e aos titulares.
