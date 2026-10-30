# FRONT-V1-002 — correções, integração e fechamento da homologação (30/10/2026)

Continuação da FRONT-V1-001 sobre as cinco branches existentes. Sem merge, sem produção, sem ambientes preservados,
sem AWS/M365/DNS e sem envio real de e-mail. Laboratório descartável `frontlab-001`.

## Situação

- **Jornada principal demonstrada com API real e Agent real:** cadastro → MFA → organização → acessos → automação
  publicada (pacote real do Studio) → Agent pareado → autorização local → **execução iniciada pela pessoa no Agent** →
  supervisão no navegador até o desfecho (J13), com quedas de canal (J14), cancelamento local e desfecho desconhecido
  (J15).
- **Frontend pronto; aprovação da RENOVAÇÃO de concessão bloqueada por D-API-02** (sem leitura do pedido; a ação não é
  oferecida). A criação da PRIMEIRA concessão de um vínculo depende de D-API-03 (feita pela API real no teste, declarado).
- **Não demonstrado:** a ativação operacional da organização (limites gravados por fixture declarada, B2) e o CI dos
  PRs 1–5 (o workflow existe a partir do PR 7; ver §1).
- **PRs não abertos:** não há sessão autorizada do GitHub nesta máquina (`gh` ausente; a credencial guardada não foi
  usada). As branches estão publicadas; a ordem e as bases estão em §1.

## 1. Branches, bases e ordem de integração

Pilha linear; cada branch tem como base a anterior (a primeira, `main` = `7851e204ab262c2a276517c23462d119524fdbd4`).
Integração na ordem abaixo. Nenhum histórico compartilhado foi reescrito: correções posteriores entraram como commits
novos e foram levadas adiante por merge.

| # | Branch | Base | HEAD | Conteúdo |
|---|--------|------|------|----------|
| 1 | `feat/front-v1-m0-contrato-inventario` | `main` | `7aa5d2d96c2f2390ae94b71a48d9c7c98ead6419` | M0 (FRONT-V1-001) |
| 2 | `feat/front-v1-m1-identidade` | 1 | `8e1a3a5ecd7376e6889bf71f8d468078712224f0` | M1 |
| 3 | `feat/front-v1-m2-acessos` | 2 | `9d56fa8c9ca85613cb1ba7c51259e420ee9060f9` | M2 |
| 4 | `feat/front-v1-m3-automacoes` | 3 | `3bd79bc79c8d0799887f99880690c1563e570c3f` | M3 |
| 5 | `feat/front-v1-m4-agents-supervisao` | 4 | `ece15cb06f61a8ce2d75f9533094c59772327116` | M4 |
| 6 | `feat/front-v1-002-incerteza` | 5 | `9c6c98866f5c44352b12337de8104bce2d26428a` | resultado desconhecido persistente; concessões (D-API-02); encaminhamentos da API |
| 7 | `feat/front-v1-002-lib-ci` | 6 | `1a7fd8c3de53f1da21c3374d7fa0cbc1d2c54276` | lib 0.2.0 fixada; CI |
| 8 | `feat/front-v1-002-provas` | 7 | ver o HEAD publicado (este relatório entra nela) | provas com API/Agent reais, a11y, documentação |

PRs planejados: um por branch, com a base da tabela; 1–5 e 8 como rascunho enquanto houver bloqueio externo
(D-API-02/03, B2). CI: roda em `pull_request` e em push para `feat/front-v1-*`; só as branches 7 e 8 têm o workflow.

## 2. Provas por tipo e situação de cada jornada

Tipos: **API real** = navegador contra a API do laboratório (`e2e-real/`); **Agent real** = Agent empacotado do
`ce30397`; **componente** = Vitest com respostas por rota conferidas contra o contrato (modo estrito); **simulador** =
API simulada `mock/` (suíte legada `e2e/`); **fixture** = pré-condição periférica declarada.

