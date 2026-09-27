# Nekkora Platform Web

Frontend do Nekkora Platform — **Authentication V1**: login por organização, MFA (TOTP) obrigatório com
primeiro acesso guiado, código de recuperação, esqueci/redefinir senha e confirmação de e-mail.

- React 19 + Vite + react-router, **somente componentes da [Nekkora-lib](../Nekkora-lib)** (dependência `file:`).
- A API (`nekkora-platform-api`, contrato 8.7) é a autoridade para sessão, MFA, organização e tokens.
- Divergências entre a UX planejada e o contrato real: [`docs/DIVERGENCIAS.md`](docs/DIVERGENCIAS.md).

## Rotas

| Rota | Tela |
|------|------|
| `/o/{org}/login` | Login (e-mail + senha) |
| `/o/{org}/mfa` | Código do autenticador · código de recuperação |
| `/o/{org}/mfa/setup` | Primeiro acesso: configurar autenticador → confirmar → códigos de recuperação |
| `/o/{org}/forgot-password` | Esqueci minha senha (resposta sempre genérica) |
| `/o/{org}/reset-password#token=…` | Nova senha |
| `/o/{org}/verify-email#token=…` | Confirmação de e-mail |
| `/o/{org}` | Área autenticada (V1: ponto de chegada) |
| qualquer rota sem `/o/{org}` | "Não foi possível identificar a organização." |

`{org}` é o UUID da organização (decisão 8.1). Não há seletor de organização, cadastro público, login Microsoft
nem "manter conectado".

## Rodando

Pré-requisitos: Node 22+, os repositórios `Nekkora-lib` e `nekkora-platform-api` ao lado deste, Docker e JDK 21
(para a API real).

```bash
npm install
npm run check            # typecheck + testes unitários/integração (API simulada) + build
```

### Com a API real

```bash
npm run stack:dev        # sobe nginx TLS + Platform + Portal + PostgreSQL + Redis (origem http://localhost:5173)
npm run dev              # Vite em :5173, repassando /api ao gateway https://localhost:55443
npm run stack:down
```

A stack reaproveita `nekkora-platform-api/api/e2e/compose.e2e.yml` sem alterá-lo; só a origem pública da
Platform aponta para o Vite (`e2e/stack/compose.web.yml`). Segredos são aleatórios por execução e ficam apenas
no ambiente do script. Não há contas: crie-as com as funções de `e2e/support/db.ts`.

### E2E (Playwright, API real)

```bash
npm run stack:up         # mesma stack, origem http://localhost:4173 (vite preview do build de produção)
npm run e2e              # desktop + tablet + mobile
npm run stack:down
```

Cobre os três fluxos da definição de pronto (login → MFA → área autenticada; esqueci → link → nova senha →
login; link de verificação → confirmação → login), códigos de recuperação, sessão expirada/encerrada, cookies,
organização, API indisponível, submit duplicado, vazamentos (console, URL, storage) e acessibilidade com axe
(incluindo contraste) em três tamanhos de tela. Os limitadores da API valem: rodar a suíte muitas vezes na
mesma hora pode esbarrar no limite de pedidos de recuperação por IP (10/h) — `stack:down` + `stack:up` zera.

## Segurança no cliente

- Senha, códigos MFA, códigos de recuperação e tokens de link vivem só em memória de componente; nada em
  localStorage/sessionStorage/cookies legíveis/URL/console/analytics (verificado por testes estáticos e E2E).
- Tokens CSRF (pré-autenticação, desafio, sessão) só em memória; sessão em cookies `__Host-` HttpOnly da API.
- Erros exibem apenas mensagem amigável e, quando houver, o código de referência (`X-Request-Id`).
- Nenhuma renovação automática de sessão; o timer de inatividade só consulta a API.
- `VITE_FEATURE_RESEND_VERIFICATION` (padrão desligado) — ver D2.
