#!/usr/bin/env bash
# Prepara um Ubuntu Server 22.04/24.04 novo para o kit (docs/00-preparar-servidor.md).
#
#   sudo bash scripts/preparar-servidor.sh <usuario> [--com-https] [--swap=2G|0] [--sem-reinicio]
#   sudo bash scripts/preparar-servidor.sh <usuario> --fechar-ssh      # por último, depois de testar a chave
#
# Pode rodar de novo: o que já está feito é pulado.
set -euo pipefail

USUARIO="${1:-}"; shift || true
COM_HTTPS=0; SWAP=""; SEM_REINICIO=0; FECHAR_SSH=0
for a in "$@"; do
  case "$a" in
    --com-https) COM_HTTPS=1 ;;
    --swap=*) SWAP="${a#--swap=}" ;;
    --sem-reinicio) SEM_REINICIO=1 ;;
    --fechar-ssh) FECHAR_SSH=1 ;;
    *) echo "opção desconhecida: $a"; exit 1 ;;
  esac
done
[ -z "$SWAP" ] || [[ "$SWAP" =~ ^(0|[1-9][0-9]?G)$ ]] || { echo "use --swap=0, --swap=1G, --swap=2G, --swap=4G..."; exit 1; }

passo() { echo; echo "==> $*"; }
ok()    { echo "    ok: $*"; }
pula()  { echo "    já feito: $*"; }
die()   { echo "ERRO: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "rode como root (sudo bash $0 ...)"
[ -n "$USUARIO" ] || die "informe o usuário: sudo bash $0 deploy"
[[ "$USUARIO" =~ ^[a-z_][a-z0-9_-]{1,31}$ ]] || die "nome de usuário inválido: $USUARIO"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "feito para Ubuntu (encontrado: ${PRETTY_NAME:-?})"
case "${VERSION_ID:-}" in 22.04|24.04) ;; *) echo "AVISO: testado em 22.04/24.04 (este é ${VERSION_ID:-?}). Continuando em 5 s..."; sleep 5 ;; esac
SSH_SVC=ssh; systemctl list-unit-files 2>/dev/null | grep -q '^ssh\.service' || SSH_SVC=sshd

# ------------------------------------------------------------------ só fechar o SSH
if [ "$FECHAR_SSH" = 1 ]; then
  passo "Desligando login por senha e do root no SSH"
  id "$USUARIO" >/dev/null 2>&1 || die "usuário $USUARIO não existe"
  AK="/home/$USUARIO/.ssh/authorized_keys"
  [ -s "$AK" ] || die "$USUARIO não tem chave em $AK. Copie a chave e teste 'ssh $USUARIO@<ip>' antes (passo 4 da documentação)."
  grep -qE '^(ssh-(ed25519|rsa)|ecdsa-sha2-|sk-)' "$AK" || die "$AK não parece ter uma chave pública válida"
  chown -R "$USUARIO:$USUARIO" "/home/$USUARIO/.ssh"; chmod 700 "/home/$USUARIO/.ssh"; chmod 600 "$AK"
  CONF=/etc/ssh/sshd_config.d/99-seguranca.conf
  cat > "$CONF" <<'EOF'
# Só entra com chave; root não entra direto (use "sudo" a partir do seu usuário)
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 30
EOF
  # arquivos do provedor que reativam a senha (ex.: 50-cloud-init.conf)
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ "$f" = "$CONF" ] && continue
    if grep -qiE '^\s*PasswordAuthentication\s+yes' "$f"; then
      sed -i -E 's/^\s*PasswordAuthentication\s+yes/PasswordAuthentication no/I' "$f"; ok "senha desligada também em $f"
    fi
  done
  if ! sshd -t; then rm -f "$CONF"; die "configuração do SSH inválida; nada foi aplicado"; fi
  systemctl reload "$SSH_SVC"
  sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) '
  echo
  echo "Aplicado. ANTES de fechar esta janela, teste numa janela nova:  ssh $USUARIO@<ip>"
  echo "Se não entrar, desfaça por aqui:  rm $CONF && systemctl reload $SSH_SVC"
  exit 0
fi

# ------------------------------------------------------------------ 1. sistema
passo "Atualizando o sistema e instalando ferramentas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
apt-get install -y -q curl ca-certificates gnupg git python3 openssl nano ufw fail2ban unattended-upgrades dnsutils
ok "sistema atualizado"

# ------------------------------------------------------------------ 2. usuário
passo "Usuário $USUARIO"
if id "$USUARIO" >/dev/null 2>&1; then pula "usuário existe"
else
  adduser --disabled-password --gecos "" "$USUARIO" >/dev/null
  ok "usuário criado (sem senha: defina com 'passwd $USUARIO', o sudo vai pedir)"
fi
usermod -aG sudo "$USUARIO"
install -d -m 700 -o "$USUARIO" -g "$USUARIO" "/home/$USUARIO/.ssh"
AK="/home/$USUARIO/.ssh/authorized_keys"
touch "$AK"; chown "$USUARIO:$USUARIO" "$AK"; chmod 600 "$AK"
if [ -s /root/.ssh/authorized_keys ]; then
  n=0
  while IFS= read -r linha; do
    [ -z "$linha" ] && continue
    grep -qxF "$linha" "$AK" || { echo "$linha" >> "$AK"; n=$((n+1)); }
  done < /root/.ssh/authorized_keys
  ok "$n chave(s) copiada(s) do root para $USUARIO"
