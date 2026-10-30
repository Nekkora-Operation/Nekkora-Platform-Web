# D-API-03 — leitura autorizada dos vínculos de clientes (encaminhamento à equipe da API)

| | |
|---|---|
| Origem | FRONT-V1-001 |
| Contrato | API `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5` |
| Operação afetada | `createClientGrant` (exige `clientMembershipId`) |
| Responsável | Equipe da API (e produto, para a jornada externa completa — fora desta missão) |
| Candidato da API | **nenhum** em 30/10/2026 |

## Problema

Uma concessão nova exige `clientMembershipId`, mas não há leitura que liste os vínculos (contas externas) de um
cliente. Clientes, workspaces de cliente e contas externas também não são criados por rota humana.

## Situação no frontend

- Pedido novo só a partir de uma concessão existente ("Pedir de novo": mesma conta e workspace). Não há seletor com
  IDs fictícios, campo para colar UUID nem consulta direta ao banco.
- Laboratório (só ensaio): `node tools/lab/lab.mjs <id> cliente <org>` cria cliente, workspace do cliente e conta
  externa — **fixture declarada**, registrada em `fixtures.txt`, sem concessão. No J09 o primeiro pedido é feito pela
  API real com a sessão e o CSRF da solicitante (declarado no teste); todos os seguintes passam pela tela.

## Correção pedida

`GET /api/v1/o/{org}/clients/{client}/memberships` (ou equivalente), com `external_access.manage`, devolvendo
`clientMembershipId`, nome, e-mail e situação do vínculo, paginado, com a mesma regra de não revelar existência fora da
organização.

## Critérios de aceite

1. Quem tem `external_access.manage` escolhe a conta externa e o workspace do cliente a partir de leituras do servidor.
2. Sem a permissão: 403; cliente de outra organização: lista vazia ou 404 conforme a regra geral.
3. Frontend: tela "Nova concessão" com seletores alimentados por essas leituras; J09 deixa de precisar do primeiro
   pedido pela API.

## Acompanhamento (FRONT-V1-003, 30/10/2026)

Sem candidato (`origin/main` = `e04a57c`). Entrega esperada: leitura autorizada e PAGINADA dos vínculos externos
existentes. Quando existir, o frontend cria a PRIMEIRA concessão pela interface, escolhendo conta e workspace a partir
dessas leituras (o J09 deixa de criar o primeiro pedido pela API). A criação e a entrada completa de novos clientes
externos continuam sendo uma entrega distinta.
