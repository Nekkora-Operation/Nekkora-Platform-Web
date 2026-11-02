# FRONT-V1-001 — relatório de entrega (30/10/2026)

> **HISTÓRICO.** Este é o relatório da FRONT-V1-001, mantido como registro. O estado atual, as provas da FRONT-V1-002 e
> as correções deste texto estão em [`FRONT-V1-002-RELATORIO.md`](FRONT-V1-002-RELATORIO.md). Correções feitas aqui:
> (1) a suíte simulada NÃO teve 80/80 numa rodada: foram 79/80 na primeira rodada e 6/6 no arquivo alterado depois (o
> 80/80 numa rodada única é da FRONT-V1-002, com a lib 0.2.0); (2) "tudo contra a API real" vale para as jornadas
> listadas como API real; estados raros foram provados por testes de componente com respostas de contrato, e há
> fixtures declaradas (limites da organização e limpeza do Redis entre rodadas); (3) o Agent 7986e84 era ancestral de
> ce30397, o que não prova equivalência — a FRONT-V1-002 usa um build do próprio ce30397.

O frontend da Platform passou a cobrir a jornada real: cadastro → confirmação → MFA → organização → acessos →
automação publicada → Agent pareado → autorização local → supervisão. Tudo foi feito contra a API **real**, fixada em
e04a57c, num laboratório descartável. Sem merge e sem produção.

Situação resumida:

- **Frontend pronto** para cadastro, identidade, organizações, acessos, ciclo de vida das automações, Agents/Workers,
  autorizações locais e supervisão.
- **J13: frontend pronto; jornada pendente da aprovação do pacote pela pessoa no Agent.** O Agent real já recebeu a
  autorização e inspecionou o pacote do Studio. A aprovação e o início são atos locais da pessoa e não foram simulados.
- **J09** (concessões): E2E pendente da fixture de cliente externo (D-API-03).

## 1. Funcionalidades integradas à API real

| Área | Telas | Prova contra a API real |
|------|-------|-------------------------|
| Cadastro e confirmação | `/cadastro`, `/cadastro/confirmar#token` (reenvio, link inválido, chave desligada) | J01, J02 |
| Entrada e MFA da identidade | `/entrar`, `/entrar/verificacao`, `/entrar/configurar-autenticador`, sessão restrita | J01, J03, J04 |
| Segurança da conta | `/conta` (senha e códigos com step-up), `/conta/fator` (troca do fator) | J04, J05 |
| Recuperação de senha | `/recuperar-senha[#token]` e `/o/{org}/recuperar-senha` (conta antiga) | J05 |
| Organizações | `/organizacoes` (aguardando ativação, papéis, troca), `/organizacoes/nova` (step-up), `/o/{org}/entrar` | J01/J06 |
| Vinculação de conta antiga | `/vincular-conta` (duas provas) | componente (a conta antiga não tem rota de criação: fixture futura) |
| Workspaces | criar (workspace.lifecycle) | J07/J08, J10 |
| Convites, papéis e vínculo | `/o/{org}/administracao/convites`, `/membros/:userId`, `/o/{org}/convite#token` | J07/J08 |
| Concessões | aprovar, pedir/aprovar renovação, revisar KEEP/SUSPEND/REVOKE, pedir de novo | componente (E2E: J09 pendente) |
| Auditoria | `/o/{org}/administracao/auditoria` | J07/J08 |
| Automações e versões | criar automação e versão, `/o/{org}/versoes/:id` (pacote, conferência, publicação) | J10/J11 |
| Agents e Workers | `/o/{org}/agents` (código, rotação, revogação), `/o/{org}/workers` | J12 (Agent real) |
| Autorização local | na versão publicada e no workspace | J12 |
| Supervisão | `/o/{org}/supervisao`, `/o/{org}/supervisao/:runId` | J13 (§2); estados raros por fixture de contrato |

### Regras atendidas em todas as telas

