# D-API-01 — `oneOf` ambíguo na confirmação do fator (encaminhamento à equipe da API)

| | |
|---|---|
| Origem | FRONT-V1-001, reconfirmado na FRONT-V1-002 |
| Contrato | `Nekkora-Platform-API` `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5`, `api/openapi/nekkora-api-v1.yaml` (sha256 `157bd545…5b30`) |
| Operação | `identityConfirmMfaEnrollment` — `POST /api/v1/auth/mfa/enroll/confirm`, resposta 200 |
| Responsável pela correção | Equipe da API (o frontend não altera a API) |
| Candidato da API | **nenhum** em `origin/main` nem em branches remotas em 30/10/2026 |

## Problema

A resposta 200 é `oneOf: [IdentityEnrollmentConfirmation, IdentityFactorReplacement]`. Nenhum dos dois esquemas fecha
propriedades (`additionalProperties` ausente) e os campos de um estão contidos nos do outro. A resposta real do modo
**desafio** (`recoveryCodes`, `csrfToken`, `restricted: false`) satisfaz os DOIS ramos; pela regra do `oneOf`
(exatamente um), toda resposta real é inválida contra o contrato publicado.

## Reprodução mínima

1. `src/api/validate.test.ts`, caso `D-API-01`: valida um corpo com a forma real contra
   `violations('identityConfirmMfaEnrollment', …)` e obtém a violação do `oneOf`.
2. Contra a API real (laboratório descartável `frontlab-001`): cadastro → primeiro login → cadastro do fator → a
   resposta 200 da confirmação. Antes da medida temporária, a tela mostrava "Algo deu errado" (E2E J01).

## Medida temporária no frontend (documentada e estrita)

`src/api/identity.ts` confere a resposta pelo esquema EXATO do modo que o próprio cliente pediu (`challenge` →
`IdentityEnrollmentConfirmation`, `session` → `IdentityFactorReplacement`) com `validatedAs`, no status documentado.
Nenhuma validação foi desligada: campo ausente, tipo errado ou status fora do contrato continuam sendo recusados.

## Correção pedida (qualquer uma)

- trocar `oneOf` por `anyOf`; ou
- fechar os dois esquemas (`additionalProperties: false`) e torná-los mutuamente exclusivos; ou
- discriminar os ramos por um campo (`mode`) com `discriminator`.

## Critérios de aceite

1. `violations('identityConfirmMfaEnrollment', respostaReal)` vazio para as respostas reais dos DOIS modos (desafio
   e sessão), com o contrato sincronizado (`npm run contract:sync -- <commit>`).
2. Uma resposta com campo obrigatório ausente continua inválida.
3. O frontend então remove `validatedAs` dessa operação e demonstra os dois caminhos reais no laboratório (J01 e a
   troca de fator em J03), registrando o commit da API.

## Acompanhamento (FRONT-V1-003, 30/10/2026)

Sem candidato: `origin/main` da API continua em `e04a57c`; nenhuma issue ou PR aberto no repositório da API sobre isto.
O frontend mantém a validação pelo esquema do modo pedido (estrita). Quando o candidato existir: `npm run contract:sync
-- <commit>`, retirar `validatedAs` de `confirmIdentityEnrollment`, e rodar no laboratório a confirmação INICIAL
(`e2e-real/m1-identidade.spec.ts`, J01) e a TROCA de fator (J03), conferindo que uma resposta inválida continua recusada
(`src/api/validate.test.ts`).

**Issue na API (aberta em 30/10/2026, FRONT-V1-003):** https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/37
