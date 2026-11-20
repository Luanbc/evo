#!/usr/bin/env bash
# Operação da Evolution API pelo terminal do servidor.
# Uso: scripts/evo.sh <comando> [argumentos]      (rode "scripts/evo.sh ajuda" para a lista)
#
# Lê a chave e a porta de docker/.env. Pode sobrescrever com variáveis:
#   EVO_URL=http://127.0.0.1:8080  EVO_KEY=...  PG_CONTAINER=evo-postgres  EVO_CONTAINER=evolution-api
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_ARQ="${ENV_ARQ:-$RAIZ/docker/.env}"
if [ -f "$ENV_ARQ" ]; then set -a; . "$ENV_ARQ"; set +a; fi
EVO_URL="${EVO_URL:-http://127.0.0.1:${EVOLUTION_PORTA:-8080}}"
EVO_KEY="${EVO_KEY:-${AUTHENTICATION_API_KEY:-}}"
PG_CONTAINER="${PG_CONTAINER:-evo-postgres}"
PG_USER="${PG_USER:-evolution}"
PG_DB="${PG_DB:-evolution}"
EVO_CONTAINER="${EVO_CONTAINER:-evolution-api}"

die() { echo "ERRO: $*" >&2; exit 1; }
[ -n "$EVO_KEY" ] || die "chave da API não encontrada (AUTHENTICATION_API_KEY no docker/.env ou EVO_KEY)"
command -v curl >/dev/null || die "curl não instalado"
command -v python3 >/dev/null || die "python3 não instalado (usado para ler as respostas JSON)"

api() { # api METODO CAMINHO [JSON]
  local m="$1" c="$2" d="${3:-}"
  if [ -n "$d" ]; then curl -sS -m 40 -X "$m" -H "apikey: $EVO_KEY" -H "Content-Type: application/json" -d "$d" "$EVO_URL$c"
  else curl -sS -m 40 -X "$m" -H "apikey: $EVO_KEY" "$EVO_URL$c"; fi
}
num() { # número só com dígitos e com DDI 55 (aceita "(98) 98888-7777")
  local d; d="$(echo "$1" | tr -cd '0-9')"; d="${d#0}"
  case ${#d} in 10|11) echo "55$d";; 12|13) echo "$d";; *) die "número inválido: $1 (use DDD + número)";; esac
}
estado_de() { api GET "/instance/connectionState/$1" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("instance") or d).get("state","?"))' 2>/dev/null || echo "?"; }
pg() { docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -At -c "$1"; }

PY_QR='
import json, sys, base64
inst = sys.argv[1]
d = json.load(sys.stdin)
b64 = d.get("base64") or ""
if b64:
    nome = "qrcode-%s.png" % inst
    open(nome, "wb").write(base64.b64decode(b64.split(",", 1)[-1]))
    print("QR Code salvo em %s (vale ~40 s; leia em WhatsApp > Aparelhos conectados > Conectar um aparelho)" % nome)
if d.get("pairingCode"):
    print("Codigo de pareamento (alternativa ao QR):", d["pairingCode"])
if not b64 and not d.get("pairingCode"):
    print("Nenhum QR Code gerado. Resposta:", json.dumps(d)[:300])
    print("Se a instancia esta presa em \"connecting\", rode:  scripts/evo.sh destravar", inst)
'
salvar_qr() { python3 -c "$PY_QR" "$1"; }   # lê a resposta do /instance/connect (stdin) e grava o PNG

cmd="${1:-ajuda}"; shift || true
case "$cmd" in
  instancias)
    api GET /instance/fetchInstances | python3 -c '
