# FRONT-V1-001 — M0: inventário, contrato, ambiente e plano

Data: 30/10/2026. Fonte da missão: relatório "Estado atual da engenharia e diretrizes para Orquestração, Supervisão e
Front-end" (30/10/2026). Os números daquele relatório foram tratados como evidência reportada. Tudo abaixo foi conferido
contra os commits citados.

## 1. Base

| Item | Valor |
|------|-------|
| Frontend | `Nekkora-Operation/Nekkora-Platform-Web`. A base é `origin/main` 7851e20 (F6a-4). A `main` local estava atrasada (107a6c1) e não foi usada. |
| API (contrato fixado) | `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5` = `origin/main`. Fixado em `contract/SOURCE.json` (sha256 do OpenAPI `157bd545…`). |
| Nekkora-lib | Checkout local `main` c4c479f, via `file:../Nekkora-lib`. `origin/main` tem a release 0.2.0 (0a29d95: contraste AA, Inter local), ainda não integrada (ver §7, B5). |
| Agent / Studio | Referências ce30397 (Agent, em `agent-int`) e 14b30f7 (Studio). 14b30f7 é a `main` remota do Studio, mas ainda não foi buscado no clone local (ver B6). |
| CI do frontend | Não há (`.github` ausente). O gate é `npm run check` local, com a lib resolvida pelo irmão `../Nekkora-lib` (README). |

O working tree da API (`Nekkora-Platform-API`, branch `feat/email-real-homologacao`, atrasada e com arquivos não
rastreados) e o `agent-int` (alteração local de outra sessão) **não foram tocados**. O contrato é lido por `git show` do
commit fixado. O laboratório usa a cópia `npa-int`, limpa, em e04a57c.

## 2. Contrato

- `npm run contract:sync -- <commit>` copia o OpenAPI do commit (por `git show`) e grava `contract/SOURCE.json`.
- `npm run contract:check` faz quatro conferências:
  - tipos e esquemas gerados = cópia;
  - sha256 da cópia = o registrado;
  - cópia = arquivo no commit fixado;
  - aviso se `origin/main` da API mudar o contrato.
- Antes, a comparação com o backend nunca rodava, porque o caminho `../nekkora-platform` não existia.
- Toda resposta consumida é validada em execução contra o esquema do status recebido (`src/api/validate.ts`). O validador
  passou a cobrir `maximum` e mapas (`additionalProperties` com esquema), usados pelos contratos do Agent.
- O contrato passou de 38 operações (8.7 + GAP-02/03/06 + 013) para **95 operações** (86 caminhos). As 57 novas cobrem:
  cadastro, entrada geral, organizações da identidade e troca, vinculação, convites, papéis, concessões (pedido,
  aprovação, renovação, revisão), auditoria de acessos, emergência 016, canal do Agent (pessoas) e o ciclo de vida das
  automações.

### Fatos do contrato que mudam o desenho

1. **Duas sessões.**
   - A sessão de identidade (`__Host-nekkora_id`, 12 h, CSRF próprio, recuperável por `GET /api/v1/me/session`) dá acesso
     a organizações, criação, vinculação, convites e conta.
   - A sessão de organização (`__Host-nekkora_session`) nasce da troca `POST /api/v1/sessions/organization` e mantém as
     rotas `/api/v1/o/{org}/…`.
   - O cookie de organização é **um por origem**: entrar noutra organização derruba a anterior em todas as abas.
2. **Step-up.**
   - Na identidade: `POST /api/v1/auth/step-up` (TOTP, 5 min), para criar organização, trocar senha, regenerar códigos,
     aceitar convite e vincular.
   - Na organização: `POST /api/v1/o/{org}/auth/mfa/step-up`. Na sessão vinculada (nascida da troca), o TOTP é o da
     identidade e o cookie de identidade vai junto.
   - Atos com step-up: emitir código de pareamento ou rotação, revogar Agent, autorizar Worker no workspace, autorizar
     execução local, publicar versão, redefinir MFA de membro.
3. **Sessão restrita.** A entrada com código de recuperação cria uma sessão restrita: só cadastrar fator novo e sair.
   `/me/organizations`, a troca e as demais rotas respondem 403.
4. **Links de e-mail.** Os caminhos das páginas são contrato (`MailTemplates`, token no fragmento):
   - `/cadastro/confirmar`
   - `/recuperar-senha`
   - `/o/{org}/recuperar-senha`
   - `/o/{org}/convite`
   - `/o/{org}/mfa-emergencia/confirmar` e `/o/{org}/mfa-emergencia/contestar`

   O frontend usava `/o/{org}/reset-password` e `/o/{org}/verify-email`. Não há mais e-mail de verificação por
   organização, e esses caminhos ficam como compatibilidade.
