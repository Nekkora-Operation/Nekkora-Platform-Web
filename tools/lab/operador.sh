#!/usr/bin/env bash
# PLATFORM-LOCAL-002 — OPERADOR LOCAL da ativação de organizações (migration 022) no laboratório do frontend.
#
# A ativação NÃO é uma ação da tela: é um ato operacional da Nekkora, feito pela CLI real dos operadores
# (com.nekkora.ops.cli.OpsCli, `ativar-organizacao`), com um papel de operador do banco autenticado SÓ por certificado de
# cliente, uma conta responsável que o operador controla e limites explícitos. Este script monta esse aparato no
# laboratório já instalado (inclusive com dados: nada é apagado nem recriado além do container do PostgreSQL), no mesmo
# desenho da homologação descartável da API (ops/homologacao: compose.016.yml, operadores_016.sql, testes/jornada_ativacao.sh).
#
#   bash tools/lab/operador.sh <id> preparar          uma vez: TLS do PostgreSQL, CA operacional, pg_hba dos operadores,
#                                                      papéis op_lab_cad/op_lab_atv, cadastro pela 016, concessão da 022,
#                                                      conta responsável do operador e o vínculo dela
#   bash tools/lab/operador.sh <id> ativar <org> <workers> <simultaneas> <pendentes> <motivo...>
#   bash tools/lab/operador.sh <id> revisar <org> <workers> <simultaneas> <pendentes> <motivo...>
#   bash tools/lab/operador.sh <id> estado            organizações, estado de ativação e últimos atos (somente leitura)
#
# Segredos (chaves das CAs, senha de nekkora_ops_ca, conta do operador) SÓ em ~/.nekkora/front-lab/<id>/operador (0700),
# fora do Git; credenciais emitidas (PKCS#12 de 15 min) SÓ no volume "operadores" do projeto. A saída leva só ids e
# resultados. LIMITE DECLARADO (o mesmo da homologação descartável): o IdP que prova o operador é o IdP SIMULADO da
# ferramenta de homologação da API (FerramentaHomologacao/IdpSimulado, código de teste) — o certificado é emitido pela
# biblioteca real (EmissorCertificados) com a CA operacional DO LABORATÓRIO. Só ambiente ensaio-* (a ferramenta recusa outro).
set -euo pipefail

ID="${1:?uso: operador.sh <id> preparar|ativar|revisar|estado}"
CMD="${2:-}"; shift 2 || true
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
SEG="$HOME/.nekkora/front-lab/$ID"
SAIDA="$AQUI/saidas/$ID"
OP="$SEG/operador"
CAD=op_lab_cad
ATV=op_lab_atv

