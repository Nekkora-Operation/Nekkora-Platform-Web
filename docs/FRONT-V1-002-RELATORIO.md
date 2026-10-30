# FRONT-V1-002 — correções, integração e fechamento da homologação (30/10/2026)

> **Atualização FRONT-V1-003 (30/10/2026).** A seção 0 abaixo é o estado atual para revisão: PRs, HEADs, checks e
> pendências. As seções 1–11 continuam valendo como registro da FRONT-V1-002; onde citam HEADs ou runs, eram os daquele
> momento (os HEADs mudaram depois: ver a seção 0).

## 0. FRONT-V1-003 — estado para revisão

### 0.1 Resultado desconhecido: o prazo de 72 h não libera nada

Achado: até a FRONT-V1-002, depois de 72 h `inspect()` apagava o registro `unknown`, `begin()` o ignorava e a limpeza do
carregamento o removia — uma nova tentativa ficava liberada SEM decisão da pessoa. Corrigido no #15 (`d13164b`):

- `unknown` (e `pending` sem dono vivo) **não expira**; só some pela liberação explícita da pessoa.
- Depois de 72 h a tela continua bloqueando e avisa: "Este registro tem mais de 72 horas e continua sem confirmação: o
  tempo não resolve a dúvida."
- A liberação diz o que faz: "Liberar permite enviar de novo. Não confirma o resultado da tentativa anterior nem garante
  que não haverá duplicidade." O mesmo aviso acompanha "Dispensar aviso" nas ações administrativas.
- Confirmado e recusado (que não bloqueiam nada) continuam sumindo em 10 min.
- Provas (componente, no #15): `src/api/pendingOps.test.ts` e `src/uncertainOps.test.tsx` — 73 h, recarga (com a limpeza
  do carregamento), segunda aba, envio em curso de aba morta, isolamento por pessoa e por organização, e só a liberação
  explícita permite UM novo envio.

### 0.2 PRs, HEADs e checks

Pilha linear; integrar na ordem, cada PR sobre o anterior. Nenhum merge foi feito; as correções da base subiram para as
branches seguintes por commits de merge comuns (sem reescrever histórico). A entrada futura na `main` deve ser
conferida pelo conteúdo, não pela ordem.

Cada candidato agora tem CI próprio: #10–#15 preparam `../Nekkora-lib` no commit fixado `c4c479f` (o da FRONT-V1-001);
#16–#17 usam a lib 0.2.0 por tarball conferido. "Push" = run do HEAD da branch; "PR" = run do evento `pull_request`,
que o GitHub executa sobre o commit de merge do HEAD com a base (o SHA testado aparece entre parênteses).
Contagens: Vitest · E2E com API simulada.