| Jornada | Situação | Prova |
|---------|----------|-------|
| J01/J02 cadastro, confirmação, reenvio | Aprovada | API real (caixa de homologação) + componente |
| J03 MFA, sessão restrita | Aprovada | API real + componente. D-API-01: validação pelo esquema do modo pedido (temporária, estrita) |
| J04/J05 credenciais, códigos, recuperação de senha | Aprovada | API real + componente |
| J06 organizações | Aprovada (criação e entrada) / **ativação operacional não demonstrada** | API real; limites 010 por fixture (B2) |
| J07/J08 workspace, convites, papéis, retirada | Aprovada | API real |
| Vinculação de conta antiga | Aprovada | API real (`m1-vinculacao`), conta antiga por fixture; autenticador pelo fluxo real; as duas provas |
| J09 concessões | **Parcial** | API real com 3 pessoas (`m2-concessoes`): aprovação inicial, recusa do solicitante (403), recusa de quem não tem permissão, KEEP sem data, pedido de renovação, conflito 409 relido. **Bloqueado:** aprovação da renovação e "valores divergentes" (D-API-02); primeiro pedido pela API (D-API-03) |
| J10/J11 automação, pacote, publicação | Aprovada | API real, pacote real do Studio (impressão `5664f1a5…`) |
| 503 de artefatos | Aprovada | API real com o `platform` sem armazenamento (`m3-artefatos-503`) |
| J12 Agent, Worker, autorização local | Aprovada | API real + Agent real `ce30397` |
| J13 execução real e supervisão | Aprovada | Agent real + API real, sessão assistida (§3) |
| J14 quedas de canal | Aprovada | Agent real + API real (§3) |
| J15 cancelamento local e desfecho desconhecido | Aprovada | Agent real + API real (§3) |
| J16 HTTP (401/403/404/409/422/429/503) | Aprovada | componente + API real (403, 409, 422, 429 observado no J17, 503) |
| Resultado desconhecido persistente | Aprovada | componente (`uncertainOps.test.tsx`, `pendingOps.test.ts`, f6a*) |
| J17 teclado, foco, zoom 200 %, viewports, recarga, links | Aprovada | API real (`m5-a11y-seguranca`): axe com contraste em 10 telas × 3 larguras |
| J18 segredos | Aprovada | API real (`m5`) + varredura estática (`security.test.tsx`) |

Estados raros da supervisão (histórico incompleto, expurgo, etapas indisponíveis) continuam também em testes de
componente; eles não substituem as provas integradas acima.

## 3. Sessão assistida com o Agent real (J13–J15)

Atos LOCAIS da pessoa, feitos com o mouse no Agent e conferidos no log do próprio Agent (o laboratório só prepara até o
ponto e avisa na tela; nenhuma tecla, clique por cor, cópia de aprovação ou alteração de estado simulou consentimento):
aprovação do pacote (`EXEC_PACKAGE_APPROVED` 15:50:49Z), "Iniciar" em cada execução e "Cancelar execução" na B.

| Execução | Resultado no navegador (do supervisor) | Evidência |
|----------|-----------------------------------------|-----------|
| A — J13 + J14 | Processo Encerrado · Desfecho Conhecido · **Concluída com sucesso** · Histórico Completo; 1 execução; nenhuma sequência de evento repetida | início 16:17:08Z; **J14b** (só Agent–API: `agent-gateway` pausado 16:17:09→16:17:30, execução em curso, navegador falando com a API, 2 desconexões no log do Agent, reconexão); **J14a** (só navegador–API: contexto offline, aviso "dados podem estar desatualizados", volta; o Agent entregou 1 relatório durante a queda) |
| B — J15 cancelamento | Encerrado · Conhecido · **Cancelada** · Completo | `EXEC_CANCEL_REQUESTED` 16:21:50Z → `EXEC_FINISHED state=CANCELLED code=AGT-EXE-024` |
| C — J15 desconhecido | Encerrado · **Desfecho desconhecido** (supervisor) · Completo; nada relançado | início 16:53:24Z; Agent encerrado à força 5 s depois e o processo da execução com ele fora; reaberto: `EXEC_RECONCILED code=AGT-EXE-025 adopted=false` → `PLATFORM_REPORT state=OUTCOME_UNKNOWN` |

Tentativas que não serviram de prova (preservadas em `tools/lab/saidas/frontlab-001/`):

- 1ª e 2ª execuções A: a automação parou por dados (lista com páginas da Wikipédia sem "Ocupação"/"Nacionalidade";
  depois linhas repetidas, recusadas pela planilha — `SINK_REJECTED`). O navegador mostrou corretamente
  "Supervisor: Falhou". A lista final tem 21 biografias com as quatro linhas que a automação lê.
- 3ª execução A: 21 sucessos e 1 recusa de negócio (Rui Barbosa, ocupação vazia) → retirada da lista.
- 1ª execução C: o laboratório esperou o próximo relatório, que só veio no fim; nada a reconciliar. Corrigido.
- Falhas do script do laboratório (não do Agent nem do frontend): pasta de dados presa pelo Windows; `Alt+E` com a
  janela já aberta; teste interrompido por mim com o canal pausado (pausa de 16:05:41 a 16:11:52, registrada).

As execuções A, B e C provadas estão em sessões diferentes do mesmo Agent (A+B numa, C noutra), cada uma com
organização nova; os logs: `sessao-j13-j15-A-aprovada.log`, `sessao-j13-j15-B-aprovada.log`, `sessao-j13-j15.log`.

