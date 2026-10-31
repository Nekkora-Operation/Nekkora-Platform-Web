# FRONT-V1-002 — correções, integração e fechamento da homologação (30/10/2026)

> **Atualização FRONT-V1-004 (31/10/2026).** A §0.5 é o estado atual: garantias de incerteza fechadas, caminhos
> alterados revalidados no laboratório descartável `frontlab-004` (inclusive a sessão assistida com o Agent real), a que
> código pertence cada evidência e o que continua pendente. As §0.1–0.4 são o registro da FRONT-V1-003 (onde a §0.5 revê algo, ela vale). As seções 1–11 continuam
> valendo como registro da FRONT-V1-002; onde citam HEADs ou runs, eram os daquele momento.

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
| J13–J15 com Agent real | Demonstradas com o código ANTERIOR à revisão (§0.4). No candidato final (§0.5): gateway, acessibilidade, supervisão e J14b revalidados (sessão assistida, rodada 6); B (cancelamento) e C (desfecho desconhecido) não repetidos — fora dos caminhos alterados | Frontend + pessoa no Agent | §3; §0.5 |
| D-API-01 confirmação do MFA | Bloqueado (sem candidato; medida temporária estrita no frontend) | Equipe da API | [issue #37](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/37); `docs/encaminhamentos/API-D-API-01-*.md` |
| D-API-02 leitura do pedido de renovação (prioridade); J09 completa | Bloqueado | Equipe da API | [issue #38](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/38); `docs/encaminhamentos/API-D-API-02-*.md`; J09 parcial em `e2e-real/m2-concessoes.spec.ts` |
| D-API-03 leitura dos vínculos; primeira concessão pela tela (não é a jornada completa de clientes externos) | Bloqueado | Equipe da API | [issue #39](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/39); `docs/encaminhamentos/API-D-API-03-*.md` |
| D-API-04 identificador estável da identidade (incerteza depois de nova sessão de identidade) | Lacuna aberta no #15 até a correção integrada | Equipe da API | [issue #40](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/40); `docs/encaminhamentos/API-D-API-04-*.md`; §0.5 |
| Ativação operacional da organização | Não demonstrada neste laboratório (a fixture de capacidade não a substitui) | API/operação (B2) | `docs/FRONT-V1-INVENTARIO.md` §7 |
| LIB-01 (`Field`, `Input type="file"`) | Encaminhado | Equipe da Nekkora-lib | `docs/encaminhamentos/LIB-01-*.md` |
| AGENT-01 (aprovação sem teclado; build marcado; venv dos testes) | Encaminhado | Equipe do Agent | `docs/encaminhamentos/AGENT-01-*.md` |

Nenhum candidato da API existia em 30/10/2026 (`origin/main` = `e04a57c`). Encaminhamento aberto como issues no repositório
da API: [#37](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/37) (D-API-01), [#38](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/38) (D-API-02, prioridade), [#39](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/39) (D-API-03), cada uma com
reprodução, comportamento esperado, critérios de aceite, referência do contrato e PRs afetados.
O laboratório `frontlab-001` segue parado com containers e volumes preservados; nenhum volume foi excluído.

### 0.4 Revisão dos diffs #10–#17 (FRONT-V1-003)

Cada PR foi revisado; as correções entraram na branch mais baixa afetada, por commits normais, e subiram pela pilha
por merge (sem reescrever histórico). Os HEADs e runs da §0.2 são os de ANTES da revisão: os resultados de lá
pertencem àqueles commits; os do candidato novo de cada PR estão no bloco de estado do próprio PR.

| PR | Achado | Correção |
|----|--------|----------|
| #11 (e #13, #15) | 502/503/504 do proxy sem o corpo da API viravam `service_unavailable` → "nada foi criado/gravado", e a confirmação podia ser repetida | código `gateway`: numa escrita é resultado desconhecido (confirmações com step-up, envio de pacote, registro persistente); leituras mostram indisponibilidade |
| #14 | `tools/lab/agent.ps1` deste PR aprovava o pacote e iniciava a execução por teclas (atos da pessoa) | sai a versão do #17 (só prepara e confere o log); toda tecla restante só com o foco conferido na janela certa |
| #11 | entrar numa organização em outra aba tirava esta da área de identidade (e de um desafio MFA em curso) | aviso entre abas com alcance (organização × tudo) |
| #11 | vinculação incerta perdia o aviso ao fechar; "Sair" sem confirmação do servidor dizia "Você saiu" | aviso persistente e "Vincular" bloqueado; aviso de saída não confirmada |
| #12 | decisão de concessão incerta deixava decidir de novo na mesma linha | "Decisão não confirmada" até "Atualizar" (revisto na FRONT-V1-004: reler não libera; só a pessoa, §0.5) |
| #13 | 413 do proxy caía em incerto; seletor de arquivo reabria o envio incerto; sem SHA-256 local a conferência dizia "não tem o pacote" | 413 é recusa com o motivo; seletor bloqueado; conferência mostra o SHA-256 da Platform |
| #14 | aviso "desatualizado, próxima tentativa automática" depois de o acompanhamento acabar; lista parava de consultar quando vazia; detalhe relia todo o histórico a cada 10 s; "Conhecido" em verde | só desatualiza enquanto acompanha; lista sempre a cada 30 s; eventos relidos só quando o histórico muda; tom neutro; rotação cancelável; Worker escolhido reiniciado |
| #15 | teste do 502 passava por acaso; sem Web Locks não havia exclusão entre abas; com locks sem `query()`, envio vivo virava desconhecido; "em curso em outra aba" parecia recusa | teste com resposta real de proxy; marca conferida depois de gravar (revisto na FRONT-V1-004: não garante exclusão; sem Web Locks o envio não começa, §0.5); vivo sem informação; aviso próprio |
| #10, #16 | validador com mapa + propriedades; proteções do `subir.sh` puladas por SIGPIPE; anotação de contagens sem arquivos que não carregaram | corrigidos (ver commits) |
| #17 | relatório afirmava mais do que os specs (ver abaixo); caminhos e uma frase de encaminhamento desatualizados | texto corrigido |

Registrado no código na FRONT-V1-003 como "limitações aceitas" — **revisto na FRONT-V1-004 (§0.5)**: o sujeito da área
de identidade pelo resumo do CSRF é uma **lacuna aberta** (API #40), não limitação aceita; o e-mail do convite dentro do
resumo da chave é uma **limitação de privacidade** (resumo sem segredo não é anonimização). Um 400 na confirmação do cadastro continua "link inválido":
as regras locais são as mesmas da API (`PasswordPolicy`, nome), conferido no código da API.

O que os specs da API real afirmam e o que só foi observado (sem repetir provas; o laboratório continua parado):

- Execução A: o spec afirma "Concluída com sucesso" e "Desfecho Conhecido"; "Processo Encerrado" e "Histórico
  Completo" estão no texto da tela registrado no log da sessão (`sessao-j13-j15-A-aprovada.log`), não em asserção. A
  reconexão do J14b aparece como retomada do canal e entrega do histórico completo; a asserção do spec sobre a contagem
  de conexões (`>=`) não a prova sozinha.
- J17: a varredura axe percorre 10 telas × 3 larguras e confere um h1 em cada uma; não confere que cada tela carregou
  os dados (o limitador de leituras da API pode ter mostrado "Muitas tentativas" em parte delas, e essa tela também foi
  auditada).
- J16: 429 observado na API real, provado em componente; nenhum spec da API real afirma um 429.

Endurecimento desses specs (h1 específico e ausência de "Muitas tentativas" antes de cada axe, com ritmo; reconexão com
`>` e desconexão durante a pausa; asserções de processo e histórico) fica para a próxima sessão de laboratório, junto
das telas afetadas pela revisão: supervisão (lista e detalhe), envio de pacote, confirmações com step-up. (Feito na
FRONT-V1-004, §0.5, inclusive a sessão assistida da supervisão e do J14b.)

### 0.5 FRONT-V1-004 — garantias de incerteza fechadas e caminhos alterados revalidados (31/10/2026)

**Correções (cada uma na branch mais baixa afetada, levada pela pilha por merge comum):**

| PR | Achado | Correção | Prova |
|----|--------|----------|-------|
| #12 (`c5f2b04`) | "Atualizar" liberava a decisão de concessão com resultado desconhecido; o contrato não liga o estado da concessão a uma tentativa (sem id de operação, versão ou autor da decisão), então nenhuma releitura é evidência conclusiva | a linha só volta a oferecer decisões por "Liberar nova decisão", com confirmação e o aviso de possível duplicidade; reler a lista não libera | `src/area/f6a3.test.tsx` (504 do proxy → Atualizar relê e continua bloqueado → cancelar mantém → liberar) |
| #15 (`4c237c2`) | o mesmo bloqueio vivia só na tela | vem também do registro persistente: sobrevive à recarga e a outra aba; a liberação explícita solta os registros daquela concessão | `src/area/f6a3.test.tsx` (recarga; teste falha sem o registro) |
| #15 | sem Web Locks, marca + espera aleatória + conferência no `localStorage` não garante exclusão entre abas | **bloqueio seguro**: sem Web Locks, `begin()` recusa (`no-locks`), nada é gravado nem enviado e o diálogo avisa antes de confirmar; ações administrativas recusam com o mesmo texto | `e2e/corrida-abas.spec.ts` (abaixo); `src/api/pendingOps.test.ts`; `src/uncertainOps.test.tsx` |
| #15 | sujeito da identidade = resumo do CSRF, tratado como "limitação aceita" | passa a **lacuna aberta**; a tela da área de identidade diz que o aviso vale na sessão (recarga e abas) e não depois de sair e entrar; e-mail não é usado como substituto | [Nekkora-Platform-API#40](https://github.com/Nekkora-Operation/Nekkora-Platform-API/issues/40) (D-API-04); `docs/encaminhamentos/API-D-API-04-identidade-estavel.md` |
| #10 (`08c1706`) | falha intermitente de `f5.test.tsx` só com a suíte inteira (3 em 21; 0 em 12 isolado; travamento de 3,1 s contra ~0,4 s) | a escrita da URL dos filtros de execuções roda no efeito de layout: com `useEffect`, uma navegação que chegasse com o efeito pendente era desfeita pelo `replace` com a URL antiga | 10 suítes inteiras seguidas no topo da pilha (`8c8bc8e`), 428/428 em todas |
| #17 (`e54b012`) | specs da API real afirmavam menos do que o relatório dizia | `m6-gateway` novo; `m5` só audita tela carregada e sem 429; `m4-execucao` com lista vazia e J14b que falha | abaixo |

**Exclusão entre abas — prova dirigida** (`e2e/corrida-abas.spec.ts`, API simulada, Chromium; duas abas da mesma pessoa,
mesma operação, disparo agendado para o mesmo instante do relógio nas duas):

| Código | Ambiente | Rodadas | Envios por rodada |
|--------|----------|---------|-------------------|
| antes (`338e777`, marca + espera) | sem Web Locks | 20 | 1 em todas |
| depois (`4c237c2`) | com Web Locks | 20 | 1 em todas (asserção) |
| depois (`4c237c2`) | sem Web Locks | 20 | 0 em todas; as duas abas mostram o motivo (asserção) |

As 20 rodadas com um envio no mecanismo antigo **não** provam exclusão: o padrão HTML não dá leitura-e-gravação atômica
ao `localStorage` entre processos, e o resultado dependia de a gravação de uma aba chegar à outra antes do fim da espera
(25–75 ms). Por isso o bloqueio. Um primeiro diagnóstico contou 0 envios por erro do próprio contador (rota
`/organizations/` em vez de `/o/`); foi descartado e o log ficou marcado como inválido. Os testes de componente usam um
gerenciador de locks em memória (todas as "abas" no mesmo processo JS, onde a exclusão é real), não a espera imediata,
e não são apresentados como prova de concorrência entre abas.

**Laboratório descartável `frontlab-004`** (API `e04a57c`, migrations 001–028, `https://localhost:55895`, subido em
31/10/2026 04:46 UTC; o `frontlab-001` continua parado e preservado). Fixtures declaradas em `fixtures.txt`: limites da
organização (010), pacotes e entrada da J14 copiados do `frontlab-001` (sha256 em `pacotes_sha256.txt`), API congelada e
descongelada pelos testes de gateway. Código da aplicação: o de `8c8bc8e` (o `e54b012` e este relatório só mudam specs,
ferramentas e documentação).

| Caminho | Prova | Resultado |
|---------|-------|-----------|
| Step-up (convite) | `e2e-real/m6-gateway.spec.ts`: depois do step-up aceito, o POST do convite chega ao nginx com a API congelada; 504 em 60 s | diálogo em "resultado não confirmado", POST único (504), confirmação bloqueada, nada repetido em 15 s nem depois da recarga (registro persistente com "liberar" explícito), nenhuma frase afirmando ausência de efeito. Efeito real: **não aplicado** (a API, descongelada, não processou o pedido cuja conexão o nginx já tinha fechado; a lista ficou vazia) |
| Upload do pacote | mesmo spec: PUT do pacote com a API congelada; 504 | "O envio foi interrompido ou ficou sem resposta… Os bytes podem ter chegado", PUT único (504), envio e seletor bloqueados, nada repetido. Efeito real: **aplicado** — "Conferir a versão" mostrou "a Platform tem o pacote com o mesmo SHA-256" |
| Acessibilidade | `e2e-real/m5-a11y-seguranca.spec.ts` endurecido | 30/30 telas×larguras aprovadas só carregadas e sem 429 (`a11y-telas.txt`). Duas visitas com 429 **não contaram** (versão, que mostrava o título genérico "Automação — versão 1", e workers no celular) e foram refeitas uma vez depois do Retry-After. A 1ª rodada do spec endurecido falhou por um defeito do próprio spec (título ausente lançava em vez de contar como não carregada), corrigido antes da rodada aprovada |
| Supervisão (lista vazia que recebe a execução; estados e eventos) e J14b | `e2e-real/m4-execucao.spec.ts` endurecido (etapa A), sessão assistida em 31/10/2026 (a pessoa aprovou o pacote uma vez e clicou em "Iniciar" a cada rodada; nada simulado) | **aprovado na rodada 6** (`m4-execucao-6.log`, exit 0): canal Agent–API pausado 10 s com a execução em curso, **0 ACK durante a pausa**, execução **ainda em curso na retomada**, entrega retomada logo depois (stored_through 3 → 12); a lista aberta vazia antes do início recebeu a execução sem recarregar; o detalhe mostrou "Em execução" com eventos chegando (1165 → 1589); J14a com a execução em curso (aviso de desatualizado offline, some na volta); 3323 eventos entregues, 85 ACKs sem duplicata e crescentes, tela com a sequência contínua 1..2000 (limite do histórico longo); desfecho na tela = estado final real do Agent |

Nos 504 provocados, o efeito real variou (convite não aplicado, pacote aplicado). A tela não sabe qual dos dois aconteceu,
e por isso não pode afirmar nenhum deles: mantém o resultado desconhecido até a pessoa conferir.

**Evidências — a que código pertencem:**

| Momento | Código | Evidência |
|---------|--------|-----------|
| Antes da revisão (FRONT-V1-002) | HEADs da §0.2 e da regressão final (§11) | jornadas J01–J18 no `frontlab-001`; J13–J15 com o Agent real (`sessao-j13-j15-*.log`) |
| Depois da revisão FRONT-V1-003, antes da FRONT-V1-004 | `ea11737` … `d982933` | só CI (16 runs, no bloco de estado de cada PR naquele momento); nenhuma prova de laboratório |
| Candidato final (FRONT-V1-004) | #10 `08c1706` · #11 `e69d480` · #12 `f844d1c` · #13 `73e7155` · #14 `f65469c` · #15 `7de65f3` · #16 `79982b7` · #17 HEAD deste relatório | CI no bloco de estado de cada PR; Vitest 10× e corrida entre abas (acima); `frontlab-004`: gateway, acessibilidade, supervisão e J14b com o Agent real (acima; sessão assistida abaixo) |

**Sessão assistida (31/10/2026, `frontlab-004`, Agent `ce30397`) — as seis rodadas, inclusive as que falharam.** O código
da aplicação foi o mesmo em todas (`8c8bc8e`); as rodadas 2 a 6 reaproveitaram a pasta de dados do Agent da 1ª
(`agent-dados-202610311100`: a aprovação do pacote nesta máquina continua; o pareamento é refeito).

| Rodada | Resultado | Causa / mudança antes da seguinte |
|--------|-----------|-----------------------------------|
| 1 | falhou: "execução ainda em curso na retomada" = falso | defeito do spec: a espera pela lista DENTRO da pausa a fez durar 38 s e a execução de 21 itens (~31 s) terminou antes da retomada. A guarda contra o caso trivial funcionou. Pausa passou a 10 s fixos; lista conferida depois |
| 2 | J14b aprovado (em curso na retomada, 0 ACK na pausa, 5 → 12); falhou em "nenhuma duplicata" | defeito do spec: com a pasta reaproveitada, os ACKs lidos incluíam os da rodada 1 (`duplicates=5` na retomada daquela execução, já terminada). Leitura do log restrita ao trecho da etapa — o mesmo valia para `PLATFORM_DELIVERY_COMPLETED`, que passaria trivialmente |
| 3 | falhou: aviso de desatualizado ausente no J14a | a execução terminou antes da abertura do detalhe (a lista levou ~18 s, o ritmo da tela); com o acompanhamento encerrado a tela corretamente não avisa desatualizado. O detalhe "em execução" e o J14a passaram a ser **exigidos** com a execução em curso (antes o detalhe era pulado), e a entrada ficou mais longa: `entrada-j14-longa.csv` (declarada em `fixtures.txt`) |
| 4 | tudo aprovado até o desfecho; falhou em "Concluída com sucesso" | a tela mostrou "Falhou", fiel ao `FAILED` do Agent (AGT-EXE-022): a automação recusou 2 itens (`DADO_OBRIGATORIO_VAZIO:occupation`; a conferência prévia pelo HTML bruto não reproduz a leitura do navegador). Lista sem os dois: `entrada-j14-longa2.csv` |
| 5 | tudo aprovado até o desfecho; falhou em "Concluída com sucesso" | "Falhou" de novo: Joaquim Nabuco, gravado na planilha da rodada 4, recusado na 5 — leitura intermitente do pacote. Por decisão da pessoa, a asserção final passou a exigir que a tela mostre o estado final REAL do Agent (SUCCEEDED → "Concluída com sucesso", FAILED → "Falhou"; estado sem texto mapeado falha) |
| 6 | **aprovado** (exit 0) | estado final `FAILED` (Joaquim Nabuco recusado de novo), tela "Supervisor: Falhou"; demais resultados na tabela acima |

**Achado para o time do Studio/Framework (não é do frontend):** com páginas vivas da pt.wikipedia, a leitura de
"Ocupação" pelo pacote `pacote-studio-real` é intermitente — o mesmo item (Joaquim Nabuco) foi gravado numa execução e
recusado por `DADO_OBRIGATORIO_VAZIO:occupation` em duas outras (conferido pelas URLs gravadas em
`planilha.xlsx-output.json`, não pela ordem das transações). Uma execução da automação que deveria ter sucesso termina
em `COMPLETED_WITH_FAILURES`. Não foi aberta issue (sem autorização para isso); fica registrado aqui para encaminhar.
"Concluída com sucesso" com a entrada longa não foi mostrado no candidato final; com a entrada de 21 itens, as
rodadas 1–3 terminaram em `SUCCEEDED` no Agent.

**Limitações e lacunas que continuam:**

- **Identidade (lacuna aberta, não aceita):** na área de identidade a proteção vale para a recarga e as abas da mesma
  sessão de identidade, não para uma nova sessão (sair e entrar, expiração). Fica explícita no #15 até a correção da
  API (#40) ser integrada.
- **Privacidade do registro:** as chaves são SHA-256 sem segredo. Não estar em claro não é anonimização: quem tem acesso
  ao navegador e conhece o vínculo e a organização pode testar e-mails candidatos contra as chaves dos convites com
  resultado desconhecido (os incertos ficam até a pessoa liberar).
- **Navegador sem Web Locks:** as operações protegidas ficam indisponíveis (com o motivo na tela) até haver solução
  adequada; os navegadores atuais têm Web Locks.
- **Decisões de concessão:** sem evidência conclusiva no contrato, só a pessoa libera.

API: #37, #38, #39 e #40 seguem com a equipe da API, numa missão própria; nada foi implementado na API por este time.



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
| J16 HTTP (401/403/404/409/422/429/503) | Aprovada | componente + API real (403, 409, 422, 503); 429 só observado na API real (J17), provado em componente |
| Resultado desconhecido persistente | Aprovada | componente (`uncertainOps.test.tsx`, `pendingOps.test.ts`, f6a*) |
| J17 teclado, foco, zoom 200 %, viewports, recarga, links | Aprovada | API real (`m5-a11y-seguranca`): axe com contraste em 10 telas × 3 larguras (ressalva em §0.4) |
| J18 segredos | Aprovada | API real (`m5`) + varredura estática (`security.test.tsx`) |

Estados raros da supervisão (histórico incompleto, expurgo, etapas indisponíveis) continuam também em testes de
componente; eles não substituem as provas integradas acima.

## 3. Sessão assistida com o Agent real (J13–J15)

Atos LOCAIS da pessoa, feitos com o mouse no Agent e conferidos no log do próprio Agent (o laboratório só prepara até o
ponto e avisa na tela; nenhuma tecla, clique por cor, cópia de aprovação ou alteração de estado simulou consentimento):
aprovação do pacote (`EXEC_PACKAGE_APPROVED` 15:50:49Z), "Iniciar" em cada execução e "Cancelar execução" na B.

| Execução | Resultado no navegador (do supervisor) | Evidência |
|----------|-----------------------------------------|-----------|
| A — J13 + J14 | Processo Encerrado · Desfecho Conhecido · **Concluída com sucesso** · Histórico Completo (o que é asserção e o que é texto registrado: §0.4); 1 execução; nenhuma sequência de evento repetida | início 16:17:08Z; **J14b** (só Agent–API: `agent-gateway` pausado 16:17:09→16:17:30, execução em curso, navegador falando com a API, 2 desconexões no log do Agent, reconexão); **J14a** (só navegador–API: contexto offline, aviso "dados podem estar desatualizados", volta; o Agent entregou 1 relatório durante a queda) |
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
`../front-v1-002-agent`, `../front-v1-002-framework`, `../front-v1-002-limpo`. Os repositórios de outras sessões
(`../Nekkora-lib`, `../Nekkora-RPA-Framework`, `../Nekkora-Agent`, `agent-int`, a API de trabalho) não foram alterados.
Evidências locais (não versionadas: contêm dados do laboratório) em `tools/lab/saidas/frontlab-001/`; nenhuma captura,
trace, QR, código ou token foi versionado (configuração real com trace, screenshot e vídeo desligados).