falha() { echo "ERRO: $*" >&2; exit 1; }
mixed() { cygpath -m "$1" 2>/dev/null || echo "$1"; }
[ -f "$SEG/segredos.env" ] || falha "laboratório $ID não instalado"
set -a; . "$SEG/segredos.env"; set +a
[[ "$FRONT_AMBIENTE" =~ ^ensaio-frontlab- ]] || falha "operador local só em laboratório ensaio-frontlab-*"
export OPERADOR_DIR="$(mixed "$OP")"
BASE=(-f "$LAB_API_REPO/api/e2e/compose.e2e.yml" -f "$(mixed "$AQUI")/compose.front.yml")  # C:/...: vale com MSYS_NO_PATHCONV
COMPOSE=(docker compose "${BASE[@]}" -f "$(mixed "$AQUI")/compose.operador.yml")
sq() { "${COMPOSE[@]}" exec -T postgres psql -X -q -At -v ON_ERROR_STOP=1 -U nekkora -d nekkora "$@"; }
ferr() { MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" --profile operacao run --rm -T operacao com.nekkora.ops.homologacao.FerramentaHomologacao "$@" 2>&1 \
    | tr -d '\r' | grep -vE '^ Container |^\s*$' || true; }
# CLI real: a senha do PKCS#12 só é lida DENTRO do container (arquivo do volume exclusivo); nunca passa pelo host
cli() { MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" --profile operacao run --rm -T -e NEKKORA_OPS_PAPEL="$1" -e NEKKORA_OPS_CREDENCIAL="/operadores/$1.p12" \
    --entrypoint sh operacao -ec 'export NEKKORA_OPS_CREDENCIAL_SENHA="$(cat "/operadores/$NEKKORA_OPS_PAPEL.senha")"; exec java -cp "/app/lib/*:/app/classes" com.nekkora.ops.cli.OpsCli "$@"' \
    -- "${@:2}" 2>&1 | tr -d '\r' | grep -vE '^ Container |^\s*$' || true; }
cred() {
    local o; o="$(ferr credencial "$1")"
    grep -q "^credencial=$1 " <<<"$o" || { echo "$o" | grep -v 'validade_ate' >&2; falha "credencial de $1 não emitida"; }
    echo "credencial de $1 emitida (15 min)"
}
responsavel() { sq -c "SELECT l.user_id FROM ops.ops_operator_platform_accounts l JOIN ops.ops_operators o USING (operator_id)
    WHERE o.db_role = '$ATV' AND l.removed_at IS NULL ORDER BY l.created_at DESC LIMIT 1" | tr -d '\r'; }
preparado() { [ -f "$OP/preparado" ] || falha "operador local não preparado (rode: bash tools/lab/local.sh operador preparar)"; }

case "$CMD" in
preparar)
    [ -f "$OP/preparado" ] && { echo "operador local já preparado em $(cat "$OP/preparado")"; exit 0; }
    "${COMPOSE[@]}" exec -T postgres pg_isready -q -U nekkora -d nekkora || falha "PostgreSQL parado (rode: bash tools/lab/local.sh subir)"
    [ "$(sq -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('nekkora_ops_mfa', 'nekkora_ops_ca', 'nekkora_org_activation')")" = 3 ] \
        || falha "banco sem a 016/022 (papéis nekkora_ops_mfa, nekkora_ops_ca, nekkora_org_activation)"
    # o bootstrap da 016 só vale com o cadastro operacional vazio: outro operador (que não os deste laboratório) recusa
    N_OUTROS="$(sq -c "SELECT count(*) FROM ops.ops_operators WHERE db_role NOT IN ('$CAD', '$ATV')")"
    [ "$N_OUTROS" = 0 ] || falha "já há operadores de outro preparo neste banco ($N_OUTROS); nada foi alterado"
    mkdir -p "$OP/tls" "$OP/tls-postgres" "$OP/tls-operacao" "$OP/config"; chmod 700 "$OP" "$OP/tls" 2>/dev/null || true

    echo "== 1. job de operação (CLI real + ferramenta) a partir da cópia da API ($LAB_API_REPO)"
    if [ ! -d "$LAB_API_REPO/api/nekkora-ops/target/dep-operacao" ] || [ ! -f "$LAB_API_REPO/api/nekkora-ops/target/test-classes/com/nekkora/ops/homologacao/FerramentaHomologacao.class" ]; then
        (cd "$LAB_API_REPO/api" && ./mvnw -q -B -pl nekkora-ops dependency:copy-dependencies -DincludeScope=runtime -DoutputDirectory=target/dep-operacao \
            && ./mvnw -q -B -pl nekkora-ops test-compile) || falha "build do job de operação"
    fi
    "${COMPOSE[@]}" --profile operacao build operacao > "$OP/build_operacao.txt" 2>&1 || falha "imagem do job de operação (ver $OP/build_operacao.txt)"

    if [ ! -f "$OP/fase_tls" ]; then
        echo "== 2. certificados: CA do servidor (nome postgres) e CA OPERACIONAL (certificados dos operadores), 1 ano"
        (
            cd "$OP/tls"; export MSYS2_ARG_CONV_EXCL='*'
            openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj "/CN=Nekkora laboratorio $ID - servidor" \
                -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout ca.key -out ca.crt 2>/dev/null
            printf 'subjectAltName=DNS:postgres\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\n' > pg.ext
            openssl req -newkey rsa:2048 -nodes -subj "/CN=postgres" -keyout postgres.key -out postgres.csr 2>/dev/null
            openssl x509 -req -in postgres.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days 365 -extfile pg.ext -out postgres.crt 2>/dev/null
            openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 365 -subj "/O=Nekkora laboratorio/CN=Nekkora Ops CA $ID" \
                -addext "basicConstraints=critical,CA:true" -addext "keyUsage=critical,keyCertSign,cRLSign" -keyout ops-ca.key -out ops-ca.crt 2>/dev/null
            rm -f pg.ext postgres.csr ca.srl; chmod 600 ./*.key 2>/dev/null || true
        ) || falha "certificados"
        cp "$OP/tls/postgres.crt" "$OP/tls/postgres.key" "$OP/tls/ops-ca.crt" "$OP/tls-postgres/"
        cp "$OP/tls/ca.crt" "$OP/tls/ops-ca.crt" "$OP/tls/ops-ca.key" "$OP/tls-operacao/"

        echo "== 3. pg_hba a partir do EFETIVO do volume (linhas dos serviços intactas) + regras dos operadores à frente"
        ORIG="$("${COMPOSE[@]}" exec -T postgres sh -c 'cat "$(psql -X -At -U nekkora -d nekkora -c "SHOW hba_file")"' | tr -d '\r')"
        grep -q 'op_' <<<"$ORIG" && falha "o pg_hba atual já tem regras de operador (preparo anterior incompleto?)"
        {
            echo "# GERADO por tools/lab/operador.sh ($ID, $(date -u +%Y-%m-%dT%H:%M:%SZ)). A primeira linha que casa decide."
            echo "# operadores op_*: SÓ certificado de cliente da CA operacional do laboratório (ssl_ca_file), CN = papel (mapa ops),"
            echo "# SÓ do job de operação ($E2E_REDE.33) e SÓ com TLS; qualquer outra origem ou método, recusado"
            echo "local     all      /^op_                                reject"
            echo "hostssl   nekkora  /^op_            $E2E_REDE.33/32       cert map=ops clientname=CN"
            echo "host      all      /^op_            all                 reject"
            echo "# serviço da CA operacional (registro dos certificados emitidos): SÓ do job de operação, SCRAM com TLS"
            echo "local     all      nekkora_ops_ca                       reject"
            echo "hostssl   nekkora  nekkora_ops_ca   $E2E_REDE.33/32       scram-sha-256"
            echo "host      all      nekkora_ops_ca   all                 reject"
            echo "# linhas EFETIVAS do volume antes do preparo (serviços e administrador do laboratório), sem alteração"
            grep -vE '^\s*(#|$)' <<<"$ORIG"
        } > "$OP/config/pg_hba.conf"
        printf '# GERADO por tools/lab/operador.sh: o CN do certificado do operador tem de ser exatamente o papel op_*\nops        "/^(op_[a-z0-9_]{2,40})$"          \\1\n' > "$OP/config/pg_ident.conf"

        echo "== 4. senha do serviço da CA operacional (verificador SCRAM; a senha só fica em operacao.env)"
        SENHA_CA="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url'))")"
        VERIF="$(printf '%s' "$SENHA_CA" | node -e "
          const c=require('crypto');const p=require('fs').readFileSync(0,'utf8');const s=c.randomBytes(16);
          const k=c.pbkdf2Sync(p,s,4096,32,'sha256');const h=(x)=>c.createHmac('sha256',k).update(x).digest();
          const st=c.createHash('sha256').update(h('Client Key')).digest();
          process.stdout.write('SCRAM-SHA-256\$4096:'+s.toString('base64')+'\$'+st.toString('base64')+':'+h('Server Key').toString('base64'))")"
        printf "ALTER ROLE nekkora_ops_ca PASSWORD '%s';\n" "$VERIF" | sq > /dev/null || falha "senha de nekkora_ops_ca"
        umask 077
        printf 'NEKKORA_AMBIENTE=%s\nNEKKORA_OPS_DB_URL=jdbc:postgresql://postgres:5432/nekkora\nNEKKORA_OPS_RAIZ_SERVIDOR=/tls/ca.crt\nHOMOLOG_OPS_CA_CRT=/tls/ops-ca.crt\nHOMOLOG_OPS_CA_KEY=/tls/ops-ca.key\nHOMOLOG_OPS_CA_SENHA=%s\nHOMOLOG_OPERADORES=/operadores\nNEKKORA_OPS_LOG=/tmp/nekkora-ops.log\n' \
            "$FRONT_AMBIENTE" "$SENHA_CA" > "$OP/operacao.env"
        unset SENHA_CA VERIF
        date -u +%Y-%m-%dT%H:%M:%SZ > "$OP/fase_tls"
    fi

    echo "== 5. PostgreSQL com TLS e as regras novas (recria SÓ o container; o volume de dados é o mesmo)"
    VOL_ANTES="$(docker inspect "${E2E_PROJETO}-postgres-1" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')"
    "${COMPOSE[@]}" up -d --no-deps postgres > /dev/null 2>&1 || falha "PostgreSQL com TLS não subiu"
    for i in $(seq 1 60); do
        "${COMPOSE[@]}" exec -T postgres pg_isready -q -U nekkora -d nekkora 2>/dev/null && break
        [ "$i" -lt 60 ] || falha "PostgreSQL não respondeu depois da recriação"; sleep 2
    done
    VOL_DEPOIS="$(docker inspect "${E2E_PROJETO}-postgres-1" --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')"
    [ -n "$VOL_ANTES" ] && [ "$VOL_ANTES" = "$VOL_DEPOIS" ] || falha "volume de dados diferente depois da recriação ($VOL_ANTES -> $VOL_DEPOIS)"
    [ "$(sq -c 'SHOW ssl')" = on ] || falha "TLS do PostgreSQL desligado"
    echo "volume de dados preservado: $VOL_DEPOIS; ssl=on; hba=$(sq -c 'SHOW hba_file')"
    # as aplicações reabrem o pool (o servidor reiniciou); o nginx não muda
    "${COMPOSE[@]}" restart platform portal agent-gateway > /dev/null 2>&1 || falha "reinício das aplicações"
    for i in $(seq 1 60); do
        [ "$(curl -s --cacert "$SAIDA/certificado-laboratorio.pem" -o /dev/null -w '%{http_code}' "$(sed -n 's/^api=//p' "$SAIDA/laboratorio.txt")/api/v1/csrf" || true)" = 200 ] && break
        [ "$i" -lt 60 ] || falha "a API não voltou depois do reinício"; sleep 2
    done
    r="$("${COMPOSE[@]}" --profile operacao run --rm -T operadores-init 2>/dev/null | tr -d '\r' | tail -1)"
    [ "$r" = "nekkora 700" ] || falha "volume de credenciais sem dono/permissão esperados ($r)"

    if [ ! -f "$OP/fase_operadores" ]; then
        echo "== 6. operadores: papéis pelo DBA (membros SÓ de nekkora_ops_mfa), bootstrap do CADASTRAR, cadastro do ATIVADOR pela 016"
        # idempotente: um preparo interrompido continua de onde parou (papéis existentes não são recriados)
        if [ "$(sq -c "SELECT count(*) FROM pg_roles WHERE rolname IN ('$CAD', '$ATV')")" != 2 ]; then
            sq > /dev/null <<SQL || falha "papéis dos operadores"
BEGIN;
CREATE ROLE $CAD LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE $ATV LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT nekkora_ops_mfa TO $CAD, $ATV;
SELECT public.ops_bootstrap_operator('$CAD', 'https://idp.nekkora.test', 'sub-$CAD');
COMMIT;
SQL
        fi
        if [ "$(sq -c "SELECT count(*) FROM ops.ops_operators WHERE db_role = '$ATV'")" = 0 ]; then
            cred "$CAD"
            o="$(ferr operador "$CAD" "$ATV")"; echo "$o"
            grep -q "^operador=$ATV id=" <<<"$o" || falha "cadastro de $ATV pela 016"
        fi
        # DEPOIS do cadastro (a 016 só cadastra papel com participação exata em nekkora_ops_mfa): a permissão da 022
        sq -c "GRANT nekkora_org_activation TO $ATV" > /dev/null || falha "concessão de nekkora_org_activation"
        [ "$(sq -c "SELECT pg_has_role('$ATV', 'nekkora_org_activation', 'MEMBER')")" = t ] || falha "concessão não conferida"
        date -u +%Y-%m-%dT%H:%M:%SZ > "$OP/fase_operadores"
    fi

    echo "== 7. conta responsável do operador (fluxo real da API; nunca a conta pessoal) e vínculo pela CLI"
    export NODE_EXTRA_CA_CERTS="$SAIDA/certificado-laboratorio.pem"
    (cd "$RAIZ" && node tools/lab/operador-conta.mjs "$ID" criar && node tools/lab/operador-conta.mjs "$ID" codigo) || falha "conta do operador"
    cred "$ATV"
    v="$(cli "$ATV" vincular-conta "$(cat "$OP/codigo_vinculo")")"; rm -f "$OP/codigo_vinculo"; echo "$v"
    grep -q 'resultado=OK' <<<"$v" || falha "vínculo da conta responsável"
    RESP="$(responsavel)"; [[ "$RESP" =~ ^[0-9a-f-]{36}$ ]] || falha "conta responsável não vinculada"
    { date -u +%Y-%m-%dT%H:%M:%SZ; echo "operador=$ATV responsavel=$RESP"; } > "$OP/preparado"
    echo "OPERADOR LOCAL PRONTO: $ATV, conta responsável $RESP. Ativar: bash tools/lab/local.sh ativar <org> <workers> <simultaneas> <pendentes> <motivo>"
    ;;
ativar|revisar)
    preparado
    [ $# -ge 5 ] || falha "uso: $CMD <org> <workers> <simultaneas> <pendentes> <motivo...>"
    ORG="$1"; W="$2"; S="$3"; P="$4"; shift 4
    [[ "$ORG" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || falha "organização: UUID (veja: bash tools/lab/local.sh operador estado)"
    for n in "$W" "$S" "$P"; do [[ "$n" =~ ^[1-9][0-9]{0,5}$ ]] || falha "limites: inteiros >= 1"; done
    ATO="$([ "$CMD" = ativar ] && echo ativar-organizacao || echo revisar-capacidade)"
    cred "$ATV"
    cli "$ATV" "$ATO" "$ORG" "$(responsavel)" "$W" "$S" "$P" - - "$@"
    ;;
estado)
    preparado
    sq -F ' | ' -c "SELECT o.name, o.organization_id, CASE s.state WHEN 1 THEN 'AGUARDANDO_ATIVACAO' WHEN 2 THEN 'ATIVADA' ELSE '?' END
        FROM public.organizations o LEFT JOIN ops_activation.organization_states s USING (organization_id) ORDER BY o.created_at"
    echo "-- últimos atos (auditoria ops_activation.activation_events)"
    sq -F ' | ' -c "SELECT to_char(e.created_at, 'YYYY-MM-DD HH24:MI:SS'), CASE e.act WHEN 1 THEN 'ATIVACAO' ELSE 'REVISAO' END, e.result,
        coalesce(e.reason_code, '-'), e.organization_id, e.session_role, e.motive FROM ops_activation.activation_events e ORDER BY e.created_at DESC LIMIT 10"
    ;;
*)
    sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
