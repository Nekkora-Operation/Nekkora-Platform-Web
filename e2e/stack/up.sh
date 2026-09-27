#!/usr/bin/env bash
# Sobe a API REAL (nginx TLS -> Platform/Portal -> PostgreSQL 16 com migrations 001-015 -> Redis) para o frontend,
# reaproveitando a stack E2E do repositorio da API sem altera-la: so a origem publica muda (compose.web.yml).
#
# Segredos (superusuario, papeis, chaves MFA/HMAC) sao ALEATORIOS por execucao e vivem so no ambiente deste
# processo; a chave TLS e apagada depois que o nginx a carrega. Nada vai para arquivo. As fixtures do E2E falam
# com o PostgreSQL por "docker exec" (socket local do container), sem precisar da senha.
#
# Uso:  e2e/stack/up.sh                         (origem http://localhost:5173, para npm run dev)
#       WEB_ORIGEM=http://localhost:4173 e2e/stack/up.sh   (preview, usado por npm run e2e)
# Remocao: e2e/stack/down.sh
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
WEB="$(cd "$AQUI/../.." && pwd)"
API_REPO="$(cd "${NEKKORA_API_DIR:-$WEB/../nekkora-platform-api}" && pwd)"
API="$API_REPO/api"
export E2E_PROJETO="${E2E_PROJETO:-nekkora-web}"
export E2E_PORTA="${E2E_PORTA:-55443}"
export E2E_PG_PORTA="${E2E_PG_PORTA:-55444}"
export WEB_ORIGEM="${WEB_ORIGEM:-http://localhost:5173}"
SAIDA="$WEB/.dev/stack"

falha() { echo "ERRO: $*" >&2; exit 1; }

[ -f "$API/e2e/compose.e2e.yml" ] || falha "repositorio da API nao encontrado em $API_REPO (defina NEKKORA_API_DIR)"
case "$E2E_PROJETO" in nekkora-platform|nekkora-portal-dev|nekkora-portal-013|nekkora-e2e) falha "projeto '$E2E_PROJETO' pertence a outra stack";; esac
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$E2E_PROJETO")" ] && ja=0 || ja=1
if [ "$ja" = 1 ]; then falha "stack $E2E_PROJETO ja existe; use e2e/stack/down.sh antes"; fi
for p in "$E2E_PORTA" "$E2E_PG_PORTA"; do
    [ "$p" != "5432" ] || falha "porta 5432 e da stack principal"
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then falha "porta $p ja em uso no host"; fi
done

rm -rf "$SAIDA" && mkdir -p "$SAIDA/migracoes" "$SAIDA/tls"
for n in $(seq -w 1 15); do
    f=("$API_REPO"/db/migrations/0${n}_*.sql)
    [ -f "${f[0]}" ] && [ ${#f[@]} -eq 1 ] || falha "migration 0$n ausente ou ambigua"
    cp "${f[0]}" "$SAIDA/migracoes/"
done
export E2E_MIGRACOES="$SAIDA/migracoes" E2E_TLS="$SAIDA/tls"

aleatorio() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
senha() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
export E2E_PG_SUPER_SENHA="$(senha)" E2E_PLATFORM_SENHA="$(senha)" E2E_PORTAL_SENHA="$(senha)"
export E2E_MFA_CHAVES="k1:$(aleatorio 32)" E2E_HMAC_CHAVE="$(aleatorio 32)"

(cd "$SAIDA/tls" && openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost" -keyout key.pem -out cert.pem 2>/dev/null) || falha "certificado TLS descartavel"
chmod 644 "$SAIDA/tls/key.pem"   # lido pelo nginx no container; apagado logo apos a subida

compose() { docker compose -f "$API/e2e/compose.e2e.yml" -f "$AQUI/compose.web.yml" "$@"; }

if [ ! -f "$API/nekkora-platform/target/nekkora-platform-0.1.0-SNAPSHOT.jar" ] || [ "${REBUILD:-0}" = 1 ]; then
    echo "== build dos jars da API (sem testes)"
    (cd "$API" && bash ./mvnw -q -DskipTests package)
fi

echo "== postgres e redis ($E2E_PROJETO)"
compose up -d postgres redis
for i in $(seq 1 90); do
    [ "$(compose logs postgres 2>/dev/null | grep -c 'database system is ready to accept connections')" -ge 2 ] && break
    [ "$i" -lt 90 ] || falha "PostgreSQL nao terminou a inicializacao"
    sleep 2
done
printf "ALTER ROLE nekkora_platform PASSWORD '%s';\nALTER ROLE nekkora_portal PASSWORD '%s';\n" "$E2E_PLATFORM_SENHA" "$E2E_PORTAL_SENHA" \
    | compose exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U nekkora -d nekkora

echo "== platform, portal e nginx (origem publica $WEB_ORIGEM)"
compose up -d --build platform portal nginx
BASE="https://localhost:$E2E_PORTA"
for i in $(seq 1 90); do
    a="$(curl -sk -o /dev/null -w '%{http_code}' "$BASE/api/v1/csrf" || true)"
    [ "$a" = "200" ] && break
    [ "$i" -lt 90 ] || { compose logs --no-color > "$SAIDA/logs_falha_subida.txt"; falha "platform nao respondeu ($a)"; }
    sleep 2
done
rm -f "$SAIDA/tls/key.pem"

echo "API pronta em $BASE (via proxy /api do Vite em $WEB_ORIGEM)"
echo "postgres (fixtures): docker exec -i ${E2E_PROJETO}-postgres-1 psql -U nekkora -d nekkora"