- Sessões de identidade e de organização separadas. O CSRF fica só em memória. Trocar de organização é um gesto
  explícito, porque o cookie é um por origem. Há reentrada pela identidade. "Sair" encerra a organização e a identidade.
- Step-up é pedido imediatamente antes do ato (`StepUpDialog`):
  - recusa do step-up = nada enviado;
  - recusa do ato ≠ resultado desconhecido;
  - nada é repetido automaticamente;
  - a incerteza bloqueia nova confirmação até a pessoa conferir.
- Os códigos HTTP são tratados como o contrato define:
  - 401 → reentrada;
  - 403 → recusa;
  - 404 → oculto ou chave desligada ("indisponível");
  - 409 → conflito;
  - 422 → motivo do pacote em português;
  - 429 → Retry-After;
  - 503 → indisponível.
- Falha de consulta nunca aparece como lista vazia.
- Tokens de link, códigos MFA, códigos de recuperação, otpauth e códigos de pareamento ficam só em memória. Não vão para
  storage, URL, console nem analytics. O token sai da barra na carga da página e só é enviado quando a pessoa confirma.
- O navegador nunca chama `/agent/api/v1`. Não há botão de execução, cancelamento ou despacho remoto.

## 2. Provas

| Tipo | O que provou |
|------|--------------|
| **API real** (`e2e-real/`, `playwright.real.config.ts`, laboratório `frontlab-001`) | J01–J05, J06, J07/J08, J10/J11, J12 e J13 (§2.1) |
| **Agent real** (build 7986e84, ancestral de ce30397; cópia em `tools/lab/saidas/<id>/agent-app`) | J12: pareamento pelo código exibido na tela, Agent Ativo/Conectado com heartbeat, Worker no workspace, autorização vigente para a impressão `5664f1a5…`. J13: §2.1 |
| **Fixtures declaradas** | (1) limites da organização (010, `lab.mjs limites`), porque a ativação operacional não tem ferramenta no laboratório (B2); (2) Redis do laboratório zerado entre rodadas (`lab.mjs limpar-redis`, registrado). Nenhuma identidade, organização, versão, autorização ou execução foi semeada |
| **Testes de componente** (respostas por rota conferidas contra o contrato em modo estrito) | estados raros: desfecho desconhecido, histórico incompleto, expurgo, etapas indisponíveis, 503/403, resultado desconhecido na criação, step-up recusado, chaves desligadas |
| **API simulada** (suíte legada 8.7, `npm run e2e`) | regressão das telas anteriores: 79/80 na primeira rodada (a regra da raiz mudou de propósito); depois de atualizar o teste, 6/6 no arquivo alterado — não houve rodada completa 80/80 nesta missão |

### 2.1 J13 — execução local com o Agent real

Última rodada: `e2e-real/m4-agent.spec.ts`, API e04a57c, Agent 7986e84. Linha do tempo pelo log do Agent:

1. `PLATFORM_PAIRED` com o código emitido na tela.
2. Autorização criada pelo navegador.
3. O Agent reaberto reconecta e baixa a autorização: `PLATFORM_AUTHORIZATIONS count=1` (este build só baixa ao conectar).
4. Alt+E e a pasta do pacote: `EXEC_PACKAGE_INSPECTED kind=STUDIO_PYTHON mode=LIST`.
5. **Aprovação do pacote:** o botão "Aprovar este pacote…" não tem atalho de teclado nem segue a ordem de foco. O
   laboratório do Agent o clicava pela cor. É o ato da PESSOA, e não foi substituído por cópia de aprovação nem por
   outro atalho.

Para concluir com uma pessoa (passos 12 e 13 do roteiro):

1. Com o Agent aberto, Alt+E.
2. Pasta `tools/lab/saidas/frontlab-001/pacote-studio-real`.
3. Clicar em "Aprovar este pacote…" e depois em "Aprovar".
4. Alt+Y: Python `Nekkora-RPA-Framework/.venv/Scripts/python.exe`.
5. Alt+E: `entrada-j13.csv`.
6. Alt+A: `saida-automacao`.
7. Alt+I.

