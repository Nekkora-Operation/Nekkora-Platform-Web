# Divergências entre a UX planejada e o contrato real da API

> **Situação em 30/10/2026 (FRONT-V1-002).** A seção "Authentication V1" (D1–D10) é **HISTÓRICA**: foi escrita na fase
> em que o frontend rodava só contra a API simulada (`mock/`), antes da entrada geral por identidade. Fica como registro
> das decisões; não descreve o estado atual da integração. O estado atual está em "Divergências encontradas contra a
> API real" e nos encaminhamentos de `docs/encaminhamentos/`.

## Histórico — Authentication V1 (fase da API simulada)

Referência: contrato 8.7 do `nekkora-platform-api` (rotas em `web/Routes.java`, `AuthController`, `AuthService`),
decisões 8.1/8.6/8.7/8.10. Regra seguida: **o frontend representa o contrato como ele é**. Nenhuma regra foi
criada no cliente para compensar diferenças, e o backend não foi alterado. Cada item abaixo precisa de decisão
de produto/API; até lá vale o comportamento descrito em "Frontend hoje".

| # | Planejado | Contrato real | Frontend hoje | Decisão pedida |
|---|-----------|---------------|---------------|----------------|
| D1 | `/o/{organizacao}` com slug legível | Decisão 8.1: identificador público é o **UUID** da organização; não há slug nem endpoint de resolução | Rotas `/o/{uuid}/…`. UUID malformado → "Organização não encontrada". O selo "Acessando a organização" mostra o UUID abreviado (nome completo no `title`) | Slug + resolução pública (nome, estado) quando a API tiver |
| D2 | Tela "Reenviar verificação de e-mail" | **Não existe** rota de reenvio de verificação | Tela, rota e link prontos e testados atrás de `VITE_FEATURE_RESEND_VERIFICATION=true` (desligada). Chamaria `POST /o/{org}/auth/email-verification/request {email}` → 202 genérico — **caminho proposto**, não existente | Criar a rota (202 sempre, limitador R5) ou remover do escopo |
| D3 | Estados distintos: link inválido, expirado, já usado | `email-verification/confirm` e `password-reset/confirm` respondem **400 `invalid_request`** para todos (anti-enumeração) | Um único estado: "Este link não é mais válido" (com a explicação "pode ter expirado, já ter sido usado ou estar incompleto") | Manter (recomendado: não vaza estado do token) |
| D4 | Links de e-mail abrem as telas | A API **não monta links**: o sender local só registra a intenção (tipo + organização), sem destinatário, token ou link. Não há sender real aprovado | Formato proposto: `/o/{org}/reset-password#token=<43>` e `/o/{org}/verify-email#token=<43>`. Fragmento não vai a servidores/Referer; `?token=` também aceito. Token lido uma vez, retirado da URL com `history.replaceState`, só em memória | Adotar o formato no sender de produção |
| D5 | "Login válido sem MFA" | MFA é **obrigatório** para toda conta: login devolve sempre `mfa_required` ou `mfa_enrollment_required` | Não há caminho sem MFA; o teste correspondente cobre o primeiro acesso (setup obrigatório) | Nenhuma (contrato é mais seguro) |
| D6 | Estados EMAIL_VERIFICATION_REQUIRED / ACCOUNT_STATE_ERROR no login | Conta não elegível (e-mail não verificado, conta/organização suspensa, sem vínculo) → **401 genérico**, igual a senha errada | "E-mail ou senha incorretos." para todos; nenhum enum inventado | Manter (anti-enumeração) — ou definir estado revelável só após senha correta |
| D7 | "Organização não encontrada" / "organização suspensa" antes do login | Não há endpoint público de organização; org inexistente ou suspensa só aparece como 401 genérico no login | Só UUID malformado é detectável no cliente; o resto cai na resposta genérica | Endpoint público mínimo (existe/ativa) se o produto quiser a mensagem |
| D8 | "Sessão expirou" vs "você não entrou" | `/me` responde 401 igual para expirada, revogada e inexistente; não informa prazos | O aviso aparece quando esta aba teve sessão (memória). Após recarregar a página, a volta ao login é sem aviso. Timer de inatividade (30 min interna / 15 min portal, a partir da última chamada) só **pergunta à API**; nunca renova | Opcional: código de erro distinto para sessão expirada |
| D9 | Validação de política de senha com mensagem específica | `password-reset/confirm` responde 400 tanto para token inválido quanto para senha fora da política (12–128 code points) | A política é validada localmente antes do envio (mesmos limites, contagem por code point); um 400 é tratado como link inválido | Código de erro distinto para política |
| D10 | Aviso "sessões encerradas" ao usar código de recuperação | `mfa/verify` com `recoveryCode` revoga as demais sessões da conta, sem informar | Aviso na área autenticada: "Você entrou com um código de recuperação" + orientação | — |

