#!/usr/bin/env bash
# PLATFORM-LOCAL-001 — uso PESSOAL e local da Platform (frontend + API real) no Windows, pelo Git Bash.
#
# Camada fina sobre o laboratório existente (tools/lab/subir.sh, tls-renovar.sh e lab.mjs): mesma stack E2E da API
# (sem alterar a API), migrations pelo migrador suportado, segredos aleatórios só em ~/.nekkora/front-lab/<id>, e-mail
# pela caixa de HOMOLOGAÇÃO (nada sai da máquina). O que este script acrescenta é o ciclo do dia a dia: parar sem
# apagar dados, subir de novo, ver o estado, iniciar o frontend e mostrar o link da mensagem da caixa.
#
#   bash tools/lab/local.sh instalar <copia da API>   primeira vez: cria o ambiente (migrations do zero, uma única vez)
#   bash tools/lab/local.sh subir                      sobe de novo um ambiente já instalado (dados preservados)
#   bash tools/lab/local.sh front                      inicia o frontend em http://localhost:5173 (Ctrl+C encerra)
#   bash tools/lab/local.sh estado                     containers, resposta da API e certificado
#   bash tools/lab/local.sh caixa                      lista as mensagens da caixa local (sem links)
#   bash tools/lab/local.sh link <e-mail>              mostra NESTE terminal o link da última confirmação de cadastro
#   bash tools/lab/local.sh convite <e-mail>           mostra NESTE terminal o link do último convite para o e-mail
#   bash tools/lab/local.sh parar                      para tudo SEM apagar dados (docker compose stop)
#   bash tools/lab/local.sh atualizar <copia da API>   leva o ambiente JÁ instalado a uma revisão nova da API sem
#                                                      reinstalar: cópia de segurança do banco, só as migrations novas
#                                                      pelo migrador suportado, imagens novas da API (PLATFORM-LOCAL-002)
#
# Operação da Nekkora no laboratório (NÃO é da tela; PLATFORM-LOCAL-002, tools/lab/operador.sh):
#   bash tools/lab/local.sh operador preparar          uma vez: operador local da ativação (TLS do banco, CA operacional,
#                                                      papéis op_lab_*, conta responsável do operador), dados preservados
#   bash tools/lab/local.sh operador estado            organizações, estado de ativação e últimos atos (somente leitura)
#   bash tools/lab/local.sh ativar <org> <workers> <simultaneas> <pendentes> <motivo...>
#                                                      ativa a organização pela CLI real (ativar-organizacao, 022)
#
# Variáveis (opcionais): LOCAL_ID (padrão frontlab-local), LOCAL_PORTA (47443), LOCAL_PG_PORTA (47432),
# LOCAL_REDE (10.251.80). As portas padrão ficam ABAIXO de 49152: no Windows, o Hyper-V reserva blocos da faixa dinâmica
# (49152–65535), e essas reservas mudam a cada reinício (`netsh int ipv4 show excludedportrange protocol=tcp`).
#
# Não há comando destrutivo aqui. Apagar o ambiente é um procedimento à parte, descrito no guia (docs/USO-LOCAL.md).
set -euo pipefail

ID="${LOCAL_ID:-frontlab-local}"
AQUI="$(cd "$(dirname "$0")" && pwd)"
RAIZ="$(cd "$AQUI/../.." && pwd)"
SEG="$HOME/.nekkora/front-lab/$ID"
SAIDA="$AQUI/saidas/$ID"