import json,sys
for i in json.load(sys.stdin):
    i = i.get("instance", i); j = str(i.get("ownerJid") or "").split("@")[0]
    print("%-20s %-11s numero: %-7s atualizada: %s" % (i.get("name"), i.get("connectionStatus"), ("…" + j[-4:]) if j else "-", i.get("updatedAt")))'
    ;;
  estado)
    [ $# -ge 1 ] || die "uso: estado <instancia>"
    echo "$1: $(estado_de "$1")"
    ;;
  criar)
    [ $# -ge 1 ] || die "uso: criar <instancia> [url-do-webhook]"
    inst="$1"
    api POST /instance/create "{\"instanceName\":\"$inst\",\"integration\":\"WHATSAPP-BAILEYS\",\"qrcode\":true,\"rejectCall\":false,\"groupsIgnore\":true,\"alwaysOnline\":false,\"readMessages\":false,\"syncFullHistory\":false}" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); i=d.get("instance",{}); print("criada:", i.get("instanceName"), "| status:", i.get("status")) if i else print(json.dumps(d)[:300])'
    if [ $# -ge 2 ]; then "$0" webhook "$inst" "$2"; fi
    echo "Agora rode:  scripts/evo.sh conectar $inst"
    ;;
  conectar)
    [ $# -ge 1 ] || die "uso: conectar <instancia> [numero-para-codigo-de-pareamento]"
    inst="$1"; q=""; [ $# -ge 2 ] && q="?number=$(num "$2")"
    st="$(estado_de "$inst")"
    [ "$st" = "open" ] && { echo "$inst já está conectada."; exit 0; }
    api GET "/instance/connect/$inst$q" | salvar_qr "$inst"
    ;;
  logout)
    [ $# -ge 1 ] || die "uso: logout <instancia>"
    api DELETE "/instance/logout/$1"; echo
    sleep 2; echo "$1: $(estado_de "$1")"
    ;;
  reiniciar)
    [ $# -ge 1 ] || die "uso: reiniciar <instancia>"
    api POST "/instance/restart/$1" >/dev/null || true
    sleep 8; echo "$1: $(estado_de "$1")"
    ;;
  destravar)
    # Para quando o logout falha com "Connection Closed" e a instância fica presa em open/connecting sem gerar QR.
    # Apaga SÓ a sessão (credenciais) da instância. Mantém webhook, configurações e as mensagens guardadas.
    [ $# -ge 1 ] || die "uso: destravar <instancia>"
    inst="$1"
    id="$(pg "select id from \"Instance\" where name = '$inst'")"
    [ -n "$id" ] || die "instância $inst não encontrada no banco"
    mkdir -p "$RAIZ/backups"
    arq="$RAIZ/backups/sessao-$inst-$(date +%Y%m%d-%H%M%S).json"
    pg "select row_to_json(s) from \"Session\" s where \"sessionId\" = '$id'" > "$arq"
    chmod 600 "$arq"
    echo "cópia da sessão antiga: $arq"
    echo "tentando logout normal antes..."; api DELETE "/instance/logout/$inst" >/dev/null 2>&1 || true
    docker stop "$EVO_CONTAINER" >/dev/null && echo "Evolution parada"
    pg "delete from \"Session\" where \"sessionId\" = '$id'" >/dev/null
    pg "update \"Instance\" set \"connectionStatus\" = 'close', \"ownerJid\" = null where id = '$id'" >/dev/null
    echo "sessão de $inst apagada"
    docker start "$EVO_CONTAINER" >/dev/null && echo "Evolution ligada"
    for _ in $(seq 1 20); do sleep 3; curl -s -m 3 -o /dev/null "$EVO_URL/" && break; done; sleep 5
    echo "$inst: $(estado_de "$inst")"
    api GET "/instance/connect/$inst" | salvar_qr "$inst"
    echo "Obs.: as outras instâncias caem por alguns segundos e voltam sozinhas (as sessões delas não são tocadas)."
    ;;
  webhook)
    [ $# -ge 2 ] || die "uso: webhook <instancia> <url> [EVENTO,EVENTO...]"
    inst="$1"; url="$2"; ev="${3:-MESSAGES_UPSERT,MESSAGES_UPDATE,SEND_MESSAGE,CONNECTION_UPDATE}"
    evjson="$(echo "$ev" | python3 -c 'import sys,json; print(json.dumps([e.strip() for e in sys.stdin.read().split(",") if e.strip()]))')"
    api POST "/webhook/set/$inst" "{\"webhook\":{\"enabled\":true,\"url\":\"$url\",\"byEvents\":false,\"base64\":false,\"events\":$evjson}}" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("webhook:", d.get("url"), "| eventos:", ",".join(d.get("events") or []))' 2>/dev/null || true
    ;;
  validar)
    [ $# -ge 2 ] || die "uso: validar <instancia> <numero>"
    api POST "/chat/whatsappNumbers/$1" "{\"numbers\":[\"$(num "$2")\"]}" | python3 -c '
import json,sys; d=json.load(sys.stdin); i=(d or [{}])[0]
print("tem WhatsApp" if i.get("exists") else "SEM WhatsApp", "| jid:", i.get("jid"))'
    ;;
  teste)
    [ $# -ge 3 ] || die "uso: teste <instancia> <numero> \"texto\""
    inst="$1"; n="$(num "$2")"; shift 2
    [ "$(estado_de "$inst")" = "open" ] || die "$inst não está conectada"
    txt="$(printf '%s' "$*" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')"
    api POST "/message/sendText/$inst" "{\"number\":\"$n\",\"text\":$txt,\"delay\":1200}" \
      | python3 -c 'import json,sys; d=json.load(sys.stdin); print("enviada | id:", (d.get("key") or {}).get("id")) if d.get("key") else print(json.dumps(d)[:300])'
    ;;
  ajuda|*)
    cat <<'TXT'
Comandos:
  instancias                          lista as instâncias, estado e final do número
  estado     <inst>                   open | connecting | close
  criar      <inst> [url-webhook]     cria a instância (e liga o webhook, se passar a URL)
  conectar   <inst> [numero]          gera o QR Code em qrcode-<inst>.png (com número: código de pareamento)
  logout     <inst>                   desconecta o aparelho
  reiniciar  <inst>                   reinicia a conexão sem deslogar
  destravar  <inst>                   apaga só a sessão presa (logout falhando / sem QR) e gera QR novo
  webhook    <inst> <url> [eventos]   liga o webhook (padrão: mensagens, envios e conexão)
  validar    <inst> <numero>          diz se o número tem WhatsApp
  teste      <inst> <numero> "texto"  manda uma mensagem de teste
TXT
    ;;
esac