5. **Chaves por rota.** Cada rota de identidade tem sua chave (`cadastro`, `entrada-geral`, `criacao-organizacao`,
   `recuperacao-senha`, `vinculacao`, `convites`). Desligada, a rota responde **404**, que a interface mostra como
   "indisponível", nunca como erro de credencial.
6. **Workers.** Não há rota para criar Worker isoladamente. O Worker nasce no pedido de código de pareamento com
   `workerName` (exige `worker.manage` e capacidade de Workers na organização ativada).
7. **Códigos de pareamento.** Não há listagem de códigos. O cancelamento usa o `enrollmentId`, que só aparece na resposta
   de criação.
8. **Versões.** A listagem de versões é a do GAP-06 (`draft`/`published`, sem artefato). O detalhe do ciclo de vida
   (`GET /automation-versions/{id}`) traz o artefato, a impressão e a procedência.
9. **Supervisão.** `agent-runs` (lista, detalhe, eventos com cursor opaco, `limit` 1–100, padrão 25) é distinto de
   `/executions` (catálogo histórico GAP-06) e do Portal.

## 3. Inventário das telas existentes (base 7851e20)

Todas foram feitas e testadas **só contra a API simulada** (`mock/`, contrato 8.7). Nenhuma passou pela API real antes
desta missão.

| Tela / rota | Classificação | Observação |
|-------------|---------------|------------|
| `/o/{org}/login`, `/mfa`, `/mfa/setup` | parcial (legado) | Entrada por conta de organização (8.7). Vale só para conta **não vinculada**; conta vinculada recebe o 401 genérico. Fica como "acesso por conta da organização". |
| `/o/{org}/forgot-password`, `/reset-password` | parcial (legado) | Contrato ok, mas o link do e-mail é `/o/{org}/recuperar-senha`: falta a rota. |
| `/o/{org}/verify-email` | obsoleta | A API não emite mais esse link. Mantida por compatibilidade, fora da navegação. |
| `/o/{org}/resend-verification` | ausente (flag desligada) | Sem rota na API (D2). |
| `/o/{org}` início interno | parcial | Precisa do estado de ativação (`organizationActivationState`) e de próximas ações reais. |
| `execucoes`, `execucoes/:id` | simulada → parcial | Catálogo GAP-06 `/executions`. Não é a supervisão do Agent. |
| `workspaces`, `workspaces/:id`, `automacoes/:id` | parcial | Só leitura. Falta criar workspace, automação, versão, artefato e publicação. |
| `administracao/membros`, `clientes`, `concessoes` (+ suspender, reativar, revogar, redefinir MFA) | parcial | Leitura e escritas F6a. Faltam convites, papéis, retirada de vínculo, pedido, aprovação, renovação, revisão e auditoria. |
| Painel `/__mock/` | simulada (só desenvolvimento) | Não entra no build. Continua servindo os testes legados. |
| Cadastro, confirmação e reenvio | ausente | M1 |
| Entrada geral, MFA da identidade, sessão restrita, logout | ausente | M1 |
| Recuperação de senha da identidade | ausente | M1 |
| Segurança da conta (senha, códigos, troca de fator) | ausente | M1 |
| Organizações (lista, criação, troca, aguardando ativação) | ausente | M2 |
| Convites (emitir, reenviar, revogar, aceitar), papéis, retirada, vinculação | ausente | M2 |
| Concessões (pedir, aprovar, renovar, revisar KEEP/SUSPEND/REVOKE), auditoria | ausente | M2 |
| Automações e versões (criar, rascunho, ZIP, conferir, publicar) | ausente | M3 |
| Agents, Workers, códigos, vínculo Worker–workspace, autorizações locais | ausente | M4 |
| Supervisão de Agent runs (lista, detalhe, eventos, polling) | ausente | M4 |
| Emergência 016 (confirmar/contestar aviso) | ausente | Rota existe. Avaliar no M2 (não expõe poderes de operador). |

## 4. Design system

- Os componentes vêm todos da Nekkora-lib: AppShell, AuthLayout, Dialog, Table, StateView, StatusRegion, LoadMore,
  DescriptionList, CodeInput, QrCode, Steps, Alert e Badge, entre outros.
- O frontend não copia componentes da lib. Composições locais ficam em `src/pages/*/shared.tsx`.
- Lacunas da lib percebidas até aqui (sem bloqueio): seletor de arquivo com progresso e área de cópia de segredo
  temporário. Serão compostos localmente com `Input`, `Button` e `StatusRegion`. Um encaminhamento separado à lib só se
  o padrão se repetir.

