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

Pré-requisitos: Node 22+ e o repositório `Nekkora-lib` ao lado deste, no `main` e atualizado com `git pull`.
Não precisa da API nem de Docker.

`dev`, `build` e `test` começam por `scripts/check-lib.mjs`: se a lib não exportar algum componente que o
frontend usa, ela é recompilada; se ainda faltar (branch errado), o comando para com a instrução — em vez de a
página abrir em branco.

Com npm 11, `npm ci`/`npm install` aqui **não** executa o `prepare` (build) da lib (aviso "allow-scripts"), e o
`check-lib` só recompila quando falta um export. Depois de atualizar a lib, gere o `dist` nela
(`npm ci && npm run build` em `../Nekkora-lib`). Ao registrar uma verificação, anote o **par de commits**
web + lib: o lockfile e o comportamento dependem da lib em disco.

```bash
npm install
npm run dev              # http://localhost:5173 — com a API simulada
npm run check            # typecheck + testes unitários/integração + build
```

### Contrato tipado da API v1 (`contract/`, `src/api/generated/`)

A fonte do contrato é o OpenAPI definitivo do backend (`Nekkora-Platform-API`: `api/openapi/nekkora-api-v1.yaml`).
O frontend guarda uma **cópia versionada** em `contract/` e gera os tipos TypeScript em
`src/api/generated/nekkora-api-v1.ts` (só tipos, nenhum código em runtime). Os clientes por domínio ficam em
`src/api/` (`permissions.ts`, `product.ts`, `admin.ts`, `portal.ts`), e a paginação por cursor em
`src/hooks/useCursorList.ts`.

```bash
npm run contract:gen     # regenera os tipos a partir da cópia
npm run contract:check   # falha se os tipos não forem os gerados ou se a cópia divergir do backend (../nekkora-platform)
npm run contract:sync    # copia o OpenAPI do backend para contract/ (depois: contract:gen)
```

O gerador (`openapi-typescript`) exige TypeScript 5, e o app usa TypeScript 7. Por isso ele roda numa ferramenta
**isolada** em `tools/contract/` (dependências e lockfile próprios, instalados sob demanda pelo script).
`npm run check` inclui o `contract:check`.

### API simulada (`mock/`)

Nesta fase o frontend trabalha contra uma **simulação em memória do contrato 8.7**, servida pelo próprio Vite
(`npm run dev` e `npm run preview`). Ela reproduz o que a interface enxerga da API real: rotas, erros
`{"error": ...}`, `X-Request-Id`, cookies `__Host-` HttpOnly, CSRF com checagem de Origin, TOTP real com
anti-replay, 5 tentativas por desafio, códigos de recuperação e links de uso único, expiração de sessão e
respostas genéricas. Nada disso entra no build de produção.

Painel em **http://localhost:5173/__mock/**:

- contas de exemplo (senha `Nekkora-Dev-2026`, organização `b7e1c3a0-5d2f-4e8b-9a61-0c3d5e7f9a12`):
  - `ana@nekkora.dev` — MFA configurado (código TOTP do momento no painel);
  - `novo@nekkora.dev` — primeiro acesso (configuração do autenticador);
  - `pendente@nekkora.dev` — e-mail não confirmado (link de confirmação na caixa de e-mails);
  - `portal@nekkora.dev` — conta do portal (inatividade de 15 min);
- **caixa de e-mails simulada** com os links de redefinição de senha e de confirmação;
- expirar sessões, simular falhas (queda de conexão, 429, 503, 500) e restaurar os dados.

Como na API real, um código TOTP só vale uma vez: para entrar de novo na mesma conta, espere o próximo código.
Latência simulada: `NEKKORA_MOCK_DELAY` (ms, padrão 350).

### E2E (Playwright)

```bash
npx playwright install chromium   # uma vez
npm run e2e                       # build de produção + API simulada; desktop, tablet e mobile
```

Cobre os três fluxos da definição de pronto (login → MFA → área autenticada; esqueci → e-mail simulado → nova
senha → login; link de verificação → confirmação → login), códigos de recuperação, sessão expirada/encerrada,
cookies, organização, API indisponível, submit duplicado, vazamentos (console, URL, storage) e acessibilidade
com axe (incluindo contraste).

### Integração com a API real (fase futura)

Com `NEKKORA_API_URL` definido (ex.: `https://localhost:55443`), o Vite deixa de simular e repassa `/api` para
essa API. A origem pública configurada na API precisa ser a do Vite (`http://localhost:5173`).

## Segurança no cliente

- Senha, códigos MFA, códigos de recuperação e tokens de link vivem só em memória de componente; nada em
  localStorage/sessionStorage/cookies legíveis/URL/console/analytics (verificado por testes estáticos e E2E).
- Tokens CSRF (pré-autenticação, desafio, sessão) só em memória; sessão em cookies `__Host-` HttpOnly da API.
- Erros exibem apenas mensagem amigável e, quando houver, o código de referência (`X-Request-Id`).
- Nenhuma renovação automática de sessão; o timer de inatividade só consulta a API.
- `VITE_FEATURE_RESEND_VERIFICATION` (padrão desligado) — ver D2.