A supervisão (`/o/{org}/supervisao`) passa a mostrar a execução. O teste
retoma do passo de supervisão (que espera o fim do acompanhamento e confere processo, desfecho e histórico).

Estados que não dependem do Agent foram provados por fixtures de contrato (`supervision.test.tsx`): desfecho
desconhecido, histórico incompleto com motivo, retenção parcial, etapas indisponíveis, 503/403.

## 3. Limitações, dependências e fora do escopo

### Bloqueios

| # | Dono | Bloqueio | Situação |
|---|------|----------|----------|
| B1 | API/operação | O runner de homologação para em 026→027; não há armazenamento persistente de artefatos | Só o laboratório descartável tem a 028 |
| B2 | API/operação | Ativação de organização sem ferramenta no laboratório | Fixture declarada de limites; a tela mostra "Aguardando ativação" e não tem botão de ativação |
| B5 | Lib | A release 0.2.0 da lib (contraste AA, Inter local) ainda não foi integrada | Próxima etapa |
| B6 | Studio | O pacote usado é o real gerado pelo Studio (fixture da API), não um gerado agora de 14b30f7 | — |

### Divergências da API (`docs/DIVERGENCIAS.md`)

- **D-API-01:** `oneOf` ambíguo na confirmação do fator.
- **D-API-02:** o pedido de renovação não aparece em nenhuma leitura.
- **D-API-03:** não há leitura dos vínculos de cliente. A jornada externa completa não foi inventada.

### Lib

- `Field` não é exportado.
- O `Input` não serve para `type=file`.

O campo de arquivo foi composto com as classes da lib, e o caso foi encaminhado à equipe da lib.

### Pendências de teste

- J09 E2E: fixture de cliente externo.
- J14: rede interrompida durante a execução, com o nginx pausado de forma controlada.
- J15: sucesso, cancelamento local e UNKNOWN reproduzidos com o Agent.
- 503 de armazenamento numa stack sem `NEKKORA_ARTEFATOS_DIR`. Hoje coberto por componente; o caminho real fica para
  um laboratório sem artefatos.

### Fora do escopo por contrato

- Despacho e cancelamento remotos.
- Agenda.
- Entrega de segredos.
- Portal externo e cadastro de cliente.
- Painéis de consumo e SLA.
- Novas escritas usam o `StepUpDialog`, com as mesmas regras do registro de escritas da F6a, mas por página: o
  resultado incerto não sobrevive a sair da página.

## 4. Commits, ambiente e testes

Base: `origin/main` 7851e20. Branches empilhados, sem merge:

| Branch | Conteúdo |
|--------|----------|
| `feat/front-v1-m0-contrato-inventario` | contrato fixado, laboratório e inventário |
| `feat/front-v1-m1-identidade` | identidade |
| `feat/front-v1-m2-acessos` | acessos |
| `feat/front-v1-m3-automacoes` | automações |
| `feat/front-v1-m4-agents-supervisao` | Agents e supervisão |

Ambiente:

- API e04a57c, migrations 001–028 em instalação limpa;
- laboratório `frontlab-001` (`https://localhost:55891`, sub-rede 10.251.60.0/24);
- Agent 7986e84;
- Nekkora-lib c4c479f;
- Node 24.19.0;
- Chromium do Playwright.

| Suíte | Resultado |
|-------|-----------|
| `npm run check` (typecheck, vitest, contract:check, build) no M4 | 32 arquivos, **391 testes passando**, 0 falhas, 0 pulados; contrato = e04a57c; build ok |
| `e2e-real` (API real) | J01, J02, J03, J04, J05, J07/J08, J10/J11 e J12 (Agent real) passando; J13 até `EXEC_PACKAGE_INSPECTED` (§2.1). Falhas anteriores investigadas e corrigidas (D-API-01, rótulos, corridas de teste, limitador R9 real) |
| `npm run e2e` (API simulada) | 79/80 na primeira rodada (regra da raiz mudada de propósito); teste atualizado, 6/6 no arquivo |