## 4. Resultado desconhecido persistente (item 3 da missão)

`src/api/pendingOps.ts`: registro versionado em `localStorage` (`nk.op.1.<sha256>` → `{v, s, at, exp}`), gravado ANTES
do envio; chave por sujeito (vínculo da organização ou resumo da sessão de identidade), organização, operação e alvo;
nada em claro. Estados `pending/confirmed/refused/unknown`; `pending` sem dono vivo vira `unknown`; Web Locks (ou sinal
de vida) entre abas; falha do armazenamento impede o envio; expiração (72 h) e "Já conferi; liberar nova tentativa"
nunca são apresentadas como confirmação. Aplicado aos 25 diálogos de mutação e às ações administrativas da F6a
(com restauração das incertezas nas linhas relidas).

Regra alterada de propósito: a MESMA pessoa na MESMA organização continua vendo a incerteza depois de sair e entrar
(antes, F6a-2-R1, ela sumia). Outra pessoa ou organização não vê nada. O registro não substitui idempotência nem
reconciliação no servidor; ausência numa lista não é tratada como prova.

## 5. Biblioteca, build e CI

- `nekkora-lib` 0.2.0, commit `0a29d95fbadb19da74cfa90a55542fb14885458d` (LIB-RELEASE-001), tarball sha256
  `1a2e614576f7c33ec98bbaf1dfe9f0eb6098637ca1075113c666aea6662526a6`, integridade sha512 da evidência da release.
  `scripts/lib.mjs prepare` faz checkout isolado em `.deps/` (o `../Nekkora-lib` de outra sessão não foi tocado),
  build e pacote, e confere o sha256; `package-lock.json` fixa a integridade. O build no Windows deu o mesmo sha256.
- Checkout limpo (clone do GitHub em `d7a1e27`): `lib.mjs prepare` + `npm ci` + `npm run check`. A primeira execução saiu
  com **1** (3 rejeições não tratadas nos testes — corrigido em `8d294db`); as contagens locais anteriores eram lidas sem
  o código de saída.
- CI (`.github/workflows/ci.yml`): lib fixada, `npm ci`, typecheck, Vitest, contrato contra o commit fixado da API,
  build; E2E com a API simulada em job separado, sem repetição. Contagens publicadas como anotação do run.
  - `d17205e23d76d5c8c4d47018bc1b8f2680373c35` (run 41094023367): **Vitest 405/405, 0 falhas, 35 arquivos; E2E
    simulado 80 aprovados, 0 falhas, 0 instáveis, 0 pulados**; contrato e build aprovados.
  - Runs anteriores com falha, preservados: `d7a1e27` e `32064d8` (rejeições não tratadas), e o teste de renovação que
    clicava antes de o envio ser liberado (só no runner do CI; corrigido em `9c6c988`).
- **Fora do CI:** `e2e-real/` (API real, caixa de homologação, Agent real, Windows) — roda no laboratório (§7).
- Composição local mantida: input de arquivo da `VersionPage` (LIB-01).

## 6. Commits de referência

| Componente | Commit |
|------------|--------|
| API (contrato e laboratório) | `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5` (= `origin/main`; OpenAPI sha256 `157bd545…5b30`) |
| Agent | `ce303970bdf7d91c3cce80af5e15f5e120a6b8cb` (= `origin/main`), build isolado; zip sha256 `63af8d810b4937d27dc7ba3ba87f499e42775205146bb66971e40c590a40e6e5`; Surefire: 287 executados, 0 falhas, 0 erros, 2 pulados. `VERSOES.txt` diz "com alterações locais" por causa de um teste do próprio Agent que regrava um exemplo com outro fim de linha (AGENT-01b) |
| Studio Framework (Python da execução) | `ca34da8b769407a0a0e569880f1ba47811306f2c` (`nekkora-rpa` 0.3.0, exigido pelo pacote), venv isolado, Python 3.12.10 |
| Nekkora-lib | `0a29d95fbadb19da74cfa90a55542fb14885458d` (0.2.0) |
| Pacote do Studio | fixture `pacote-studio-real` da API, impressão `5664f1a56556e8137dc6e62c435485469e18501d853a8f51268cb377ce1c0b3d` |

## 7. Fixtures, limpezas e intervenções no laboratório (todas registradas em `fixtures.txt` / `redis_limpo.txt`)

- **Limites da organização (010)** por `lab.mjs limites` em cada organização dos testes de Agent e J17 — a ativação
  operacional NÃO foi demonstrada (B2).
- **Cliente, workspace do cliente e conta externa** (`lab.mjs cliente`, J09), sem concessão.
- **Conta antiga** (`lab.mjs conta-antiga`, vinculação): organização e conta interna só com senha (hash pelo `PhcTool`
  da API); o autenticador foi cadastrado pelo fluxo real.
