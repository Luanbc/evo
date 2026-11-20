# 2. Instalação

## Requisitos

| Item | Mínimo | Observação |
| --- | --- | --- |
| Servidor | Linux 64 bits, 2 GB de RAM, 10 GB de disco | Ubuntu 22.04/24.04 testado |
| Docker | 24+ com Docker Compose v2 (`docker compose`) | |
| Ferramentas | `curl`, `python3`, `openssl` | usadas pelo `scripts/evo.sh` |
| Node.js (no sistema que envia) | 18+ para a biblioteca; 22+ para os exemplos com SQLite | |
| Celular | WhatsApp ou WhatsApp Business com o número | precisa ficar ligado e com internet |
| Domínio (opcional) | um subdomínio, ex.: `wpp.seu-dominio.com.br` | só se o sistema que envia estiver em outro servidor |

## Passo a passo

### 1. Baixar o kit no servidor

```bash
git clone https://github.com/Luanbc/evo.git kit-evolution
cd kit-evolution
chmod +x scripts/evo.sh
```

### 2. Configurar

```bash
cd docker
cp .env.exemplo .env
openssl rand -hex 32     # copie para AUTHENTICATION_API_KEY
openssl rand -hex 24     # copie para POSTGRES_PASSWORD
nano .env                # cole os valores; ajuste SERVER_URL e NOME_APARELHO
chmod 600 .env
```

Cada variável está explicada em [Configuração](03-configuracao.md).

### 3. Subir

```bash
docker compose up -d
docker compose ps        # evo-postgres (healthy), evo-redis e evolution-api: "running"
docker compose logs -f evolution-api    # Ctrl+C para sair; procure por erros de banco
```

Na primeira vez, a Evolution cria as tabelas no Postgres e leva de 20 a 40 segundos para responder.

### 4. Testar a API

```bash
cd ..
scripts/evo.sh instancias     # sem erro = a chave e a API estão certas (lista vazia na primeira vez)
```

### 5. Criar a instância e conectar o número

```bash
scripts/evo.sh criar MeuProjeto
scripts/evo.sh conectar MeuProjeto
```

O `conectar` grava `qrcode-MeuProjeto.png`. Para ver o QR Code:

- **Copie para o seu computador** (`scp servidor:kit-evolution/qrcode-MeuProjeto.png .`) e abra.
- **Ou use o código de pareamento**: `scripts/evo.sh conectar MeuProjeto 98988887777` mostra um código de 8 letras. No celular, vá em **WhatsApp → Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone** e digite o código.

O QR Code vale uns 40 segundos. Se expirar, rode `conectar` de novo. Depois de conectar:

```bash
scripts/evo.sh estado MeuProjeto              # open
scripts/evo.sh teste MeuProjeto 98988887777 "Teste do kit"
```

### 6. (Opcional) Ligar o webhook

Só é preciso para receber respostas e avisos de queda de conexão. Veja [Biblioteca → Webhook](06-biblioteca.md#webhook-respostas-e-avisos-de-conexão).

```bash
scripts/evo.sh webhook MeuProjeto "https://seu-sistema/webhook/whatsapp?token=<segredo>"
```

## Acesso de fora do servidor (proxy com HTTPS)

A API fica presa a `127.0.0.1:8080`. Se o sistema que envia roda **no mesmo servidor**, use `http://127.0.0.1:8080` e pule esta parte. Se roda **em outro lugar** (Cloudflare Workers, outro servidor), publique a API por um proxy com HTTPS. Nunca abra a porta 8080 direto.

### Caddy (mais simples: o HTTPS é automático)

```caddyfile
wpp.seu-dominio.com.br {
    reverse_proxy 127.0.0.1:8080
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name wpp.seu-dominio.com.br;
    ssl_certificate     /etc/letsencrypt/live/wpp.seu-dominio.com.br/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/wpp.seu-dominio.com.br/privkey.pem;
    client_max_body_size 50m;            # documentos em base64
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 120s;
    }
}
```

### Nginx Proxy Manager (painel web)

Proxy Host novo: domínio `wpp.seu-dominio.com.br`, destino `http` + IP do servidor + porta `8080`, aba SSL com "Request a new certificate" e "Force SSL". Se o NPM roda em Docker, o destino é `172.17.0.1` (o servidor visto de dentro do Docker). Nesse caso, troque no compose `127.0.0.1:${EVOLUTION_PORTA}:8080` por `172.17.0.1:${EVOLUTION_PORTA}:8080`.

### Cloudflare Tunnel (sem abrir porta nenhuma)

```yaml
# /etc/cloudflared/config.yml
tunnel: <id-do-túnel>
credentials-file: /etc/cloudflared/<id-do-túnel>.json
ingress:
  - hostname: wpp.seu-dominio.com.br
    service: http://127.0.0.1:8080
  - service: http_status:404
```

Depois de publicar, ponha o endereço em `SERVER_URL` no `.env` e rode `docker compose up -d` para aplicar.

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp        # só se usar Caddy/Nginx/NPM
sudo ufw enable
```

A 8080 não precisa estar liberada, porque a API está presa a `127.0.0.1`.

## Atualizar a Evolution

A imagem está fixada por **digest**, para não mudar sozinha. Para atualizar:

1. Leia as notas da versão nova em <https://github.com/EvolutionAPI/evolution-api/releases>.
2. Faça backup do Postgres (veja [Operação → Backups](05-operacao.md#backups)).
3. Troque a linha `image:` no compose, por exemplo `evoapicloud/evolution-api:v2.3.8`, e depois fixe o digest que o `docker compose pull` mostrar.
4. `docker compose up -d` e confira com `scripts/evo.sh instancias` e um `teste`.
5. Se algo der errado, volte a linha `image:` antiga e rode `docker compose up -d`.

Teste antes numa instância com um número de teste. Mudanças na Evolution já alteraram o formato de respostas, como a do `findMessages`.

## Desinstalar

```bash
cd docker
docker compose down             # para tudo; os dados ficam em docker/dados
rm -rf dados                    # apaga instâncias, sessões e mensagens (sem volta)
```

Antes, rode `scripts/evo.sh logout <instância>` para o número sair da lista de aparelhos conectados.
