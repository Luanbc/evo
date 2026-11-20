# 0. Preparar o servidor (do zero)

Este capítulo leva um servidor **Ubuntu Server 22.04 ou 24.04 recém-criado** até o ponto de rodar o kit. Ele cobre:

- usuário próprio e acesso por **chave SSH**, com o login por senha desligado;
- fuso horário, **atualizações automáticas** e **memória swap**;
- **Docker** e **Docker Compose** pelo repositório oficial;
- firewall e proteção contra tentativas de senha (fail2ban);
- o **domínio** apontado para o servidor.

Leva uns 30 minutos. Os passos 1 a 4 precisam ser feitos na ordem: **não desligue o login por senha antes de confirmar que a chave funciona** (passo 4.5), ou você pode ficar trancado fora do servidor.

> Há um script que faz os passos 2, 3, 5, 6 e 7 automaticamente: [`scripts/preparar-servidor.sh`](#atalho-o-script-preparar-servidorsh). Ainda assim, vale ler este capítulo para entender o que ele faz.

## Antes de começar

Você vai precisar de:

| Item | Onde conseguir |
| --- | --- |
| Endereço IP do servidor | painel do provedor (ou equipe de TI, se for servidor interno) |
| Acesso inicial | usuário `root` com senha, ou um usuário com `sudo` (depende do provedor) |
| Um computador com terminal | Windows 10/11 já tem o `ssh` no **PowerShell**; Linux e macOS também |
| Domínio (opcional) | acesso ao painel de DNS do domínio (Registro.br, Cloudflare, provedor, TI) |

Tamanho recomendado: **2 vCPU, 2 GB de RAM, 20 GB de disco**. Com 1 GB de RAM funciona, mas a swap do passo 3.3 passa a ser obrigatória.

Nos exemplos:
- `203.0.113.10` é o IP do servidor;
- `deploy` é o usuário que vamos criar;
- `wpp.seu-dominio.com.br` é o domínio da API.

Troque pelos seus.

---

## 1. Primeiro acesso

No seu computador (PowerShell no Windows):

```bash
ssh root@203.0.113.10
```

- Na primeira vez, ele pergunta se confia no servidor (`Are you sure you want to continue connecting`). Digite `yes`.
- Se o provedor criou um usuário em vez do root (por exemplo `ubuntu`), use `ssh ubuntu@203.0.113.10` e coloque `sudo` na frente dos comandos deste capítulo.

Confira a versão:

```bash
lsb_release -a        # Ubuntu 22.04 ou 24.04
uname -m              # x86_64 (ou aarch64 em servidores ARM; o Docker funciona nos dois)
```

Atualize tudo antes de mexer em qualquer coisa:

```bash
apt update && apt full-upgrade -y
apt install -y curl ca-certificates gnupg git python3 openssl nano ufw fail2ban unattended-upgrades dnsutils
```

Se ele avisar que precisa reiniciar (`*** System restart required ***`), rode `reboot`, espere 1 minuto e entre de novo.

---

## 2. Usuário próprio

Trabalhar como `root` o tempo todo é arriscado: um comando errado apaga o servidor. Crie um usuário com permissão de administrador (`sudo`):

```bash
adduser deploy                 # pede uma senha (guarde: o sudo vai pedir) e dados opcionais (pode dar Enter)
usermod -aG sudo deploy        # dá permissão de administrador
```

Teste numa **segunda janela** do terminal, sem fechar a primeira:

```bash
ssh deploy@203.0.113.10
sudo whoami                    # pede a senha do deploy e responde "root"
```

---

## 3. Fuso horário, atualizações automáticas e swap

### 3.1 Fuso horário

O fuso horário afeta os logs, o cron do monitor e os horários dos backups.

```bash
sudo timedatectl set-timezone America/Sao_Paulo
timedatectl                    # "Time zone: America/Sao_Paulo (-03, -0300)" e "System clock synchronized: yes"
```

Se `System clock synchronized` estiver `no`: `sudo timedatectl set-ntp true`.

Os containers do kit gravam datas em UTC (padrão do Docker e da Evolution). Isso é normal: as datas em ISO (`2026-11-20T21:00:00Z`) já trazem o fuso.

### 3.2 Atualizações automáticas de segurança

```bash
sudo dpkg-reconfigure -plow unattended-upgrades      # responda "Yes"
```

Para o servidor reiniciar sozinho de madrugada quando uma atualização exigir:

```bash
sudo tee /etc/apt/apt.conf.d/52reinicio-automatico >/dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
```

Confira:

```bash
sudo unattended-upgrade --dry-run --debug 2>&1 | tail -5     # sem erros
systemctl status unattended-upgrades --no-pager | head -3     # active (running)
```

Os containers têm `restart: unless-stopped` e voltam sozinhos depois de um reinício. A instância do WhatsApp reconecta sozinha: não precisa ler o QR Code de novo.

> Se preferir controlar os reinícios (por exemplo, para não derrubar envios em horário de atendimento), deixe `Automatic-Reboot "false"` e reinicie à mão quando aparecer `/var/run/reboot-required`.

### 3.3 Memória swap

A swap é uma área do disco usada como memória de reserva. Com 2 GB de RAM, Evolution, Postgres e Redis cabem, mas picos (atualização de imagem, muitas mídias) podem esgotar a memória. Sem swap, o sistema mata um processo, geralmente o Postgres ou a Evolution.

Veja se já existe:

```bash
swapon --show          # vazio = sem swap
free -h
```

Crie uma de 2 GB (use 1 GB se o disco for pequeno; 4 GB se o servidor tiver 1 GB de RAM):

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab      # liga sozinha depois de reiniciar
```

Para o sistema usar a swap só quando realmente precisar:

```bash
echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-swap.conf
sudo sysctl --system >/dev/null
```

Confira com `swapon --show` (deve listar `/swapfile 2G`) e `cat /proc/sys/vm/swappiness` (deve dizer `10`).

---

## 4. Acesso por chave SSH e desligar o login por senha

Senha pode ser adivinhada: servidores na internet recebem milhares de tentativas por dia. A chave SSH é um par de arquivos:

- a parte **privada** fica só no seu computador;
- a parte **pública** vai para o servidor.

### 4.1 Criar a chave (no seu computador)

PowerShell (Windows), Linux ou macOS:

```bash
ssh-keygen -t ed25519 -C "seu-nome@computador"
```

- Pode aceitar o local padrão (Enter).
- **Ponha uma frase-senha (passphrase)**: se alguém copiar o arquivo, não consegue usá-lo sem ela.

Isso cria dois arquivos:

| Arquivo | O que é | Pode compartilhar? |
| --- | --- | --- |
| `~/.ssh/id_ed25519` (Windows: `C:\Users\<você>\.ssh\id_ed25519`) | chave **privada** | **nunca** |
| `~/.ssh/id_ed25519.pub` | chave **pública** | sim, é ela que vai para o servidor |

Se já tiver uma chave, use a existente. Não sobrescreva: o `ssh-keygen` pergunta antes.

### 4.2 Enviar a chave pública para o servidor

**Linux/macOS:**

```bash
ssh-copy-id deploy@203.0.113.10
```

**Windows (PowerShell),** que não tem `ssh-copy-id`:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh deploy@203.0.113.10 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Pede a senha do `deploy` uma última vez.

Para dar acesso a outra pessoa da equipe: peça a chave **pública** dela (o `.pub`) e acrescente uma linha em `/home/deploy/.ssh/authorized_keys`. Cada pessoa tem a sua chave. Nunca compartilhe a mesma chave privada.

### 4.3 Testar a chave

Em uma **nova janela**:

```bash
ssh deploy@203.0.113.10
```

Deve entrar **sem pedir a senha do servidor**. Se você pôs passphrase, ele pede a passphrase da chave, que é diferente. Se pedir a senha do servidor, a chave não foi aceita: **pare aqui** e veja [Problemas no acesso](#problemas-no-acesso).

### 4.4 Atalho no seu computador (opcional)

No arquivo `~/.ssh/config` (Windows: `C:\Users\<você>\.ssh\config`, sem extensão):

```
Host evo
    HostName 203.0.113.10
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
```

A partir daí, basta `ssh evo`.

### 4.5 Desligar o login por senha e o login do root

Só faça isto **depois** que o passo 4.3 funcionou. Mantenha uma janela conectada durante todo o passo: se algo der errado, é por ela que você desfaz.

```bash
sudo tee /etc/ssh/sshd_config.d/99-seguranca.conf >/dev/null <<'EOF'
# Só entra com chave; root não entra direto (use "sudo" a partir do usuário deploy)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
EOF
```

Alguns provedores deixam um arquivo que reativa a senha (`50-cloud-init.conf`). Confira:

```bash
grep -ri "PasswordAuthentication" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/
```

Se aparecer `PasswordAuthentication yes` em outro arquivo, troque para `no` nele também. O SSH usa o primeiro valor que encontra; nossos ajustes estão no `99-…`, mas os arquivos são lidos em ordem.

Valide e aplique:

```bash
sudo sshd -t && echo "configuração OK"          # sem erro = pode aplicar
sudo systemctl reload ssh                        # no Ubuntu 22.04 o serviço pode se chamar "sshd"
sudo sshd -T | grep -E "passwordauthentication|permitrootlogin|kbdinteractive"
# passwordauthentication no / permitrootlogin no / kbdinteractiveauthentication no
```

**Teste numa nova janela** antes de fechar a antiga:

```bash
ssh deploy@203.0.113.10                                   # entra (com a chave)
ssh -o PubkeyAuthentication=no deploy@203.0.113.10        # deve RECUSAR: "Permission denied (publickey)"
ssh root@203.0.113.10                                     # deve RECUSAR
```

Se o primeiro comando falhar, desfaça pela janela que ficou aberta:

```bash
sudo rm /etc/ssh/sshd_config.d/99-seguranca.conf && sudo systemctl reload ssh
```

> **Perdeu o acesso?** Quase todo provedor tem um **console web** (VNC/serial) no painel, que não depende do SSH. Entre por ele e desfaça o arquivo acima. Em servidor interno, a equipe de TI tem esse acesso.

---

## 5. Firewall e proteção contra tentativas de senha

### 5.1 Firewall (ufw)

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp          # só se for usar Caddy/Nginx/NPM com HTTPS (passo 7)
sudo ufw allow 443/tcp         # idem
sudo ufw enable                # confirme com "y"; a sessão SSH atual continua
sudo ufw status verbose
```

Com Cloudflare Tunnel, não libere 80 nem 443: o túnel sai do servidor e não precisa de porta aberta.

> **Atenção, Docker e ufw:** portas publicadas pelo Docker (`ports:` no compose) **passam por fora do ufw**. Por isso o kit publica a API só em `127.0.0.1:8080`, e Postgres e Redis não têm porta publicada. Não troque para `0.0.0.0` nem tire o `127.0.0.1:`.

### 5.2 fail2ban

O fail2ban bloqueia por 1 hora quem errar o login várias vezes. Mesmo com senha desligada, ele reduz o barulho nos logs.

```bash
sudo tee /etc/fail2ban/jail.d/sshd.local >/dev/null <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
sudo systemctl enable --now fail2ban
sudo systemctl restart fail2ban
sudo fail2ban-client status sshd        # "Currently banned" e "Total failed"
```

Se você mesmo for bloqueado, por exemplo depois de errar a passphrase várias vezes, desbloqueie pelo console web:

```bash
sudo fail2ban-client set sshd unbanip <seu-ip>
```

---

## 6. Docker e Docker Compose

Instale pelo **repositório oficial do Docker**. O pacote `docker.io` do Ubuntu costuma estar desatualizado e não traz o `docker compose` v2.

### 6.1 Remover versões antigas (se houver)

```bash
for p in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do sudo apt remove -y $p 2>/dev/null; done
```

### 6.2 Adicionar o repositório oficial

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt update
```

### 6.3 Instalar

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
```

### 6.4 Usar o Docker sem `sudo`

```bash
sudo usermod -aG docker deploy
```

**Saia e entre de novo** no SSH para valer. Depois:

```bash
docker run --rm hello-world      # "Hello from Docker!"
docker --version                 # 27.x ou mais recente
docker compose version           # v2.x
```

> Quem está no grupo `docker` tem, na prática, poder de administrador no servidor. Coloque nele só quem já teria `sudo`.

### 6.5 Limitar o tamanho dos logs

Sem limite, os logs dos containers crescem até encher o disco:

```bash
sudo tee /etc/docker/daemon.json >/dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
sudo systemctl restart docker
```

O limite vale para containers criados depois disso. Se o kit já estiver rodando, rode `docker compose up -d --force-recreate` na pasta `docker/`.

### 6.6 Limpeza periódica (opcional)

Imagens antigas acumulam a cada atualização. Uma vez por mês:

```bash
docker image prune -a --filter "until=720h"     # apaga imagens sem uso há mais de 30 dias
docker system df                                 # quanto espaço o Docker está usando
```

---

## 7. Domínio apontando para o servidor (DNS)

Só é preciso se o sistema que envia **não** estiver no mesmo servidor e você for usar Caddy, Nginx ou NPM (passo seguinte, em [Instalação → proxy](02-instalacao.md#acesso-de-fora-do-servidor-proxy-com-https)). Com Cloudflare Tunnel, pule para [7.5](#75-com-cloudflare-tunnel).

### 7.1 O que criar

No painel de DNS do seu domínio, crie **um registro**:

| Tipo | Nome | Valor | TTL |
| --- | --- | --- | --- |
| `A` | `wpp` | `203.0.113.10` (IP do servidor) | 300 (5 min) ou "Automático" |

Isso faz `wpp.seu-dominio.com.br` apontar para o servidor.

- Se o servidor tiver IPv6, crie também um `AAAA` com o mesmo nome e o IPv6. Se não tiver, **não crie** `AAAA`: um IPv6 errado quebra o acesso de quem usa IPv6.
- Use um subdomínio próprio para a API (`wpp.`, `whatsapp.`, `evo.`), nunca o domínio principal do site.

### 7.2 Onde fica o painel de DNS

| Onde o domínio está | Caminho |
| --- | --- |
| **Registro.br** (domínios `.br`) | registro.br → entrar → o domínio → **DNS** → **Editar zona** → **Nova entrada**. Só aparece se o domínio usa os servidores DNS do Registro.br. Se usar outros (Cloudflare, provedor), a zona é editada lá. |
| **Cloudflare** | dash.cloudflare.com → o domínio → **DNS** → **Records** → **Add record** |
| Provedor de hospedagem | painel do provedor → "Zona DNS" / "Gerenciar DNS" |
| **Domínio institucional** (ex.: `.def.br`, `.gov.br`, `.jus.br`) | é a **equipe de TI** que cria. Peça o registro `A` da tabela acima, informando o IP. |

Para descobrir quem responde pelo DNS do domínio:

```bash
dig NS seu-dominio.com.br +short       # Windows: nslookup -type=NS seu-dominio.com.br
```

`*.ns.cloudflare.com` = Cloudflare; `a.dns.br` / `b.dns.br`… = Registro.br; outros = o provedor.

### 7.3 Cloudflare: nuvem laranja ou cinza?

Na Cloudflare, cada registro tem o modo **Proxied** (nuvem laranja) ou **DNS only** (nuvem cinza):

| Modo | Quando usar | Cuidados |
| --- | --- | --- |
| **DNS only** (cinza) | mais simples; o Caddy/NPM gera o certificado sozinho | o IP do servidor fica visível |
| **Proxied** (laranja) | esconde o IP e filtra ataques | em **SSL/TLS → Overview**, use **Full (strict)**. Com "Flexible", a Cloudflare fala com o servidor sem HTTPS. Para o Caddy/NPM gerar o certificado, deixe cinza na primeira vez e mude para laranja depois. |

### 7.4 Conferir se o DNS já está valendo

```bash
dig wpp.seu-dominio.com.br +short               # Windows: nslookup wpp.seu-dominio.com.br
# deve mostrar 203.0.113.10 (ou IPs da Cloudflare, se estiver "laranja")
```

A mudança costuma valer em minutos, mas pode levar até algumas horas, dependendo do TTL antigo. Para conferir de fora da sua rede: <https://dnschecker.org> (tipo `A`).

Depois que o DNS responder, siga para [Instalação → Acesso de fora do servidor](02-instalacao.md#acesso-de-fora-do-servidor-proxy-com-https) para configurar o HTTPS.

Teste final, já com o proxy e o kit rodando:

```bash
curl -s -H "apikey: <AUTHENTICATION_API_KEY>" https://wpp.seu-dominio.com.br/instance/fetchInstances
```

Responder `[]` ou a lista de instâncias = DNS, HTTPS e API funcionando.

### 7.5 Com Cloudflare Tunnel

Não crie o registro `A`. O túnel cria sozinho um registro `CNAME` para `<id>.cfargotunnel.com`.

```bash
# instalar o cloudflared (repositório oficial)
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared

cloudflared tunnel login                           # abre um link: entre na Cloudflare e escolha o domínio
cloudflared tunnel create evo                      # cria o túnel e o arquivo de credenciais
cloudflared tunnel route dns evo wpp.seu-dominio.com.br    # cria o CNAME
```

Crie `/etc/cloudflared/config.yml` como está em [Instalação → Cloudflare Tunnel](02-instalacao.md#cloudflare-tunnel-sem-abrir-porta-nenhuma). Copie o arquivo de credenciais (`~/.cloudflared/<id>.json`) para `/etc/cloudflared/` e instale como serviço:

```bash
sudo cloudflared service install
sudo systemctl status cloudflared --no-pager | head -3      # active (running)
```

---

## 8. Conferência final

Rode tudo de uma vez e confira cada linha:

```bash
echo "--- sistema";   lsb_release -ds; timedatectl | grep "Time zone"
echo "--- swap";      swapon --show --noheadings; cat /proc/sys/vm/swappiness
echo "--- ssh";       sudo sshd -T | grep -E "^(passwordauthentication|permitrootlogin) "
echo "--- firewall";  sudo ufw status | head -8
echo "--- fail2ban";  sudo fail2ban-client status sshd | grep -E "Currently|Total failed"
echo "--- docker";    docker --version; docker compose version
echo "--- logs";      cat /etc/docker/daemon.json 2>/dev/null | tr -d '\n'; echo
echo "--- atualiz.";  systemctl is-active unattended-upgrades
echo "--- dns";       dig +short wpp.seu-dominio.com.br
```

| Linha | Esperado |
| --- | --- |
| sistema | Ubuntu 22.04/24.04 · America/Sao_Paulo |
| swap | `/swapfile` com o tamanho criado · `10` |
| ssh | `passwordauthentication no` · `permitrootlogin no` |
| firewall | `Status: active` com OpenSSH (e 80/443 se usar proxy) |
| fail2ban | contadores aparecem (sem erro) |
| docker | 27.x ou mais · Compose v2.x |
| logs | `max-size` 20m |
| atualiz. | `active` |
| dns | o IP do servidor (ou da Cloudflare) |

Com tudo certo, siga para [2. Instalação](02-instalacao.md#passo-a-passo).

---

## Atalho: o script `preparar-servidor.sh`

O kit traz um script que faz os passos 2, 3, 5, 6 e 7 (menos o DNS, feito no painel). Rode como root, num servidor novo:

```bash
git clone https://github.com/Luanbc/evo.git /root/kit-evolution
sudo bash /root/kit-evolution/scripts/preparar-servidor.sh deploy
```

Ele faz:
1. atualiza o sistema e instala as ferramentas;
2. cria o usuário `deploy` com sudo e **copia a chave autorizada do root** (`/root/.ssh/authorized_keys`), se existir;
3. ajusta o fuso, as atualizações automáticas e a swap (2 GB, ou 4 GB com menos de 1,5 GB de RAM);
4. configura o firewall (OpenSSH; 80/443 com `--com-https`) e o fail2ban;
5. instala o Docker e o Compose do repositório oficial, com limite de logs;
6. mostra a conferência final.

O script **não desliga o login por senha** sozinho. Depois de testar que `ssh deploy@<ip>` entra com a chave (passo 4.3), rode:

```bash
sudo bash /root/kit-evolution/scripts/preparar-servidor.sh deploy --fechar-ssh
```

Ele recusa se o usuário não tiver nenhuma chave em `~/.ssh/authorized_keys`, valida a configuração com `sshd -t` antes de aplicar e mostra como desfazer.

Opções:

| Opção | Efeito |
| --- | --- |
| `--com-https` | libera 80 e 443 no firewall (para Caddy/Nginx/NPM) |
| `--swap=4G` | tamanho da swap (padrão: 2G, ou 4G com pouca RAM; `--swap=0` não cria) |
| `--sem-reinicio` | atualizações automáticas sem reiniciar sozinho de madrugada |
| `--fechar-ssh` | só desliga senha e root no SSH (rode por último) |

O script pode ser rodado de novo sem problema: o que já está feito, ele pula.

---

## Problemas no acesso

| Sintoma | Causa | Solução |
| --- | --- | --- |
| `Permission denied (publickey)` depois do passo 4.5 | a chave não está no servidor ou no seu computador | entre pelo console web e confira `/home/deploy/.ssh/authorized_keys`; permissões: `chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys`; dono: `chown -R deploy:deploy /home/deploy/.ssh` |
| Pede a senha do servidor mesmo com a chave copiada | permissões erradas, ou a chave foi copiada para outro usuário | as mesmas do item acima; teste com `ssh -v deploy@ip` e procure `Offering public key` / `Server accepts key` |
| `Connection timed out` | firewall bloqueou o SSH, IP errado ou servidor desligado | console web: `sudo ufw allow OpenSSH`; confira o IP no painel |
| `Connection refused` | o serviço SSH parou (geralmente por erro de configuração) | console web: `sudo sshd -t` mostra a linha errada; corrija e `sudo systemctl restart ssh` |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | o servidor foi recriado com o mesmo IP | no seu computador: `ssh-keygen -R 203.0.113.10` (só se você **sabe** que o servidor foi recriado) |
| Bloqueado pelo fail2ban | muitas tentativas erradas | console web: `sudo fail2ban-client set sshd unbanip <seu-ip>` |
| `permission denied ... docker.sock` | usuário ainda não está no grupo docker, ou não saiu e entrou de novo | `sudo usermod -aG docker deploy`, sair e entrar |
| `apt` travado ("Could not get lock") | atualização automática rodando | espere alguns minutos; confira com `ps aux \| grep -i apt` |