## 5. Roteiro para repetir

| Passo | Ação humana | Interface | Resposta esperada |
|-------|-------------|-----------|-------------------|
| 1 | Subir o laboratório: `LAB_PORTA=55891 LAB_PG_PORTA=55892 LAB_REDE=10.251.60 bash tools/lab/subir.sh frontlab-00N ../npa-int` | terminal | `LABORATORIO OK` |
| 2 | `NEKKORA_API_URL=https://localhost:55891 npm run dev` | terminal | Vite em `http://localhost:5173` |
| 3 | Pedir cadastro com um e-mail sintético | `/cadastro` | "Confira seu e-mail" |
| 4 | Pegar o link da caixa: `node tools/lab/lab.mjs frontlab-00N caixa` e `… token IDENTITY_SIGNUP_CONFIRMATION <e-mail>`, abrir `/cadastro/confirmar#token=…` | navegador | "Cadastro concluído" |
| 5 | Entrar e configurar o autenticador; guardar os códigos fora das evidências | `/entrar` | `/organizacoes` vazia |
| 6 | Criar a organização (step-up) | `/organizacoes/nova` | "Aguardando ativação" |
| 7 | **Etapa operacional externa ao front:** `node tools/lab/lab.mjs frontlab-00N limites <org> <e-mail>` (fixture declarada) | terminal | `fixtures.txt` registra |
| 8 | Entrar na organização; criar workspace, automação e versão | área da organização | versão em rascunho |
| 9 | Montar o ZIP: `python tools/lab/empacotar.py <pasta do Studio> <saida.zip>`; enviar, conferir e publicar (step-up) | `/o/{org}/versoes/:id` | "Publicada (imutável)", impressão `5664f1a5…` |
| 10 | Gerar o código de pareamento com Worker novo (step-up); preparar e abrir o Agent: `tools/lab/agent.ps1 -Acao preparar` / `iniciar`; colar o código no Agent (Alt+A) | `/o/{org}/agents` + Agent | Agent "Ativo · Conectado" |
| 11 | Autorizar o Worker no workspace e a execução local da versão (step-up) | `/o/{org}/workers`, versão | autorização "Vigente"; nada iniciado |
| 12 | **No Agent:** Alt+E, pasta do pacote, aprovar o pacote, Python do projeto, entrada e saída, Alt+I | Agent | a execução aparece em `/o/{org}/supervisao` |
| 13 | Acompanhar a supervisão até "Acompanhamento automático encerrado" | navegador | as cinco dimensões, sem porcentagem |
| 14 | (J14) Pausar e retomar o nginx do laboratório durante a execução: `node tools/lab/lab.mjs frontlab-00N compose pause nginx` / `unpause nginx` | terminal | a tela mostra "dados podem estar desatualizados" e depois retoma sem eventos duplicados |

## 6. Estado dos serviços depois do ensaio

- O laboratório `frontlab-001` continua no ar (o Agent da cópia foi encerrado), descartável:
  - containers `nekkora-frontlab-001-*`;
  - segredos em `~/.nekkora/front-lab/frontlab-001`;
  - estado em `tools/lab/saidas/frontlab-001`, fora do git.
- Para remover: `node tools/lab/lab.mjs frontlab-001 compose down`, apagando os volumes do projeto só se for desejado.
- O Agent do laboratório é uma cópia em `tools/lab/saidas/frontlab-001/agent-app`. Encerrar com
  `tools/lab/agent.ps1 -Acao parar`.
- Não foram tocados:
  - os laboratórios `agentlab-*` e `ensaio-*`;
  - os checkouts `agent-int`, `Nekkora-Platform-API`, `Nekkora-lib` e `Nekkora-Studio`;
  - AWS, M365 e DNS.
- Nenhum e-mail real foi enviado.