**Atualização FRONT-V1-001 (contrato fixado em e04a57c):** a API passou a montar links (`MailTemplates`). D4 está
resolvida pelos caminhos do contrato (`/cadastro/confirmar`, `/recuperar-senha`, `/o/{org}/recuperar-senha`,
`/o/{org}/convite`); `reset-password` e `verify-email` ficaram só como compatibilidade.

## Divergências encontradas contra a API real (FRONT-V1-001)

Achadas no laboratório descartável (API e04a57c, `tools/lab/`). Encaminhadas à equipe da API; o frontend não altera a
API e não afrouxa a validação.

| # | Contrato | Comportamento real | Frontend hoje | Encaminhamento à API |
|---|----------|--------------------|---------------|----------------------|
| D-API-01 (`docs/encaminhamentos/API-D-API-01-confirmacao-fator.md`) | `POST /api/v1/auth/mfa/enroll/confirm` 200: `oneOf [IdentityEnrollmentConfirmation, IdentityFactorReplacement]` | A resposta do modo desafio (`recoveryCodes`, `csrfToken`, `restricted:false`) satisfaz os DOIS ramos (nenhum fecha propriedades): pelo `oneOf`, toda resposta real seria inválida. Reproduzido em `src/api/validate.test.ts` (D-API-01) e no E2E J01, que antes da correção mostrava "Algo deu errado" | O cliente confere a resposta pelo esquema exato do modo que ELE pediu (desafio ou sessão), com o status documentado (`validatedAs`). Nenhuma validação foi desligada | Trocar `oneOf` por `anyOf` ou fechar os esquemas (`additionalProperties: false`). Aceite: `violations('identityConfirmMfaEnrollment', respostaReal)` vazio |
| D-API-02 | Aprovação da renovação exige `nextReviewAt`/`expiresAt` IGUAIS aos do pedido (409 se diferentes) | Os valores do pedido só voltam na resposta da escrita (`GrantState.renewal`); nenhuma LEITURA os expõe (`ClientGrant` da lista não tem `renewal` nem solicitante). A pessoa que aprova, em outra sessão, não vê o que foi pedido | **FRONT-V1-002:** aprovação da renovação **INDISPONÍVEL** (a ação não é oferecida). O fluxo da FRONT-V1-001 ("digite os valores combinados") foi retirado. O pedido de renovação continua | Ver `docs/encaminhamentos/API-D-API-02-renovacao-invisivel.md` |
| D-API-03 (`docs/encaminhamentos/API-D-API-03-vinculos-externos.md`) | Concessão nova exige `clientMembershipId` | Não há rota para listar os vínculos (contas externas) de um cliente; clientes e contas externas também não são criados por rota humana | Pedido novo só a partir de uma concessão existente ("Pedir de novo", mesma conta e workspace). Cadastro de cliente externo NÃO foi inventado | Rota de leitura dos vínculos de cliente (e a jornada externa completa, fora desta missão) |

Nenhuma das três tinha candidato da API em 30/10/2026 (`origin/main` = `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5`).

## Ambiente de desenvolvimento/E2E (histórico da fase simulada; o laboratório real está em `tools/lab/`)

- Nesta fase o frontend roda contra a API simulada (`mock/`), que implementa o contrato **como ele é**, incluindo
  as divergências acima: sem rota de reenvio (404), 400 único para links, 401 genérico no login, MFA obrigatório.
- O e-mail transacional (D4) é simulado por uma caixa de entrada em memória (`/__mock/`), com links no formato
  proposto. Contas são provisionadas pelo simulador (não há cadastro público — fora do escopo).
- Ao integrar com a API real, rodar de novo a suíte E2E contra ela para confirmar que a simulação não divergiu.