- **Sem armazenamento de artefatos** (`lab.mjs artefatos off|on`, 503), restaurado ao fim.
- **Canal Agent–API pausado/retomado** (`lab.mjs canal-agent`, J14).
- **Redis zerado ENTRE rodadas** (34 vezes nesta missão, `lab.mjs limpar-redis`): os limitadores de cadastro (R9) e
  de leitura seguram rodadas seguidas. Nenhuma prova de limite de taxa foi aprovada com zeramento durante o cenário.
- **Incidente:** reiniciei o nginx do laboratório e ele não subiu (a chave TLS é apagada por desenho). Recuperado com
  certificado descartável novo (`tools/lab/tls-renovar.sh`), registrado; a confiança do Agent foi refeita.

## 8. Defeitos achados e corrigidos nesta missão

- Diálogos "Pedir renovação" e "Pedir de novo" quebravam ao abrir (data vazia → `RangeError`), desde a FRONT-V1-001.
- Páginas da identidade sem título `h1` (`/organizacoes`, `/organizacoes/nova`, `/conta`, `/conta/fator`,
  `/vincular-conta`).
- Margem de espera dos testes de componente sob carga (renderização > 1 s com ~15 workers); não é repetição.

## 9. Encaminhamentos (`docs/encaminhamentos/`)

API: D-API-01 (`oneOf` ambíguo), D-API-02 (pedido de renovação invisível), D-API-03 (leitura de vínculos). Lib: LIB-01
(`Field` não exportado; `Input type="file"` lança `InvalidStateError` em navegador real — reprodução em
`tools/repro/lib-01`). Agent: AGENT-01 (aprovação sem caminho de teclado; build marcado como alterado; testes de
processo dependentes do venv vizinho). Nenhum candidato da API existia em 30/10/2026.

## 10. Roteiro para repetir

1. Laboratório: `bash tools/lab/subir.sh <id>` (cópia limpa da API no commit fixado). Se o nginx precisar reiniciar:
   `bash tools/lab/tls-renovar.sh <id>`.
2. Frontend: `node scripts/lib.mjs prepare && npm ci && npm run check`.
3. Agent: build isolado do commit da §6 (`tools\prepare-design-system.ps1`, `tools\package-windows.ps1` com
   `NEKKORA_TEST_PYTHON` = venv do Framework 0.3.0); `powershell -File tools/lab/agent.ps1 -Id <id> -Acao preparar`.
4. Provas automáticas, uma por vez, com `node tools/lab/lab.mjs <id> limpar-redis` entre elas:
   `npx playwright test -c playwright.real.config.ts e2e-real/<spec>.spec.ts`.
5. Sessão assistida: `FRONT_LAB_PYTHON=<python do venv 0.3.0> npx playwright test -c playwright.real.config.ts
   e2e-real/m4-execucao.spec.ts --timeout=14400000`; seguir as caixas de mensagem (aprovar uma vez, "Iniciar" em A, B e
   C, "Cancelar execução" em B). `FRONT_LAB_ETAPAS=B,C` repete só algumas execuções.

## 11. Regressão final e estado do laboratório

Regressão proporcional com API real, uma suíte por vez, Redis zerado só ENTRE suítes, sem repetição (primeira
execução de cada): `m1-identidade` 5/5, `m1-vinculacao` 1/1, `m2-acessos` 1/1, `m2-concessoes` 1/1,
`m3-automacoes` 1/1, `m3-artefatos-503` 1/1, `m4-agent` 1/1 (Agent `ce30397`), `m5-a11y-seguranca` 1/1 — **12/12**
(`tools/lab/saidas/frontlab-001/regressao-final.txt`). A sessão assistida (`m4-execucao`) não foi repetida.
A suíte da API não foi rodada (só o frontend mudou).

Estado: `frontlab-001` **parado** (`docker compose stop`: containers e volumes preservados como evidência; nada
apagado); Agent do laboratório encerrado; nenhum Python de execução vivo; Vite parado. Para remover de vez:
`node tools/lab/lab.mjs frontlab-001 compose down -v`. Cópias isoladas criadas nesta missão (podem ser apagadas):
`..ront-v1-002-agent`, `..ront-v1-002-framework`, `..ront-v1-002-limpo`. Os repositórios de outras sessões
(`../Nekkora-lib`, `../Nekkora-RPA-Framework`, `../Nekkora-Agent`, `agent-int`, a API de trabalho) não foram alterados.
Evidências locais (não versionadas: contêm dados do laboratório) em `tools/lab/saidas/frontlab-001/`; nenhuma captura,
trace, QR, código ou token foi versionado (configuração real com trace, screenshot e vídeo desligados).