## 5. Ambiente de ensaio (API real)

`tools/lab/subir.sh` sobe a stack E2E da própria API (inalterada) e acrescenta `tools/lab/compose.front.yml`:

- origem pública `http://localhost:5173` (Vite com `NEKKORA_API_URL`);
- cadastro ligado;
- e-mail pelo transporte de **homologação** (caixa em volume exclusivo, nenhum envio externo);
- `NEKKORA_ARTEFATOS_DIR` com volume próprio;
- limites de memória.

As migrations são todas as contíguas da cópia (001–028), aplicadas pelo migrador suportado em instalação limpa. Não há
SQL manual.

| Laboratório | Valor |
|-------------|-------|
| `frontlab-001` | API `https://localhost:55891` (nginx TLS descartável), Postgres `127.0.0.1:55892`, sub-rede 10.251.60.0/24, ambiente `ensaio-frontlab-001`, migrations 001–028 (fim 0\|0\|0) |
| Fumaça | `GET /api/v1/csrf` 200 → `POST /api/v1/signup` 202 → mensagem `IDENTITY_SIGNUP_CONFIRMATION` capturada na caixa (`node tools/lab/lab.mjs frontlab-001 caixa`) |

Os laboratórios preservados (`agentlab-001…005` e os `ensaio-*` de homologação) não foram tocados.

## 6. Matriz de rastreabilidade (jornada → tela → rota → permissão → CSRF → step-up → chave → estados → teste)

Legenda de CSRF: **pre** = pré-autenticação; **des** = desafio; **id** = sessão de identidade; **org** = sessão de
organização.

| Jornada | Tela (rota web) | Operação(ões) da API | Permissão | CSRF | Step-up | Chave | Estados e erros próprios | Testes |
|---------|-----------------|----------------------|-----------|------|---------|-------|--------------------------|--------|
| J01/J02 cadastro | `/cadastro`, `/cadastro/confirmar#token` | signup, confirmSignup, resendSignupConfirmation | — | pre | — | cadastro | 202 uniforme; 400 = link inválido (expirado, revogado, usado, substituído); 404 = indisponível; 429/503 | componente + E2E real (caixa) |
| J01/J03 entrada | `/entrar`, `/entrar/verificacao`, `/entrar/configurar-autenticador` | identityLogin, identityVerifyMfa, identityStart/ConfirmMfaEnrollment | — | pre → des | — | entrada-geral | 401 genérico; desafio de 5 min e 5 tentativas; 400 ambíguo (dois cookies); 404 | componente + E2E real |
| J04 recuperação MFA | `/entrar/verificacao` (código) → `/conta/fator` | identityVerifyMfa (`restricted`), identityStart/ConfirmMfaEnrollment (modo sessão) | — | id | sessão restrita: 15 min da marca | entrada-geral | sessão restrita visível; 403 sem prova | E2E real |
| J05 credenciais | `/conta` | identityStepUp, identityChangePassword, identityRegenerateRecoveryCodes, identityLogout | — | id | 5 min | entrada-geral | 403 = sem step-up, senha atual errada ou restrita; 401 = sessão caiu | componente + E2E real |
| J05 recuperação de senha | `/recuperar-senha[#token]` | identityRequest/ConfirmPasswordReset | — | pre | — | recuperacao-senha | 202 uniforme; 400 = link inválido; aviso de que o MFA continua | E2E real (caixa) |
| J06 organizações | `/organizacoes`, `/organizacoes/nova`, `/o/{org}/entrar` | identityOrganizations, identityCreateOrganization, exchangeOrganizationSession | criação: elegibilidade (R5, teto de 10) | id | criação: 5 min | entrada-geral, criacao-organizacao | lista vazia legítima; `activationState`; `sem_acesso` genérico; R11 429; 503 | E2E real |
| J07 permissões | todas as `/o/{org}/…` | getMe, getMyPermissions, listWorkspaces | por rota | org | — | — | 401 → reentrada; 403 → recusa; 404 oculto; troca de organização e abas | componente + E2E real |
| J08 pessoas | `/o/{org}/administracao/membros`, `/o/{org}/convite#token` | invitations*, roles*, membership/revoke, acceptInvitation | org.manage (convites e papéis de admin); role.assign_operator_viewer no workspace | org; aceite: id | aceite: 5 min | convites | 409 already_member, account_exists, account_unavailable; último admin; EMISSOR_SEM_AUTORIDADE | E2E real |
| J08 vínculo | `/vincular-conta` | identityLinkStart, identityLinkConfirm | — | id | confirmação: 5 min | vinculacao | 401 único na prova; 403 recusa | E2E real (conta legada preparada como fixture declarada) |
| J09 concessões | `/o/{org}/administracao/concessoes` | client-grants (criar, aprovar, renovar, aprovar renovação, revisar, revogar) | external_access.manage | org | — | — | quem pede não aprova; valores conferidos (409); KEEP com data omitida preserva o prazo | E2E real |
| J10/J11 automação | `/o/{org}/workspaces/:id`, `/o/{org}/automacoes/:id`, `/o/{org}/versoes/:id` | createWorkspace, createAutomation, createAutomationVersion, updateAutomationVersionDraft, putAutomationVersionArtifact, getAutomationVersion, publishAutomationVersion | workspace.lifecycle, automation.manage, automation.publish | org | publicação | — | 422 com motivo; 409 publicada ou divergente; 503 sem armazenamento; upload interrompido | E2E real (ZIP do Studio) |
| J12 Agent e Worker | `/o/{org}/agents`, `/o/{org}/workers` | createAgentPairingCode, cancelAgentCode, listAgents, createAgentRotationCode, revokeAgent, listWorkers, authorize/revokeWorkerInWorkspace | agent.manage, agent_credential.manage, worker_agent.assign, worker.manage, worker_workspace.authorize | org | código, rotação, revogação e autorização no workspace | — | código só na criação; 409 Worker com Agent ativo | E2E real + Agent real |
| J12 autorização local | `/o/{org}/workspaces/:id` (autorizações) | create/list/revokeLocalRunAuthorization | automation.execute / automation.read | org | criação | — | 409 rascunho, sem artefato ou Worker não autorizado | E2E real |
| J13–J15 supervisão | `/o/{org}/supervisao`, `/o/{org}/supervisao/:runId` | listAgentRuns, getAgentRun, listAgentRunEvents | automation.read | org | — | — | as cinco dimensões; "Etapas indisponíveis"; polling com dado desatualizado | componente + Agent real |
| J16 HTTP | todas | — | — | todos | — | — | 401, 403, 404, 409, 422, 429 (Retry-After), 503; nenhuma mutação repetida | componente + E2E real |
| J17/J18 | todas | — | — | — | — | — | teclado, zoom 200%, viewports; sentinelas ausentes em storage, URL, console e analytics | E2E (axe) + estático |

