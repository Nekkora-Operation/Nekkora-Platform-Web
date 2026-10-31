#!/usr/bin/env bash
# FRONT-V1-002 — SÓ laboratório descartável: novo certificado TLS do nginx do laboratório, como em subir.sh (a chave
# privada só existe até o nginx carregá-la e é apagada em seguida). Necessário quando o nginx precisa reiniciar: a chave
# anterior já não existe por desenho. Atualiza laboratorio.txt e certificado-laboratorio.pem; o Agent do laboratório
# precisa de `agent.ps1 -Acao preparar` depois (a confiança é refeita a partir do certificado novo).
#   bash tools/lab/tls-renovar.sh <id>
set -euo pipefail
ID="${1:?uso: tls-renovar.sh <id>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
SEG="$HOME/.nekkora/front-lab/$ID"
SAIDA="$AQUI/saidas/$ID"
[ -f "$SEG/segredos.env" ] || { echo "laboratório $ID não existe" >&2; exit 1; }
set -a; . "$SEG/segredos.env"; set +a
case "${FRONT_AMBIENTE:-}" in ensaio-frontlab-*) ;; *) echo "recusado: só laboratório descartável" >&2; exit 1 ;; esac
export E2E_TLS="$(cygpath -m "$SEG/tls" 2>/dev/null || echo "$SEG/tls")"
COMPOSE=(docker compose -f "$LAB_API_REPO/api/e2e/compose.e2e.yml" -f "$AQUI/compose.front.yml")
trap 'rm -f "$SEG/tls/key.pem"' EXIT
umask 077
(cd "$SEG/tls" && MSYS2_ARG_CONV_EXCL='*' openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost" -keyout key.pem -out cert.pem 2>/dev/null)
umask 022
"${COMPOSE[@]}" up -d --no-deps --force-recreate nginx
BASE="$(sed -n 's/^api=//p' "$SAIDA/laboratorio.txt")"
for i in $(seq 1 60); do
    a="$(curl -s --cacert "$SEG/tls/cert.pem" -o /dev/null -w '%{http_code}' "$BASE/api/v1/csrf" || true)"
    [ "$a" = "200" ] && break
    [ "$i" -lt 60 ] || { echo "nginx não respondeu ($a)" >&2; exit 1; }
    sleep 2
done
rm -f "$SEG/tls/key.pem"
SHA="$(sha256sum "$SEG/tls/cert.pem" | cut -c1-64)"
sed -i "s/^certificado_sha256=.*/certificado_sha256=$SHA/" "$SAIDA/laboratorio.txt"
cp "$SEG/tls/cert.pem" "$SAIDA/certificado-laboratorio.pem"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) certificado TLS do laboratório renovado (nginx reiniciado; chave apagada) sha256=$SHA" >> "$SAIDA/fixtures.txt"
echo "TLS renovado: $BASE (certificado $SHA)"
