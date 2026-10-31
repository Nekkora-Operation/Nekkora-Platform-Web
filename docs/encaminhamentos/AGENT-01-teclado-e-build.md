# AGENT-01 — aprovação do pacote sem caminho de teclado; build marcado como alterado (encaminhamento ao Agent)

| | |
|---|---|
| Agent | `Nekkora-Agent` `ce303970bdf7d91c3cce80af5e15f5e120a6b8cb` (origin/main em 30/10/2026), build isolado em `..\front-v1-002-agent` |
| Pacote do build | `nekkora-agent-0.1.0-windows-x64-lab.zip`, sha256 `63af8d810b4937d27dc7ba3ba87f499e42775205146bb66971e40c590a40e6e5` |
| Responsável | Equipe do Agent (o frontend não altera o Agent) |

## AGENT-01a — "Aprovar este pacote…" sem caminho de teclado confiável

Em `ui/ExecutionDialog.java` os botões da janela "Execução local" têm mnemônico (`Alt+P` pacote, `Alt+Y` Python,
`Alt+E` entrada, `Alt+A` saída, `Alt+I` iniciar), mas o botão **"Aprovar este pacote…"** não tem. No laboratório da
FRONT-V1-001 (build 7986e84), com a janela em primeiro plano, `Tab` a partir de "Pasta do pacote…" seguido de `Espaço`
não abriu a confirmação "Aprovar este pacote?" em 20 s (registro: `tempo esgotado: confirmação "Aprovar este
pacote?"`). Para quem usa só teclado, aprovar o pacote — o ato de consentimento — fica sem caminho garantido.

Reprodução: abrir o Agent, `Alt+E`, `Alt+P`, escolher a pasta de um pacote do Studio, e tentar chegar ao botão
"Aprovar este pacote…" só com `Tab`/`Shift+Tab` e acioná-lo com `Espaço`/`Enter`.

Aceite: mnemônico próprio (ou ordem de foco documentada e testada no perfil `desktop`), foco visível no botão e na
confirmação, e teste de teclado no `-Pdesktop`. Na FRONT-V1-002 a aprovação foi feita pela pessoa com o mouse; o
laboratório NÃO automatiza esse ato.

## AGENT-01b — o próprio build marca "com alterações locais"

Num clone limpo em `ce30397`, `tools\package-windows.ps1` gera `VERSOES.txt` com
`commit: ce30397… (com alterações locais)`. Causa: `DocumentedExamplesTest` regrava
`docs/desktop-001/observabilidade/exemplos/coletor-avisos.jsonl` durante o `verify`; a única diferença é o fim de
linha (`git diff --ignore-cr-at-eol` vazio). O binário vem dos fontes do commit, mas a marca de procedência fica
ambígua.

Aceite: o teste escreve num diretório temporário (ou com o mesmo fim de linha do repositório), e um clone limpo gera
`VERSOES.txt` sem a marca.

## AGENT-01c (ambiente) — testes de processo real dependem do venv do Framework vizinho

`ExecFixtures.python()` usa `NEKKORA_TEST_PYTHON` ou `..\Nekkora-RPA-Framework\.venv`. Com o Framework vizinho em
0.4.0, `PartialProgressTest.cancelamentoReal` e `ObservabilityProcessTest.sentinelasNaoVazam` falham com
`AGT-EXE-009` (o pacote de teste exige `nekkora-rpa` 0.3.0), e o build para. Com `NEKKORA_TEST_PYTHON` apontando para
um venv isolado com o Framework `ca34da8` (0.3.0): 287 testes executados, 0 falhas, 0 erros, 2 pulados (relatórios do Surefire do build usado).

Aceite: o requisito de versão do Framework dos testes fica explícito (variável obrigatória ou venv próprio do build), e
a falha diz que é ambiente, não regressão.
