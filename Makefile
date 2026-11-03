# Atalhos do Nekkora Platform Web. So encapsula os comandos ja documentados (package.json, docs/USO-LOCAL.md e
# tools/lab/local.sh); os scripts continuam sendo a fonte de verdade e mantem as proprias guardas.
#
# Requisitos: GNU make, bash (Git Bash no Windows), Node/npm e, para a aplicacao inteira local, Docker e Java 21.
# No Windows: `scoop install make` e rodar o make a partir do Git Bash. Uso: `make` ou `make help`.
#
# Aplicacao inteira local (banco + API real + frontend; e-mail pela caixa LOCAL, nada sai da maquina):
#   make instalar              uma vez: Nekkora-lib fixada + dependencias
#   make local-instalar        uma vez: copia da API no commit do contrato, jars e laboratorio (migrations do zero)
#   make local-front           frontend em http://localhost:5173 ligado a API real (Ctrl+C encerra)
#   make local-link E=<email>  link da ultima confirmacao de cadastro enviada para o e-mail
#   make local-parar / make local-subir   parar sem apagar dados / subir de novo

ifeq ($(OS),Windows_NT)
SHELL := bash.exe
else
SHELL := /bin/bash
endif

.DEFAULT_GOAL := help

LAB := bash tools/lab/local.sh
# Repositorio da API (para criar a copia) e a copia LIMPA no commit em que o contrato deste frontend esta fixado
API       ?= ../Nekkora-Platform-API
API_COPIA ?= ../Nekkora-Platform-API-contrato
CONTRATO_COMMIT := $(shell sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' contract/SOURCE.json)
# Parametros dos alvos com argumento
E ?=
ORG ?=
WORKERS ?=
SIMULTANEAS ?=
PENDENTES ?=
MOTIVO ?=

.PHONY: help instalar lib dev typecheck test build check e2e contrato contrato-sync preview \
        api-copia local-instalar local-subir local-front local local-estado local-caixa local-link local-convite \
        local-parar local-atualizar operador-preparar operador-estado ativar

help: ## Lista os alvos
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# --- frontend ------------------------------------------------------------------------------------------------------

lib: ## Prepara a Nekkora-lib fixada em lib.lock.json (.deps/, idempotente)
	npm run lib:prepare

instalar: lib ## Nekkora-lib fixada + dependencias (npm ci)
	npm ci

dev: ## Frontend com a API SIMULADA em memoria (http://localhost:5173; painel em /__mock/)
	npm run dev

typecheck: ## Conferencia de tipos (tsc)
	npm run typecheck

test: ## Testes unitarios (vitest)
	npm test

contrato: ## Confere o cliente gerado contra o contrato fixado (contract/SOURCE.json)
	npm run contract:check

contrato-sync: ## Sincroniza o contrato a partir da API (ver docs antes de usar)
	npm run contract:sync

build: ## Build de producao (dist/)
	npm run build

preview: ## Serve o build de dist/
	npm run preview

check: ## typecheck + testes + contrato + build (o mesmo do CI)
	npm run check

e2e: ## Testes ponta a ponta (Playwright)
	npm run e2e

# --- aplicacao inteira local (tools/lab/local.sh; LOCAL_ID, LOCAL_PORTA, LOCAL_PG_PORTA e LOCAL_REDE pelo ambiente) --

api-copia: ## Copia limpa da API no commit do contrato (git worktree em API_COPIA) e jars
	@[ -n "$(CONTRATO_COMMIT)" ] || { echo "ERRO: commit da API nao encontrado em contract/SOURCE.json"; exit 1; }
	@if [ -d "$(API_COPIA)" ]; then \
	    atual="$$(git -C "$(API_COPIA)" rev-parse HEAD)"; \
	    [ "$$atual" = "$(CONTRATO_COMMIT)" ] || { echo "ERRO: $(API_COPIA) esta em $$atual; o contrato pede $(CONTRATO_COMMIT) (git -C $(API_COPIA) checkout --detach $(CONTRATO_COMMIT))"; exit 1; }; \
	    [ -z "$$(git -C "$(API_COPIA)" status --porcelain --untracked-files=no)" ] || { echo "ERRO: $(API_COPIA) tem alteracoes locais"; exit 1; }; \
	    echo "copia da API: $(API_COPIA) em $(CONTRATO_COMMIT)"; \
	else \
	    git -C "$(API)" fetch -q origin && git -C "$(API)" worktree add --detach "$$(cd "$(dir $(API_COPIA))" && pwd)/$(notdir $(API_COPIA))" $(CONTRATO_COMMIT); \
	fi
	@if ls "$(API_COPIA)"/api/nekkora-platform/target/nekkora-platform-*.jar >/dev/null 2>&1; then echo "jars ja compilados"; \
	else cd "$(API_COPIA)/api" && ./mvnw -q -B -DskipTests package; fi

local-instalar: api-copia ## Primeira vez: banco do zero (migrador), API real e certificado do laboratorio
	$(LAB) instalar "$(API_COPIA)"

local-subir: ## Sobe de novo o laboratorio ja instalado (dados preservados)
	$(LAB) subir

local-front: ## Frontend em http://localhost:5173 ligado a API real do laboratorio
	$(LAB) front

local: local-subir local-front ## local-subir + local-front

local-estado: ## Containers, resposta da API e validade do certificado
	$(LAB) estado

local-caixa: ## Lista as mensagens da caixa de e-mail local (sem links)
	$(LAB) caixa

local-link: ## Link da ultima confirmacao de cadastro: make local-link E=<email>
	@[ -n "$(E)" ] || { echo "uso: make local-link E=<email>"; exit 2; }
	$(LAB) link "$(E)"

local-convite: ## Link do ultimo convite: make local-convite E=<email>
	@[ -n "$(E)" ] || { echo "uso: make local-convite E=<email>"; exit 2; }
	$(LAB) convite "$(E)"

local-parar: ## Para tudo SEM apagar dados
	$(LAB) parar

local-atualizar: api-copia ## Leva o laboratorio a revisao nova da API (copia de seguranca + migrations novas)
	$(LAB) atualizar "$(API_COPIA)"

operador-preparar: ## Uma vez: operador local da ativacao de organizacoes
	$(LAB) operador preparar

operador-estado: ## Organizacoes, ativacao e ultimos atos (somente leitura)
	$(LAB) operador estado

ativar: ## Ativa organizacao: make ativar ORG= WORKERS= SIMULTANEAS= PENDENTES= MOTIVO="..."
	@[ -n "$(ORG)" ] && [ -n "$(WORKERS)" ] && [ -n "$(SIMULTANEAS)" ] && [ -n "$(PENDENTES)" ] && [ -n "$(MOTIVO)" ] \
	    || { echo 'uso: make ativar ORG=<org> WORKERS=<n> SIMULTANEAS=<n> PENDENTES=<n> MOTIVO="..."'; exit 2; }
	$(LAB) ativar "$(ORG)" "$(WORKERS)" "$(SIMULTANEAS)" "$(PENDENTES)" $(MOTIVO)
