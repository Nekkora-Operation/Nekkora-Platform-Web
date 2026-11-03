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
# E-mail REAL pelo Microsoft 365 (opcional; tools/lab/compose.m365.yml). Os links continuam em http://localhost:5173:
#   bash tools/lab/local.sh email-real credenciais <código>  credenciais de 1 h da função de leitura (código do MFA)
#   bash tools/lab/local.sh email-real ligar          transporte m365 no lugar da caixa (só destinatários da lista;
#                                                      teto de 20 tentativas compartilhado com o ensaio dono do material)
#   bash tools/lab/local.sh email-real desligar       volta à caixa local e apaga as credenciais
#   bash tools/lab/local.sh email-real estado         ligado/desligado, tentativas usadas e validade das credenciais
#   (material M365 fora do Git em LOCAL_M365_DIR, padrão ~/.nekkora/homologacao/ensaio-api-v1-003/m365)
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
    # e-mail REAL ligado (local.sh email-real ligar): transporte m365 no lugar da caixa (compose.m365.yml)
    if [ -f "$SEG/email-real" ]; then
        m365_exportar
        COMPOSE+=(-f "$aqui_m/compose.m365.yml")
    fi
}
# material M365 (fora do Git): o do ensaio que tem a autorização do envio real; o teto de tentativas é o desse diretório
M365_DIR="${LOCAL_M365_DIR:-$HOME/.nekkora/homologacao/ensaio-api-v1-003/m365}"
M365_AWS="$SEG/m365-aws.env"
email_real_py() { python "$(cygpath -m "$LAB_API_REPO/ops/homologacao/lib/email_real.py" 2>/dev/null || echo "$LAB_API_REPO/ops/homologacao/lib/email_real.py")" "$@"; }
m365_exportar() {
    [ -f "$M365_DIR/fila.env" ] && [ -f "$M365_DIR/destinatarios.txt" ] && [ -d "$M365_DIR/tentativas" ] \
        || falha "material M365 incompleto em $M365_DIR (fila.env, destinatarios.txt, tentativas/)"
    export LAB_M365_DIR="$(cygpath -m "$M365_DIR" 2>/dev/null || echo "$M365_DIR")"
    export LAB_M365_AWS_ENV="$(cygpath -m "$M365_AWS" 2>/dev/null || echo "$M365_AWS")"
    export LAB_M365_SQUID="$LAB_API_REPO/ops/homologacao/proxy/squid.conf"
    [ -f "$M365_AWS" ] || : > "$M365_AWS"   # o compose exige o arquivo; vazio = sem credencial (a partida recusa)
    LAB_M365_DESTINATARIOS="$(email_real_py destinatarios "$(cygpath -m "$M365_DIR/destinatarios.txt" 2>/dev/null || echo "$M365_DIR/destinatarios.txt")")" \
        || falha "lista de destinatários recusada ($M365_DIR/destinatarios.txt)"
    export LAB_M365_DESTINATARIOS
}
m365_tentativas() { find "$M365_DIR/tentativas" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' '; }
m365_credencial_ok() {   # $1 = minutos mínimos de validade
    [ -s "$M365_AWS" ] && email_real_py credenciais "$(cygpath -m "$M365_AWS" 2>/dev/null || echo "$M365_AWS")" --minimo "$1" > /dev/null 2>&1
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
    if [ -f "$SEG/email-real" ]; then
        # a Platform lê o segredo do M365 na partida: sem credencial válida ela não sobe com o transporte real
        m365_credencial_ok 5 || falha "e-mail real ligado e credenciais da AWS vencidas: bash tools/lab/local.sh email-real credenciais <código do MFA> (ou email-real desligar)"
        "${COMPOSE[@]}" up -d proxy-m365
    fi
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
    "${COMPOSE[@]}" start postgres redis   # o redis também: depois de "parar", sem ele a API responde 503 e o TLS não confirma
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
email-real)
    # envio REAL pelo Microsoft 365 (compose.m365.yml). Os links continuam apontando para http://localhost:5173.
    docker_ok
    sub="${1:-estado}"; shift || true
    case "$sub" in
    credenciais)
        # credenciais de 1 h da função de leitura do segredo, com o código do MFA por argumento (o aws.exe lê o prompt
        # do console do Windows, não do stdin); gravadas direto no arquivo, nada impresso
        carregar
        codigo="${1:-}"; [[ "$codigo" =~ ^[0-9]{6}$ ]] || falha "uso: local.sh email-real credenciais <código de 6 dígitos do MFA>"
        [ -f "$M365_DIR/aws-local.env" ] || falha "$M365_DIR/aws-local.env ausente (CONTA_AWS, MFA_SERIAL)"
        conta="$(sed -n 's/^CONTA_AWS=\([0-9]\{12\}\)\r\{0,1\}$/\1/p' "$M365_DIR/aws-local.env")"
        mfa="$(sed -n 's/^MFA_SERIAL=\(arn:aws:iam::[0-9]\{12\}:mfa\/[A-Za-z0-9+=,.@_/-]*\)\r\{0,1\}$/\1/p' "$M365_DIR/aws-local.env")"
        [ -n "$conta" ] && [ -n "$mfa" ] || falha "aws-local.env sem CONTA_AWS ou MFA_SERIAL válidos"
        aws sts get-caller-identity --profile nekkora-login > /dev/null 2>&1 || falha "sem sessão da AWS: aws login --profile nekkora-login"
        tmp="$M365_AWS.novo"; (umask 077; : > "$tmp")
        MSYS2_ENV_CONV_EXCL='*' MSYS_NO_PATHCONV=1 aws sts assume-role --profile nekkora-login \
            --role-arn "arn:aws:iam::$conta:role/nekkora-homologacao-platform-m365-leitura" --role-session-name nekkora-hml-m365 \
            --serial-number "$mfa" --token-code "$codigo" --duration-seconds 3600 \
            --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken,Expiration]' --output text \
            | tr -d '\r' | awk -F'\t' 'NF==4 {print "AWS_ACCESS_KEY_ID="$1; print "AWS_SECRET_ACCESS_KEY="$2; print "AWS_SESSION_TOKEN="$3; print "AWS_CREDENTIAL_EXPIRATION="$4}' > "$tmp" \
            || { rm -f "$tmp"; falha "a AWS recusou (código vencido ou já usado? sessão do nekkora-login?)"; }
        [ "$(grep -c '=.' "$tmp")" = 4 ] || { rm -f "$tmp"; falha "credenciais não obtidas"; }
        mv "$tmp" "$M365_AWS"
        email_real_py credenciais "$(cygpath -m "$M365_AWS" 2>/dev/null || echo "$M365_AWS")" --minimo 20 || { rm -f "$M365_AWS"; falha "credenciais recusadas (apagadas)"; }
        ;;
    ligar)
        carregar
        m365_exportar
        m365_credencial_ok 20 || falha "credenciais da AWS ausentes ou com menos de 20 min: bash tools/lab/local.sh email-real credenciais <código do MFA>"
        [ "$(m365_tentativas)" -lt 20 ] || falha "teto global de tentativas atingido ($(m365_tentativas)/20): nada ligado"
        echo "tentativas usadas: $(m365_tentativas)/20 (teto global, compartilhado com o ensaio)"
        : > "$SEG/email-real"; carregar
        "${COMPOSE[@]}" config -q || { rm -f "$SEG/email-real"; falha "sobreposição do e-mail real não renderiza; nada ligado"; }
        ini="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        "${COMPOSE[@]}" up -d proxy-m365
        "${COMPOSE[@]}" up -d --force-recreate --no-deps platform
        ok=""
        for i in $(seq 1 60); do
            eventos="$("${COMPOSE[@]}" logs --no-color --since "$ini" platform 2>&1 \
                | grep -oE 'evento=mail\.(segredo_carregado|destinatarios_restritos|teto_tentativas_configurado)[^"]*' | sort -u || true)"
            if grep -q 'segredo_carregado origem=aws-secrets-manager' <<<"$eventos" && grep -q 'destinatarios_restritos' <<<"$eventos" \
                && grep -q 'teto_tentativas_configurado maximo=20 ' <<<"$eventos"; then ok=1; break; fi
            sleep 3
        done
        if [ -z "$ok" ]; then
            echo "a Platform não confirmou o transporte real; desligando" >&2
            bash "$0" email-real desligar; exit 1
        fi
        printf '%s\n' "$eventos" | sed 's/impressao=[^ ]*/impressao=<omitida>/'
        echo "E-MAIL REAL LIGADO no laboratório $ID: só para os destinatários da lista; links para http://localhost:5173."
        echo "Desligar: bash tools/lab/local.sh email-real desligar"
        ;;
    desligar)
        carregar
        if [ -f "$SEG/email-real" ]; then
            "${COMPOSE[@]}" stop proxy-m365 > /dev/null 2>&1 || true
            "${COMPOSE[@]}" rm -f proxy-m365 > /dev/null 2>&1 || true
            rm -f "$SEG/email-real"; carregar
            "${COMPOSE[@]}" up -d --force-recreate --no-deps platform
        fi
        rm -f "$M365_AWS"
        echo "e-mail real DESLIGADO: proxy removido, credenciais apagadas, mensagens de volta à caixa local"
        ;;
    estado)
        carregar
        echo "e-mail real: $([ -f "$SEG/email-real" ] && echo LIGADO || echo "desligado (caixa local)")"
        echo "tentativas usadas: $(m365_tentativas)/20 (teto global)"
        if m365_credencial_ok 1; then email_real_py credenciais "$(cygpath -m "$M365_AWS" 2>/dev/null || echo "$M365_AWS")"; else echo "credenciais da AWS: ausentes ou vencidas"; fi
        ;;
    *) falha "uso: local.sh email-real credenciais <código>|ligar|desligar|estado";;
    esac
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
