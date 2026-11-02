#!/usr/bin/env bash
# FRONT-V1-001 — laboratório DESCARTÁVEL com a API REAL para as jornadas do frontend pelo navegador.
#
# Mesmo modelo do laboratório do Agent (Nekkora-Agent: tools/platform-lab/subir.sh): sobe a stack E2E da própria API
# (api/e2e/compose.e2e.yml e Dockerfile, SEM alterar a API) com nome de projeto, portas, sub-rede e pasta de estado
# próprios, mais o complemento tools/lab/compose.front.yml (origem do Vite, cadastro ligado, caixa de homologação e
# armazenamento de artefatos).
#
# Migrations: TODAS as contíguas da cópia da API (001..028 em e04a57c), em INSTALAÇÃO LIMPA, pelo migrador suportado
# (db/bootstrap/aplicar_como_migrador.sh, o mesmo de api/e2e e das bases de teste). Nenhum SQL manual, nenhuma linha de
# elevação de outro ambiente. O log do migrador é conferido (sem FALHA, fim 0|0|0, invariantes da 016).
#
# Segredos ALEATÓRIOS por laboratório, só em $SEG (fora dos repositórios). A chave privada TLS é apagada assim que o nginx a
# carrega. Nunca toca outras stacks (projeto, rede, sub-rede e portas conferidos antes); nunca "down -v" nem limpeza global.
#
# Uso: LAB_PORTA=55891 LAB_PG_PORTA=55892 LAB_REDE=10.251.60 tools/lab/subir.sh frontlab-001 ../npa-int
#      (a cópia da API precisa estar no commit fixado em contract/SOURCE.json e ter os jars: mvnw -DskipTests package)
set -euo pipefail

ID="${1:?uso: subir.sh <id> <copia da API>}"
API_REPO="$(cd "${2:?copia da API}" && pwd)"
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
case "$ID" in frontlab-[0-9a-z-]*) ;; *) echo "ERRO: id deve começar com frontlab-" >&2; exit 1;; esac
export E2E_PROJETO="nekkora-$ID"
export E2E_PORTA="${LAB_PORTA:-55891}"
export E2E_PG_PORTA="${LAB_PG_PORTA:-55892}"
export E2E_REDE="${LAB_REDE:-10.251.60}"
export FRONT_AMBIENTE="ensaio-$ID"
SEG="$HOME/.nekkora/front-lab/$ID"
SAIDA="$AQUI/saidas/$ID"
COMPOSE=(docker compose -f "$API_REPO/api/e2e/compose.e2e.yml" -f "$AQUI/compose.front.yml")

falha() { echo "ERRO: $*" >&2; exit 1; }
limpar_chave() { rm -f "$SEG/tls/key.pem"; }
trap 'rc=$?; limpar_chave; exit $rc' EXIT

# --- a cópia da API é a do contrato fixado ---
COMMIT="$(git -C "$API_REPO" rev-parse HEAD)"
FIXADO="$(sed -n 's/.*"commit": "\([0-9a-f]*\)".*/\1/p' "$RAIZ/contract/SOURCE.json")"
[ "$COMMIT" = "$FIXADO" ] || falha "cópia da API em $COMMIT; o contrato do frontend está fixado em $FIXADO"
[ -z "$(git -C "$API_REPO" status --porcelain --untracked-files=no)" ] || falha "cópia da API com alterações locais"

# --- proteção de recursos existentes ---
[ -d "$SEG" ] && falha "laboratório $ID já existe ($SEG): use outro id"
# a saída é capturada antes do grep: com pipefail, `grep -q` saindo cedo pode dar SIGPIPE no escritor e pular a proteção
PORTAS_PUBLICADAS="$(docker ps --format '{{.Ports}}')" || falha "docker ps falhou"
for p in "$E2E_PORTA" "$E2E_PG_PORTA"; do
    [ "$p" != "5432" ] || falha "porta 5432 é da stack principal"
    if grep -q ":$p->" <<<"$PORTAS_PUBLICADAS"; then falha "porta $p já publicada"; fi
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then falha "porta $p em uso"; fi
done
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$E2E_PROJETO")" ] || falha "projeto $E2E_PROJETO já tem containers"
docker network inspect "${E2E_PROJETO}_e2e" >/dev/null 2>&1 && falha "rede ${E2E_PROJETO}_e2e já existe"
SUBREDES="$(docker network ls -q | xargs -r docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}')" || falha "não foi possível listar as sub-redes do Docker"
if grep -qF "$E2E_REDE.0/24" <<<"$SUBREDES"; then
    falha "sub-rede $E2E_REDE.0/24 já em uso por outra rede"