falha() { echo "ERRO: $*" >&2; exit 1; }
carregar() {
    [ -f "$SEG/segredos.env" ] || falha "ambiente $ID não instalado (rode: bash tools/lab/local.sh instalar <copia da API>)"
    set -a; . "$SEG/segredos.env"; set +a
    # caminhos no formato C:/... (Git Bash): valem com e sem a conversão automática de caminhos (MSYS_NO_PATHCONV)
    local aqui_m; aqui_m="$(cygpath -m "$AQUI" 2>/dev/null || echo "$AQUI")"
    COMPOSE=(docker compose -f "$LAB_API_REPO/api/e2e/compose.e2e.yml" -f "$aqui_m/compose.front.yml")
    # com o operador local preparado, o PostgreSQL é o da sobreposição (TLS e regras dos operadores)
    if [ -f "$SEG/operador/preparado" ]; then
        export OPERADOR_DIR="$(cygpath -m "$SEG/operador" 2>/dev/null || echo "$SEG/operador")"
        COMPOSE+=(-f "$aqui_m/compose.operador.yml")
    fi
}
docker_ok() { docker info >/dev/null 2>&1 || falha "o Docker não responde: abra o Docker Desktop e espere 'Engine running'"; }
base() { sed -n 's/^api=//p' "$SAIDA/laboratorio.txt"; }
api_status() { curl -s --cacert "$SAIDA/certificado-laboratorio.pem" -o /dev/null -w '%{http_code}' "$(base)/api/v1/csrf" || true; }

cmd="${1:-}"; shift || true
case "$cmd" in
instalar)
    docker_ok
    [ -n "${1:-}" ] || falha "uso: local.sh instalar <copia da API>"
    LAB_PORTA="${LOCAL_PORTA:-47443}" LAB_PG_PORTA="${LOCAL_PG_PORTA:-47432}" LAB_REDE="${LOCAL_REDE:-10.251.80}" \
        bash "$AQUI/subir.sh" "$ID" "$1"
    echo "instalado. Próximo passo: bash tools/lab/local.sh front"
    ;;
subir)
    docker_ok; carregar
    # o nginx resolve os upstreams ao iniciar: as aplicações sobem antes dele
    "${COMPOSE[@]}" start postgres redis
    for i in $(seq 1 60); do
        "${COMPOSE[@]}" exec -T postgres pg_isready -q -U nekkora -d nekkora 2>/dev/null && break
        [ "$i" -lt 60 ] || falha "PostgreSQL não respondeu"
        sleep 2
    done
    "${COMPOSE[@]}" start platform portal agent-gateway
    # a chave TLS do nginx não fica em disco (é apagada assim que ele a carrega): cada subida gera um certificado novo
    bash "$AQUI/tls-renovar.sh" "$ID"
    echo "API pronta em $(base). Próximo passo: bash tools/lab/local.sh front"
    ;;
front)
    carregar
    [ "$(api_status)" = "200" ] || falha "a API não responde em $(base) (rode: bash tools/lab/local.sh subir)"
    cd "$RAIZ"
    # o Vite confere o certificado do laboratório (sem desligar a verificação TLS)
    # versão em execução mostrada na interface: o commit da API instalada neste laboratório
    NEKKORA_API_COMMIT="$(sed -n 's/^api_commit=//p' "$SAIDA/laboratorio.txt" | head -1)" \
    NEKKORA_API_URL="$(base)" NEKKORA_API_CA="$SAIDA/certificado-laboratorio.pem" npm run dev
    ;;
estado)
    docker_ok; carregar
    "${COMPOSE[@]}" ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'
    echo "API: $(base)/api/v1/csrf -> $(api_status) (200 = pronta)"
    echo "certificado: $(openssl x509 -in "$SAIDA/certificado-laboratorio.pem" -noout -enddate 2>/dev/null)"
    ;;
caixa)
    carregar; cd "$RAIZ"; node tools/lab/lab.mjs "$ID" caixa
    ;;
link)
    carregar; cd "$RAIZ"
    [ -n "${1:-}" ] || falha "uso: local.sh link <e-mail>"
    node tools/lab/lab.mjs "$ID" link "$1"
    ;;
convite)
    carregar; cd "$RAIZ"
    [ -n "${1:-}" ] || falha "uso: local.sh convite <e-mail>"
    node tools/lab/lab.mjs "$ID" convite "$1"
    ;;
operador)
    docker_ok
    bash "$AQUI/operador.sh" "$ID" "$@"
    ;;
ativar)
    docker_ok
    bash "$AQUI/operador.sh" "$ID" ativar "$@"
    ;;
