#!/usr/bin/env bash
# Remove SOMENTE a stack do frontend (projeto proprio; sem volume nomeado). Nunca "down -v" nem limpeza global.
set -euo pipefail
E2E_PROJETO="${E2E_PROJETO:-nekkora-web}"
case "$E2E_PROJETO" in nekkora-platform|nekkora-portal-dev|nekkora-portal-013|nekkora-e2e) echo "projeto protegido" >&2; exit 1;; esac
docker compose -p "$E2E_PROJETO" down
rm -rf "$(cd "$(dirname "$0")/../.." && pwd)/.dev/stack"