## 7. Quadro de bloqueios e dependências

| # | Dono | Bloqueio | Evidência | Impacto | Retomada | Independente |
|---|------|----------|-----------|---------|----------|--------------|
| B1 | API/operação | O runner de homologação para em 026→027; não há passo 027→028 nem armazenamento persistente de artefatos. | `ops/homologacao/homologacao.sh` (`atualizar` vai até 026>027); relatório de 29/10, R4 | Ambientes preservados não recebem a jornada de artefatos. | Passo 027→028, armazenamento, permissões, quotas, integridade e backup. | O laboratório descartável aplica 001–028 pelo migrador suportado. |
| B2 | API/operação | Ativação de organização só pelo `nekkora-ops` com mTLS, IdP e conta vinculada (stack de homologação). Os laboratórios E2E e do Agent não têm a ferramenta. | `OpsCli`, relatório de 23/10 §2; `ciclo.py` usou fixture SQL declarada | J06 "aguardando ativação" funciona; a etapa seguinte (Workers) exige ativação. | Ferramenta operacional no laboratório descartável, ou aceite da fixture declarada como pré-condição periférica. | A tela mostra o estado e não oferece botão de ativação. |
| B3 | API | A API não emite link de verificação de e-mail por organização nem tem rota de reenvio (D2). | `MailTemplates` | Nenhum: a tela legada fica fora da navegação. | — | — |
| B4 | Agent/infra | O Agent só fala https com a origem do nginx do laboratório (certificado descartável no truststore). | `Destination.java`, `LabComum.ps1` | J12–J15 dependem de configurar o Agent. | Roteiro do laboratório do Agent. | Telas e testes de componente. |
| B5 | Lib | A release 0.2.0 da lib (contraste AA, Inter local) não está no checkout local. | `git log HEAD..origin/main` na lib | Contraste e tipografia finais. | Atualizar o checkout da lib e conferir a regressão visual e de a11y numa etapa própria. | Tudo. |
| B6 | frontend (ensaio) | 14b30f7 é a `main` remota do Studio (`ls-remote`), mas não foi buscado no clone local, que não é alterado nesta missão. | `git cat-file`, `git ls-remote` | J10/J13 precisam de um ZIP real gerado pelo Studio. | Clone descartável do Studio em 14b30f7 para gerar o pacote, ou a fixture versionada da API (pacote real gerado pelo Studio). | Upload com a fixture. |
