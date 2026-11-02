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
#   bash tools/lab/local.sh parar                      para tudo SEM apagar dados (docker compose stop)
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
    COMPOSE=(docker compose -f "$LAB_API_REPO/api/e2e/compose.e2e.yml" -f "$AQUI/compose.front.yml")
    # com o operador local preparado, o PostgreSQL é o da sobreposição (TLS e regras dos operadores)
    if [ -f "$SEG/operador/preparado" ]; then
        export OPERADOR_DIR="$(cygpath -m "$SEG/operador" 2>/dev/null || echo "$SEG/operador")"
        COMPOSE+=(-f "$AQUI/compose.operador.yml")
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
operador)
    docker_ok
    bash "$AQUI/operador.sh" "$ID" "$@"
    ;;
ativar)
    docker_ok
    bash "$AQUI/operador.sh" "$ID" ativar "$@"
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