fi
for j in nekkora-platform nekkora-portal nekkora-agent-gateway; do
    ls "$API_REPO/api/$j/target/$j-0.1.0-SNAPSHOT.jar" >/dev/null 2>&1 || falha "jar ausente: $j (rode mvnw -DskipTests package na cópia da API)"
done

mkdir -p "$SEG/migracoes_montadas/migracoes" "$SEG/migracoes_montadas/bootstrap" "$SEG/tls" "$SAIDA"
chmod 700 "$SEG" 2>/dev/null || true
ATE="$(ls "$API_REPO/db/migrations" | sed -n 's/^\([0-9]\{3\}\)_.*\.sql$/\1/p' | sort | tail -1)"
for i in $(seq 1 "$((10#$ATE))"); do
    n="$(printf '%03d' "$i")"
    f=("$API_REPO"/db/migrations/${n}_*.sql)
    [ -f "${f[0]}" ] && [ ${#f[@]} -eq 1 ] || falha "migration $n ausente ou ambígua (as versões precisam ser contíguas)"
    cp "${f[0]}" "$SEG/migracoes_montadas/migracoes/"
done
(cd "$SEG/migracoes_montadas/migracoes" && sha256sum ./*.sql) > "$SAIDA/migrations_sha256.txt"
cp "$API_REPO/db/bootstrap/aplicar_como_migrador.sh" "$SEG/migracoes_montadas/bootstrap/"
printf '#!/bin/sh\nset -e\nNEKKORA_MIGRACOES=/docker-entrypoint-initdb.d/migracoes sh /docker-entrypoint-initdb.d/bootstrap/aplicar_como_migrador.sh\n' \
    > "$SEG/migracoes_montadas/000_aplicar_como_migrador.sh"
chmod 0755 "$SEG/migracoes_montadas/000_aplicar_como_migrador.sh"
export E2E_MIGRACOES="$(cygpath -m "$SEG/migracoes_montadas" 2>/dev/null || echo "$SEG/migracoes_montadas")"
export E2E_TLS="$(cygpath -m "$SEG/tls" 2>/dev/null || echo "$SEG/tls")"

aleatorio() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
senha() { head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
umask 077
{
    echo "E2E_PROJETO=$E2E_PROJETO"; echo "E2E_PORTA=$E2E_PORTA"; echo "E2E_PG_PORTA=$E2E_PG_PORTA"; echo "E2E_REDE=$E2E_REDE"
    echo "E2E_MIGRACOES=$E2E_MIGRACOES"; echo "E2E_TLS=$E2E_TLS"; echo "FRONT_AMBIENTE=$FRONT_AMBIENTE"
    echo "E2E_PG_SUPER_SENHA=$(senha)"; echo "E2E_PLATFORM_SENHA=$(senha)"; echo "E2E_PORTAL_SENHA=$(senha)"; echo "E2E_INGESTAO_SENHA=$(senha)"
    echo "E2E_MFA_CHAVES=k1:$(aleatorio 32)"; echo "E2E_HMAC_CHAVE=$(aleatorio 32)"
    echo "LAB_API_REPO=$(cygpath -m "$API_REPO" 2>/dev/null || echo "$API_REPO")"
} > "$SEG/segredos.env"
set -a; . "$SEG/segredos.env"; set +a

(cd "$SEG/tls" && MSYS2_ARG_CONV_EXCL='*' openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 7 -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost" -keyout key.pem -out cert.pem 2>/dev/null) || falha "certificado TLS descartável"
umask 022

echo "== postgres e redis ($E2E_PROJETO, API $COMMIT, migrations 001-$ATE)"
"${COMPOSE[@]}" up -d postgres redis
for i in $(seq 1 120); do
    [ "$("${COMPOSE[@]}" logs postgres 2>/dev/null | grep -c 'database system is ready to accept connections')" -ge 2 ] && break
    [ "$i" -lt 120 ] || falha "PostgreSQL não terminou a inicialização"
    sleep 2
done
"${COMPOSE[@]}" logs --no-color postgres 2>/dev/null | grep "aplicar_como_migrador" > "$SAIDA/aplicar_como_migrador.txt" || true
grep -q "aplicar_como_migrador: FALHA" "$SAIDA/aplicar_como_migrador.txt" && falha "migrador falhou (aplicar_como_migrador.txt)"
grep -Eq "aplicar_como_migrador: fim db=nekkora aplicadas=[0-9]+ estado=0\|0\|0" "$SAIDA/aplicar_como_migrador.txt" || falha "migrador sem fim 0|0|0"
grep -q "aplicar_como_migrador: invariantes_016_pos_retirada=OK" "$SAIDA/aplicar_como_migrador.txt" || falha "invariantes da 016 não conferidas"
printf "ALTER ROLE nekkora_platform PASSWORD '%s';\nALTER ROLE nekkora_portal PASSWORD '%s';\nALTER ROLE nekkora_ingestion PASSWORD '%s';\n" \
    "$E2E_PLATFORM_SENHA" "$E2E_PORTAL_SENHA" "$E2E_INGESTAO_SENHA" | "${COMPOSE[@]}" exec -T postgres psql -X -q -v ON_ERROR_STOP=1 -U nekkora -d nekkora

echo "== caixa de homologação (volume do projeto, nekkora 0700)"
"${COMPOSE[@]}" build platform
"${COMPOSE[@]}" run --rm --no-deps -T --user root --entrypoint sh platform -ec "install -d -o nekkora -g nekkora -m 700 /caixa && stat -c '%U %a' /caixa" \
    > "$SAIDA/caixa_init.txt"
grep -qx "nekkora 700" "$SAIDA/caixa_init.txt" || falha "caixa sem dono/permissão esperados"

echo "== platform, portal, canal do Agent e nginx"
"${COMPOSE[@]}" up -d --build platform portal agent-gateway nginx
BASE="https://localhost:$E2E_PORTA"
CA="$SEG/tls/cert.pem"
for i in $(seq 1 120); do
    a="$(curl -s --cacert "$CA" -o /dev/null -w '%{http_code}' "$BASE/api/v1/csrf" || true)"
    g="$(curl -s --cacert "$CA" -o /dev/null -w '%{http_code}' "$BASE/agent/api/v1/authorizations" || true)"
    [ "$a" = "200" ] && [ "$g" = "400" ] && break
    [ "$i" -lt 120 ] || { "${COMPOSE[@]}" logs --no-color > "$SAIDA/logs_falha_subida.txt"; falha "aplicações não responderam (platform=$a agente=$g)"; }
    sleep 2
done
rm -f "$SEG/tls/key.pem"

{
    echo "id=$ID"; echo "projeto=$E2E_PROJETO"; echo "ambiente=$FRONT_AMBIENTE"; echo "api_commit=$COMMIT"; echo "migrations=001-$ATE"
    echo "sub_rede=$E2E_REDE.0/24"; echo "api=$BASE"; echo "origem_publica=http://localhost:5173"
    echo "certificado_sha256=$(sha256sum "$CA" | cut -c1-64)"; echo "subido_em=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$SAIDA/laboratorio.txt"
cp "$CA" "$SAIDA/certificado-laboratorio.pem"
echo "LABORATORIO OK: $BASE"
echo "frontend: NEKKORA_API_URL=$BASE npm run dev   (origem http://localhost:5173)"