atualizar)
    # PLATFORM-LOCAL-002: banco preservado. Nada é recriado: as migrations que o banco ainda não tem são aplicadas pelo
    # mesmo migrador da instalação (db/bootstrap/aplicar_como_migrador.sh, janelas de SUPERUSER com retirada 0|0|0),
    # depois de uma cópia de segurança; as já aplicadas têm de ser IDÊNTICAS às da cópia nova (mesma história).
    docker_ok; carregar
    NOVA="${1:-}"
    [ -n "$NOVA" ] && [ -d "$NOVA/db/migrations" ] && [ -f "$NOVA/api/e2e/compose.e2e.yml" ] || falha "uso: local.sh atualizar <copia da API na revisão nova>"
    NOVA="$(cd "$NOVA" && pwd)"
    [ -z "$(git -C "$NOVA" status --porcelain --untracked-files=no)" ] || falha "a cópia $NOVA tem alterações locais; use uma cópia limpa"
    COMMIT_NOVO="$(git -C "$NOVA" rev-parse HEAD)"
    # a API tem de ser a revisão em que o contrato DESTE frontend está fixado (contract/SOURCE.json), como na instalação
    FIXADO="$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' "$RAIZ/contract/SOURCE.json")"
    [ "$COMMIT_NOVO" = "$FIXADO" ] || falha "cópia da API em $COMMIT_NOVO; o contrato deste frontend está fixado em $FIXADO (revisão incompatível)"
    psql_adm() { "${COMPOSE[@]}" exec -T postgres psql -X -At -v ON_ERROR_STOP=1 -U nekkora -d nekkora "$@"; }
    "${COMPOSE[@]}" start postgres
    for i in $(seq 1 60); do
        "${COMPOSE[@]}" exec -T postgres pg_isready -q -U nekkora -d nekkora 2>/dev/null && break
        [ "$i" -lt 60 ] || falha "PostgreSQL não respondeu"
        sleep 2
    done
    ATUAL="$(psql_adm -c "SELECT coalesce(shobj_description(oid, 'pg_database'), '') FROM pg_database WHERE datname = current_database()" \
        | tr -d '\r' | sed -n 's/^nekkora-inicializacao-completa versao=\([0-9]\{3\}\)$/\1/p')"
    [ -n "$ATUAL" ] || falha "o banco não tem o marcador de inicialização completa: não atualizo (veja docs/USO-LOCAL.md)"
    ALVO="$(ls "$NOVA/db/migrations" | sed -n 's/^\([0-9]\{3\}\)_.*\.sql$/\1/p' | sort | tail -1)"
    [ "$((10#$ALVO))" -ge "$((10#$ATUAL))" ] || falha "a cópia nova ($ALVO) é anterior ao banco ($ATUAL): revisão incompatível"
    MIG="$SEG/migracoes_montadas/migracoes"
    for f in "$MIG"/[0-9][0-9][0-9]_*.sql; do
        n="$(basename "$f")"
        [ -f "$NOVA/db/migrations/$n" ] || falha "a migration aplicada $n não existe na cópia nova: revisão incompatível"
        [ "$(sha256sum < "$f" | cut -c1-64)" = "$(sha256sum < "$NOVA/db/migrations/$n" | cut -c1-64)" ] \
            || falha "a migration aplicada $n difere na cópia nova: revisão incompatível (não atualizo)"
    done
    echo "== banco em $ATUAL; cópia nova $(git -C "$NOVA" log -1 --format='%h %s') com migrations até $ALVO"
    mkdir -p "$SEG/copias"; chmod 700 "$SEG/copias" 2>/dev/null || true
    COPIA="$SEG/copias/antes-de-$ALVO-$(date -u +%Y%m%dT%H%M%SZ).dump"
    "${COMPOSE[@]}" stop nginx platform portal agent-gateway
    "${COMPOSE[@]}" exec -T postgres pg_dump -U nekkora -d nekkora -Fc > "$COPIA"
    chmod 600 "$COPIA" 2>/dev/null || true
    [ -s "$COPIA" ] || falha "a cópia de segurança saiu vazia: nada foi alterado"
    echo "cópia de segurança do banco: $COPIA ($(wc -c < "$COPIA") bytes; fica só neste computador)"
    if [ "$ALVO" != "$ATUAL" ]; then
        DESDE="$(printf '%03d' "$((10#$ATUAL + 1))")"
        for n in $(seq "$((10#$DESDE))" "$((10#$ALVO))"); do
            f=("$NOVA"/db/migrations/$(printf '%03d' "$n")_*.sql)
            [ -f "${f[0]}" ] && [ ${#f[@]} -eq 1 ] || falha "migration $(printf '%03d' "$n") ausente ou ambígua na cópia nova"
            cp "${f[0]}" "$MIG/"
        done
        cp "$NOVA/db/bootstrap/aplicar_como_migrador.sh" "$SEG/migracoes_montadas/bootstrap/"
        (cd "$MIG" && sha256sum ./*.sql) > "$SAIDA/migrations_sha256.txt"
        echo "== migrations $DESDE-$ALVO pelo migrador suportado"
        MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T -e NEKKORA_DB=nekkora -e NEKKORA_DESDE="$DESDE" -e NEKKORA_ATE="$ALVO" \
            -e NEKKORA_MIGRACOES=/docker-entrypoint-initdb.d/migracoes -e NEKKORA_REGISTRO=/tmp/nekkora_janelas.txt postgres \
            sh /docker-entrypoint-initdb.d/bootstrap/aplicar_como_migrador.sh | tee "$SAIDA/atualizacao-$ALVO.txt" \
            || falha "migrador falhou ($SAIDA/atualizacao-$ALVO.txt). A API continua parada; a cópia de segurança está em $COPIA"
        grep -q "aplicar_como_migrador: FALHA" "$SAIDA/atualizacao-$ALVO.txt" && falha "migrador falhou (atualizacao-$ALVO.txt); cópia em $COPIA"
        grep -Eq "aplicar_como_migrador: fim db=nekkora aplicadas=[0-9]+ estado=0\|0\|0" "$SAIDA/atualizacao-$ALVO.txt" || falha "migrador sem fim 0|0|0"
        [ "$(psql_adm -c "SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database()" | tr -d '\r')" \
            = "nekkora-inicializacao-completa versao=$ALVO" ] || falha "marcador do banco diferente de versao=$ALVO"
    fi
    echo "== imagens da API a partir da cópia nova"
    (cd "$NOVA/api" && ./mvnw -q -B -DskipTests package) || falha "build da API na cópia nova falhou (o banco já está em $ALVO; a API antiga não sobe)"
    NOVA_M="$(cygpath -m "$NOVA" 2>/dev/null || echo "$NOVA")"
    sed -i "s#^LAB_API_REPO=.*#LAB_API_REPO=$NOVA_M#" "$SEG/segredos.env"
    carregar
    "${COMPOSE[@]}" up -d --build platform portal agent-gateway
    "${COMPOSE[@]}" up -d nginx
    bash "$AQUI/tls-renovar.sh" "$ID"
    sed -i "s#^api_commit=.*#api_commit=$COMMIT_NOVO#; s#^migrations=.*#migrations=001-$ALVO#" "$SAIDA/laboratorio.txt"
    { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) atualizado para API $COMMIT_NOVO (migrations até $ALVO); antes: $ATUAL; cópia: $(basename "$COPIA")"; } >> "$SAIDA/atualizacoes.txt"
    echo "atualizado: API $(git -C "$NOVA" log -1 --format=%h), banco em $ALVO, dados preservados. Próximo passo: bash tools/lab/local.sh front"
    ;;
parar)
    docker_ok; carregar
    "${COMPOSE[@]}" stop
    echo "parado. Dados preservados (banco no volume ${E2E_PROJETO}_pgdados). Para voltar: bash tools/lab/local.sh subir"
    ;;
*)
    sed -n '2,/^set -euo/{/^set -euo/!p}' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
