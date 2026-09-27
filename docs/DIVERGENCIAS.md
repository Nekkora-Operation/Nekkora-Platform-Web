# Divergências entre a UX planejada e o contrato real da API (Authentication V1)

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

## Ambiente de desenvolvimento/E2E

- Sem sender real de e-mail (D4), o "e-mail" do E2E é simulado: a fixture grava no banco o SHA-256 de um token
  conhecido (exatamente como a API grava) e o teste abre o link no formato D4. O pedido real
  (`password-reset/request`) é feito pela interface e o teste confirma que a API emitiu um token.
- Contas são provisionadas por fixture (não há cadastro público — fora do escopo).