| PR | Base | HEAD | Push | PR | Estado |
|----|------|------|------|----|--------|
| [#10](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/10) `m0-contrato-inventario` | `main` | `aa3ff80` | [41114425936](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41114425936) 368/368 · 80/80 | [41114436646](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41114436646) (`bc5040b`) 368/368 · 80/80 | pronto |
| [#11](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/11) `m1-identidade` | #10 | `db3bfef` | [41114426192](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41114426192) 382/382 · 80/80 | [41114435956](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41114435956) (`a388b20`) 382/382 · 80/80 | pronto |
| [#12](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/12) `m2-acessos` | #11 | `9b8f62b` | [41122777489](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122777489) 383/383 · 80/80 | [41122785666](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122785666) (`567e34b`) 383/383 · 80/80 | pronto (entrega parcial) |
| [#13](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/13) `m3-automacoes` | #12 | `68774e8` | [41122777095](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122777095) 383/383 · 80/80 | [41122787321](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122787321) (`4f1ce93`) 383/383 · 80/80 | pronto |
| [#14](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/14) `m4-agents-supervisao` | #13 | `a1c1353` | [41122776941](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122776941) 392/392 · 80/80 | [41122785911](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122785911) (`a7e4143`) 392/392 · 80/80 | pronto |
| [#15](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/15) `002-incerteza` | #14 | `fee83f4` | [41122777284](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122777284) 407/407 · 80/80 | [41122786733](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122786733) (`950c49f`) 407/407 · 80/80 | pronto |
| [#16](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/16) `002-lib-ci` | #15 | `1b0818d` | [41122778196](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122778196) 408/408 · 80/80 | [41122787080](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122787080) (`5eda425`) 408/408 · 80/80 | pronto |
| [#17](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/pull/17) `002-provas` | #16 | este commit de relatório; os checks dele ficam no PR | — | — | pronto |

Contrato e build passaram em todos os runs da tabela. Os runs do HEAD anterior do #17 (`539446d`, antes deste relatório): push [41122777429](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122777429) e PR [41122786894](https://github.com/Nekkora-Operation/Nekkora-Platform-Web/actions/runs/41122786894) (`8c3cd19`), 408/408 · 80/80. No #11, um run de PR anterior do mesmo HEAD foi CANCELADO
pela regra de concorrência (41114435510); o válido é o da tabela.

Nenhum PR é draft. O #12 continha a aprovação de renovação por valores digitados, que só saía no #15; agora a
retirada está no próprio #12 (`9b8f62b`, levada às branches seguintes por merge comum), e nenhum candidato depende de um
merge futuro para remover esse comportamento. O #12 é uma **entrega parcial**: a aprovação da renovação está
explicitamente indisponível e o pedido de renovação continua. Achado ao testar o #12: o cliente HTTP descartava o corpo
do 202, e o pedido de renovação aparecia como "resultado não confirmado" — a leitura do corpo de 202 (que só entrava no
#13) desceu para o #12. Quando a API entregar D-API-02, a tela precisará ser adaptada para ler e conferir o pedido do
servidor; religar a ação não basta.

Falhas encontradas no caminho, corrigidas na causa (sem repetir até passar): auxiliar de animação do E2E com
`AbortError` de animação cancelada (f6a3; runs de PR do #12, #14 e #17), e espera de 1 s curta para o runner (f5; run de
PR do #12). As duas correções foram levadas à base (#10) e subiram pela pilha.

### 0.3 Concluído, bloqueado, responsável e evidência

| Item | Situação | Responsável | Evidência |
|------|----------|-------------|-----------|
| Resultado desconhecido persistente, sem expiração silenciosa | Concluído | Frontend | §0.1; #15 |
| CI de cada candidato | Concluído | Frontend | §0.2 |
| Jornadas | Demonstradas conforme a matriz de evidências (§2); **J09 parcial**, com aprovação da renovação e primeira concessão pela interface dependentes da API; ativação operacional não demonstrada neste laboratório | Frontend | §2 e regressão final (§11), API real |
| J13–J15 com Agent real | Concluído (não repetido: nada desses caminhos mudou) | Frontend + pessoa no Agent | §3 |
| D-API-01 confirmação do MFA | Bloqueado (sem candidato; medida temporária estrita no frontend) | Equipe da API | [issue #37](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/37); `docs/encaminhamentos/API-D-API-01-*.md` |
| D-API-02 leitura do pedido de renovação (prioridade); J09 completa | Bloqueado | Equipe da API | [issue #38](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/38); `docs/encaminhamentos/API-D-API-02-*.md`; J09 parcial em `e2e-real/m2-concessoes.spec.ts` |
| D-API-03 leitura dos vínculos; primeira concessão pela tela (não é a jornada completa de clientes externos) | Bloqueado | Equipe da API | [issue #39](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/39); `docs/encaminhamentos/API-D-API-03-*.md` |
| Ativação operacional da organização | Não demonstrada neste laboratório (a fixture de capacidade não a substitui) | API/operação (B2) | `docs/FRONT-V1-INVENTARIO.md` §7 |
| LIB-01 (`Field`, `Input type="file"`) | Encaminhado | Equipe da Nekkora-lib | `docs/encaminhamentos/LIB-01-*.md` |
| AGENT-01 (aprovação sem teclado; build marcado; venv dos testes) | Encaminhado | Equipe do Agent | `docs/encaminhamentos/AGENT-01-*.md` |

Nenhum candidato da API existia em 30/10/2026 (`origin/main` = `e04a57c`). Encaminhamento aberto como issues no repositório
da API: [#37](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/37) (D-API-01), [#38](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/38) (D-API-02, prioridade), [#39](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/39) (D-API-03), cada uma com
reprodução, comportamento esperado, critérios de aceite, referência do contrato e PRs afetados.
O laboratório `frontlab-001` segue parado com containers e volumes preservados; nenhum volume foi excluído.


Continuação da FRONT-V1-001 sobre as cinco branches existentes. Sem merge, sem produção, sem ambientes preservados,
sem AWS/M365/DNS e sem envio real de e-mail. Laboratório descartável `frontlab-001`.

## Situação (FRONT-V1-002 — histórico)

> Superado pela §0: os oito PRs foram abertos (#10–#17), todos têm CI próprio e nenhum é draft.

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
