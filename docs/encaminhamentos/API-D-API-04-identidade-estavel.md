# D-API-04 — identificador estável da identidade autenticada (encaminhamento à equipe da API)

| | |
|---|---|
| Origem | FRONT-V1-004 (revisão do #15) |
| Contrato | API `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5`, `api/openapi/nekkora-api-v1.yaml` (sha256 `157bd545…5b30`) |
| Operação afetada | `identitySessionState` (`GET /api/v1/me/session`) |
| Responsável | Equipe da API |
| Issue | [Nekkora-Platform-API#40](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/40) |
| Candidato da API | **nenhum** em 31/10/2026 |

## Problema

A garantia definida para escritas com resultado desconhecido é por **pessoa**: enquanto a pessoa não conferir e liberar,
o navegador não repete a operação. Na área da organização a chave do registro usa o vínculo (`membershipId`), que é
estável. Na área de identidade (criar organização, aceitar convite, vincular conta, novos códigos de recuperação, trocar
a senha) a interface não tem um identificador estável da identidade: `IdentitySessionState` traz só `restricted` e
`csrfToken`, e o frontend usa um resumo do CSRF, que muda a cada sessão.

Consequência: a proteção sobrevive à recarga e às abas da **mesma** sessão de identidade, mas **não** à troca da sessão
(sair e entrar, sessão expirada, nova entrada pelo e-mail). Depois de entrar de novo, uma operação incerta deixa de ser
encontrada e a confirmação volta a ficar disponível, contrariando a garantia definida para a mesma pessoa.

O e-mail não serve como substituto: é dado pessoal e mutável, e um resumo sem segredo pode ser testado contra listas de
endereços.

## Reprodução

1. Entrar pela entrada geral; em "Criar organização", confirmar e perder a resposta (502/504 do proxy depois do envio).
2. A tela registra resultado desconhecido e bloqueia nova confirmação (também depois de recarregar).
3. Sair e entrar de novo com a mesma pessoa: a chave do registro muda (CSRF novo), o bloqueio não é encontrado e a
   confirmação fica disponível.

## Comportamento esperado (contrato e controles de acesso)

- `IdentitySessionState` (ou leitura equivalente da sessão de identidade) devolve um **identificador estável e opaco da
  identidade autenticada** (ex.: `subject`), igual em todas as sessões da mesma identidade.
- **Opaco e sem dado pessoal:** não é e-mail, nome nem derivado reversível deles. Pode ser o `userId` ou, de preferência,
  um valor derivado no servidor com segredo (para não expor o id interno a scripts da página).
- **Só para a própria sessão:** devolvido apenas a quem apresenta o cookie da sessão de identidade daquela identidade;
  sem sessão válida, 401; com a chave da entrada geral desligada, 404 (regras atuais). Nenhuma rota aceita esse valor
  para localizar ou autenticar uma identidade: ele não é credencial.
- **Sessão restrita** (nascida de código de recuperação): definir no contrato se o valor é devolvido (o frontend
  precisa dele também ali, para não perder incerteza depois da troca do fator).
- **Estabilidade documentada:** quando muda (por exemplo, nunca; ou numa rotação explícita do segredo) e o que a
  interface deve fazer nesse caso.
- Mesmo valor nas sessões de organização vinculadas à identidade não é necessário: a área da organização continua usando
  o vínculo.

## Critérios de aceite

1. Duas sessões de identidade da mesma pessoa (antes e depois de sair) recebem o mesmo identificador; pessoas
   diferentes recebem identificadores diferentes.
2. O valor não contém e-mail, nome ou id em claro (se derivado), e não é aceito como credencial em nenhuma rota.
3. Sem sessão: 401; sessão de outra identidade não lê o valor de outra; entrada geral desligada: 404.
4. Comportamento da sessão restrita documentado e testado.
5. Contrato publicado num commit da `main`.

## Situação no frontend até a correção

- Lacuna **aberta**, não limitação aceita: registrada em `src/api/pendingOps.ts` (`identitySubject`), no PR #15 e no
  relatório (`docs/FRONT-V1-002-RELATORIO.md` §0.5). A tela avisa na hora do resultado desconhecido e orienta a
  conferir antes de repetir.
- O frontend **não** usa e-mail nem outro dado pessoal como substituto.
- Depois da correção: o sujeito da identidade passa a ser `i:` + esse identificador; prova dirigida com sair e entrar
  de novo mantendo o bloqueio.