else
  echo "    AVISO: o root não tem chave. Envie a sua para $USUARIO (passo 4.2 da documentação)."
fi
if ! passwd -S "$USUARIO" 2>/dev/null | awk '{print $2}' | grep -q '^P$'; then
  if [ -t 0 ]; then
    echo "    Defina a senha de $USUARIO (o sudo vai pedir; o login pelo SSH será só com chave):"
    until passwd "$USUARIO"; do echo "    tente de novo"; done
  else
    echo "    AVISO: $USUARIO ainda não tem senha (o sudo vai pedir). Defina com:  passwd $USUARIO"
  fi
fi

# ------------------------------------------------------------------ 3. fuso, atualizações, swap
passo "Fuso horário"
if [ "$(timedatectl show -p Timezone --value)" = "America/Sao_Paulo" ]; then pula "America/Sao_Paulo"
else timedatectl set-timezone America/Sao_Paulo; ok "America/Sao_Paulo"; fi
timedatectl set-ntp true || true

passo "Atualizações automáticas"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
if [ "$SEM_REINICIO" = 1 ]; then REBOOT=false; else REBOOT=true; fi
cat > /etc/apt/apt.conf.d/52reinicio-automatico <<EOF
Unattended-Upgrade::Automatic-Reboot "$REBOOT";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "ligadas (reinício automático às 04:00: $REBOOT)"

passo "Memória swap"
if swapon --show --noheadings | grep -q .; then pula "já existe: $(swapon --show --noheadings | awk '{print $1" "$3}' | tr '\n' ' ')"
else
  if [ -z "$SWAP" ]; then
    mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    if [ "$mem_mb" -lt 1500 ]; then SWAP=4G; else SWAP=2G; fi
  fi
  if [ "$SWAP" = "0" ]; then pula "swap desligada por opção"
  else
    livre_gb=$(df -BG --output=avail / | tail -1 | tr -dc '0-9')
    pedido_gb=$(echo "$SWAP" | tr -dc '0-9')
    [ "$livre_gb" -gt $((pedido_gb + 5)) ] || die "pouco disco para swap de $SWAP (livre: ${livre_gb}G). Use --swap=1G ou --swap=0"
    fallocate -l "$SWAP" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=$((pedido_gb*1024)) status=none
    chmod 600 /swapfile; mkswap /swapfile >/dev/null; swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    ok "swap de $SWAP criada"
  fi
fi
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swap.conf; sysctl --system >/dev/null

# ------------------------------------------------------------------ 5. firewall e fail2ban
passo "Firewall (ufw)"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
if [ "$COM_HTTPS" = 1 ]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ok "80 e 443 liberadas"; fi
ufw --force enable >/dev/null
ok "$(ufw status | head -1)"

passo "fail2ban"
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/sshd.local <<'EOF'
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
EOF
systemctl enable fail2ban >/dev/null 2>&1; systemctl restart fail2ban
ok "proteção do SSH ativa"

# ------------------------------------------------------------------ 6. Docker
passo "Docker"
if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then pula "$(docker --version)"
else
  for p in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do apt-get remove -y -q "$p" >/dev/null 2>&1 || true; done
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  ok "$(docker --version)"
fi
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
  ok "limite de logs: 20 MB x 5 por container"
else pula "/etc/docker/daemon.json já existe (confira o limite de logs)"; fi
systemctl enable --now docker >/dev/null 2>&1; systemctl restart docker
usermod -aG docker "$USUARIO"
ok "$USUARIO no grupo docker (vale depois de sair e entrar no SSH)"

# ------------------------------------------------------------------ conferência
passo "Conferência"
echo "    sistema : $PRETTY_NAME · $(timedatectl show -p Timezone --value)"
echo "    swap    : $(swapon --show --noheadings | awk '{print $1" "$3}' | tr '\n' ' ') · swappiness $(cat /proc/sys/vm/swappiness)"
echo "    firewall: $(ufw status | head -1) · $(ufw status | grep -cE 'ALLOW') regra(s)"
echo "    fail2ban: $(systemctl is-active fail2ban)"
echo "    docker  : $(docker --version | cut -d, -f1) · $(docker compose version --short 2>/dev/null)"
echo "    ssh     : $(sshd -T 2>/dev/null | grep -E '^passwordauthentication ' || true)"
echo
echo "Próximos passos:"
echo "  1. Numa janela nova, teste:  ssh $USUARIO@<ip-do-servidor>   (deve entrar com a chave)"
echo "  2. Depois:  sudo bash $0 $USUARIO --fechar-ssh"
echo "  3. DNS (se for usar domínio) e a instalação do kit: docs/00-preparar-servidor.md (passo 7) e docs/02-instalacao.md"
[ -f /var/run/reboot-required ] && echo "  * O sistema pede reinício: rode 'reboot' quando puder." || true
