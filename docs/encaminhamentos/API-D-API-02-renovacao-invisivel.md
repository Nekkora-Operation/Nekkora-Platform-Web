# D-API-02 — pedido de renovação invisível para quem aprova (encaminhamento à equipe da API)

| | |
|---|---|
| Origem | FRONT-V1-001; escopo revisto na FRONT-V1-002 |
| Contrato | API `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5` |
| Operações | `requestClientGrantRenewal` (202, `GrantState.renewal`), `approveClientGrantRenewal` (409 `valores_divergentes` / `sem_renovacao_pendente`), `listClientGrants` (`ClientGrant`) |
| Responsável | Equipe da API |
| Candidato da API | **nenhum** em 30/10/2026 |

## Problema

A aprovação da renovação exige `nextReviewAt`/`expiresAt` IGUAIS aos do pedido, e o solicitante não pode aprovar.
Mas os valores do pedido, o solicitante e o momento do pedido só aparecem na resposta da ESCRITA de quem pediu
(`GrantState.renewal`). Nenhuma leitura os expõe: `ClientGrant` (lista) não tem `renewal`. A outra pessoa, em outra
sessão, não tem como saber o que está aprovando nem se o pedido mudou.

## Situação no frontend (FRONT-V1-002)

- O fluxo anterior ("informe os valores combinados com quem pediu") foi **retirado**: aprovar valores digitados de
  memória não é uma decisão conferida.
- **Aprovar renovação: INDISPONÍVEL.** A ação não é oferecida. O pedido de renovação continua disponível, com o aviso
  de que a aprovação ainda não está na tela.
- Aprovação INICIAL: os valores vêm da lista do servidor (a concessão PENDENTE traz os valores pedidos). Recusa (403
  do solicitante, 409 de estado) mostra o motivo e RELÊ a lista, sem reenviar nem aprovar outros valores.

## Reprodução

1. Laboratório: Ana pede a renovação de uma concessão ATIVA (`POST …/renew`, 202 com `renewal` preenchido).
2. Bia lista as concessões (`GET /client-grants`): o item não traz valores pedidos nem solicitante.
3. E2E `e2e-real/m2-concessoes.spec.ts` (J09) prova o pedido pela tela e a ausência da ação de aprovação.

## Correção pedida

Expor o pedido pendente numa LEITURA autorizada (na lista ou numa leitura da concessão), por exemplo:

```yaml
renewal:
  type: [object, 'null']
  required: [requestId, nextReviewAt, expiresAt, requestedAt, requestedBy]
  properties:
    requestId: { type: string, format: uuid }   # distingue o pedido ATUAL de um substituído
    nextReviewAt: { type: string, format: date-time }
    expiresAt: { type: [string, 'null'], format: date-time }
    requestedAt: { type: string, format: date-time }
    requestedBy: { type: object, required: [membershipId, displayName], properties: { membershipId: { type: string, format: uuid }, displayName: { type: string } } }
```

E, de preferência, aceitar na aprovação o identificador do pedido (`requestId`), para a API recusar (409) a
aprovação de um pedido substituído mesmo que os valores coincidam.

## Critérios de aceite

1. Quem tem `external_access.manage` lê, do servidor, os valores, o solicitante e o momento do pedido atual.
2. O pedido substituído, cancelado (mudança de validade) ou já decidido é distinguível do atual.
3. Frontend (depois do candidato): busca o pedido no servidor, mostra os valores que serão aprovados, desabilita a
   aprovação para o próprio solicitante, trata 409 relendo e pedindo nova conferência — nunca aprova automaticamente
   os novos valores. J09 com duas pessoas cobre: renovação aprovada, valores divergentes (pedido substituído entre a
   leitura e a aprovação) e solicitante recusado.

## Acompanhamento (FRONT-V1-003, 30/10/2026)

Sem candidato (`origin/main` = `e04a57c`). Entrega esperada: leitura autorizada do pedido pendente com valores,
solicitante e **identificador ou versão do pedido conferido na aprovação**. Quando existir, o frontend fecha J09 com:

1. segunda pessoa aprova a renovação com os valores lidos do servidor;
2. o próprio solicitante tem a aprovação recusada (e a tela não oferece a ação a ele);
3. pedido SUBSTITUÍDO entre a leitura e a aprovação — inclusive com os MESMOS valores — é recusado pelo identificador
   ou versão; a tela relê e exige nova conferência, sem aprovar automaticamente.

**Issue na API (aberta em 30/10/2026, FRONT-V1-003):** https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/38
