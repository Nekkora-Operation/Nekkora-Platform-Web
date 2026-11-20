#!/usr/bin/env bash
# PLATFORM-LICENCIAMENTO-001 — SÓ laboratório descartável: a chave da D7 (license_rollout). Ligada, toda organização criada
# dali em diante nasce no modelo por licença (pronta para configurar, sem ativação a esperar). A chave nasce DESLIGADA em
# toda instalação (migration 067); ligá-la é procedimento administrativo, com o registro de quem autorizou. Este comando é
# esse procedimento NO LABORATÓRIO, para a criação no modelo por licença poder ser validada pela tela.
#
# Não muda nenhuma organização que já existe (elas continuam por ato explícito e auditado do operador de licenças) e não
# ativa nada. Em homologação e produção a chave NÃO é ligada por aqui: é o último passo do plano de implantação.
#
#   bash tools/lab/licencas-novas.sh <id> estado
#   bash tools/lab/licencas-novas.sh <id> ligar "<quem autorizou>"
#   bash tools/lab/licencas-novas.sh <id> desligar "<quem autorizou>"
set -euo pipefail
ID="${1:?uso: licencas-novas.sh <id> estado | ligar <quem autorizou> | desligar <quem autorizou>}"
ACAO="${2:?uso: licencas-novas.sh <id> estado | ligar <quem autorizou> | desligar <quem autorizou>}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
SEG="$HOME/.nekkora/front-lab/$ID"
SAIDA="$AQUI/saidas/$ID"
[ -f "$SEG/segredos.env" ] || { echo "laboratório $ID não existe" >&2; exit 1; }
set -a; . "$SEG/segredos.env"; set +a
# As chaves sao base64 e podem comecar com "/": sem isto o Git Bash as converte em caminho ao entrega-las ao docker.
export MSYS2_ENV_CONV_EXCL='E2E_HMAC_CHAVE;E2E_MFA_CHAVES'
case "${FRONT_AMBIENTE:-}" in ensaio-frontlab-*) ;; *) echo "recusado: só laboratório descartável" >&2; exit 1 ;; esac
AQUI_M="$(cygpath -m "$AQUI" 2>/dev/null || echo "$AQUI")"
COMPOSE=(docker compose -f "$LAB_API_REPO/api/e2e/compose.e2e.yml" -f "$AQUI_M/compose.front.yml")
psql_lab() { MSYS2_ARG_CONV_EXCL='*' "${COMPOSE[@]}" exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U nekkora -d nekkora "$@"; }
estado() {
    psql_lab -c "SELECT CASE WHEN new_organizations_licensed THEN 'ligada' ELSE 'desligada' END || ' | por: ' || updated_by || ' | em: ' || to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') FROM public.license_rollout"
}
mudar() {
    local valor="$1" quem="${2:-}"
    [ "${#quem}" -ge 3 ] || { echo "informe quem autorizou (3 caracteres ou mais)" >&2; exit 1; }
    # só grava quando muda: repetir o comando não reescreve quem autorizou nem a data
    psql_lab -v valor="$valor" -v quem="$quem" > /dev/null <<'SQL'
UPDATE public.license_rollout SET new_organizations_licensed = :'valor'::boolean, updated_by = :'quem', updated_at = clock_timestamp()
 WHERE new_organizations_licensed IS DISTINCT FROM :'valor'::boolean;
SQL
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) chave da D7 (organizações novas no modelo por licença): $(estado)" >> "$SAIDA/fixtures.txt"
}
case "$ACAO" in
estado) ;;
ligar) mudar true "${3:-}" ;;
desligar) mudar false "${3:-}" ;;
*) echo "uso: licencas-novas.sh <id> estado | ligar <quem autorizou> | desligar <quem autorizou>" >&2; exit 1 ;;
esac
E="$(estado)"
[ -n "$E" ] || { echo "não foi possível ler a chave (o laboratório está no ar?)" >&2; exit 1; }
echo "chave da D7 no $ID: $E"
