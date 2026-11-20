#!/usr/bin/env bash
# Confere se todas as instâncias estão conectadas. Feito para rodar no cron a cada 5 minutos:
#   */5 * * * * /caminho/kit-evolution/scripts/monitor.sh >> /var/log/evo-monitor.log 2>&1
#
# Com ALERTA_URL definido (no docker/.env ou no ambiente), faz um POST JSON quando alguma instância
# muda de estado (ex.: um webhook do Slack, Google Chat, Discord ou do seu sistema).
# Avisa só na mudança, não a cada 5 minutos.
set -uo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
ENV_ARQ="${ENV_ARQ:-$RAIZ/docker/.env}"
if [ -f "$ENV_ARQ" ]; then set -a; . "$ENV_ARQ"; set +a; fi
EVO_URL="${EVO_URL:-http://127.0.0.1:${EVOLUTION_PORTA:-8080}}"
EVO_KEY="${EVO_KEY:-${AUTHENTICATION_API_KEY:-}}"
ESTADO_ARQ="${ESTADO_ARQ:-$RAIZ/backups/.monitor-estado}"
mkdir -p "$(dirname "$ESTADO_ARQ")"; touch "$ESTADO_ARQ"

atual="$(curl -s -m 15 -H "apikey: $EVO_KEY" "$EVO_URL/instance/fetchInstances" | python3 -c '
import json,sys
try:
    for i in json.load(sys.stdin):
        i = i.get("instance", i); print("%s=%s" % (i.get("name"), i.get("connectionStatus")))
except Exception:
    print("API=sem_resposta")
' | sort)"

mudancas="$(diff <(sort "$ESTADO_ARQ") <(echo "$atual") | grep '^>' | sed 's/^> //')"
echo "$atual" > "$ESTADO_ARQ"
[ -z "$mudancas" ] && exit 0

echo "$(date '+%F %T') mudança: $(echo "$mudancas" | tr '\n' ' ')"
if [ -n "${ALERTA_URL:-}" ]; then
  texto="WhatsApp (Evolution): $(echo "$mudancas" | sed 's/=open/ conectada/; s/=close/ DESCONECTADA/; s/=connecting/ tentando conectar/; s/=sem_resposta/ SEM RESPOSTA/' | tr '\n' ';' | sed 's/;$//')"
  json="$(printf '%s' "$texto" | python3 -c 'import json,sys; t=sys.stdin.read(); print(json.dumps({"text": t, "content": t}))')"
  curl -s -m 15 -X POST -H "Content-Type: application/json" -d "$json" "$ALERTA_URL" >/dev/null || echo "falha ao enviar alerta"
fi
