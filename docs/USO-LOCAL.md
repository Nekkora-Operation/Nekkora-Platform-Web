# Platform no seu Windows: primeiro uso local

Este guia instala, no seu computador, o frontend da Platform ligado à **API real**, com banco, Redis, gateway e caixa de
e-mail locais. Nada sai da máquina: sem Microsoft 365, sem AWS e sem envio para uma caixa real.

- **Terminal:** use o **Git Bash** em todos os comandos (Menu Iniciar → "Git Bash"). Os scripts do laboratório são Bash.
  O PowerShell não serve para estes comandos.
- **Frontend:** a revisão do frontend que você tem na pasta. A interface mostra qual é, no rodapé do menu ("Web
  <commit> · candidata (branch …) · API <commit>"); fora da `main` ela aparece como **candidata**.
- **API:** a revisão em que o contrato do frontend está fixado (`contract/SOURCE.json`). O runner recusa outra, na
  instalação e na atualização: as duas pastas andam juntas.
- **Validação:** cada comando foi executado e conferido no Windows 11 em 2026-11-02 (seções 8 e 9).

Daqui em diante, `~` é a sua pasta de usuário (`C:\Users\nicol`). O guia instala tudo em `~/nekkora-local`.

---

## 1. Pré-requisitos

Confira o que já está instalado. Rode no Git Bash, de qualquer pasta:

```bash
git --version              # Git for Windows 2.4x ou mais novo (traz o Git Bash, openssl, curl)
docker version --format '{{.Server.Version}}'   # Docker Desktop em execução (validado com o Engine 29)
docker compose version     # Compose v2 ou mais novo (validado com a v5.3)
node --version             # Node 22 ou mais novo (validado com a v24)
npm --version              # vem com o Node (validado com a 11)
java -version              # JDK 21 (só para compilar a API)
```

| Ferramenta | Para quê | Se faltar |
|---|---|---|
| Git for Windows | clonar, e o próprio Git Bash | <https://git-scm.com/download/win> |
| Docker Desktop | banco, Redis, API, gateway e nginx | <https://www.docker.com/products/docker-desktop/>. Abra o Docker Desktop e espere "Engine running" |
| Node.js 22+ | frontend e preparação da Nekkora-lib | <https://nodejs.org/> (LTS) |
| JDK 21 | compilar os jars da API (`mvnw`) | Temurin 21: <https://adoptium.net/> |

O Maven não precisa ser instalado: a API traz o `mvnw`. O PostgreSQL e o Redis também não, porque rodam no Docker.

**Portas.** O ambiente usa `5173` (frontend), `47443` (API, HTTPS) e `47432` (banco, só em 127.0.0.1). O Hyper-V
reserva blocos de portas acima de 49152, e esses blocos mudam a cada reinício. Por isso as portas ficam abaixo dessa
faixa. Para conferir se alguma porta está reservada:

```bash
netsh int ipv4 show excludedportrange protocol=tcp
```

Se `47443` ou `47432` aparecerem num intervalo da lista, escolha outras portas antes de instalar (veja a nota da seção 3).

---

## 2. Baixar o código (uma vez)

De qualquer pasta:

```bash
mkdir -p ~/nekkora-local && cd ~/nekkora-local
git clone -c core.autocrlf=false https://github.com/Nekkora-Operation/Nekkora-Platform-API.git
git -C Nekkora-Platform-API -c advice.detachedHead=false checkout e04a57ceeb880de603252fcca4e3d7ccc16cc9d5
git clone -c core.autocrlf=false -b feat/front-v1-002-provas https://github.com/Nekkora-Operation/Nekkora-Platform-Web.git
git -C Nekkora-Platform-Web log -1 --format='%h %s'
```

O `core.autocrlf=false` importa: os scripts e as migrations precisam manter o fim de linha do repositório.

### Bibliotecas: o que é interno e o que é fixado

- **Módulos internos da API.** `nekkora-core` e `nekkora-ops` são módulos do próprio build Maven da API
  (`api/pom.xml`). O `mvnw package` compila os dois junto com `nekkora-platform`, `nekkora-portal` e
  `nekkora-agent-gateway`. Não há nada para clonar à parte.
- **Nekkora-lib do frontend.** É um pacote npm fixado, não um servidor. O `lib.lock.json` fixa o repositório, o commit
  `0a29d95fbadb`, a versão 0.2.0 e o sha256 do pacote. O comando `npm run lib:prepare` faz um checkout **isolado** em
  `Nekkora-Platform-Web/.deps/nekkora-lib` (ignorado pelo Git), compila, empacota e confere o sha256. Depois, o
  `npm ci` instala esse pacote e confere a integridade sha512 registrada no `package-lock.json`. Também não é
  preciso clonar a Nekkora-lib à parte nem ter uma pasta `../Nekkora-lib`.

---

## 3. Instalar a API e os serviços locais (uma vez)

**Compilar os jars da API** (≈ 20 s com o cache do Maven; a primeira vez baixa as dependências e demora mais):

```bash
cd ~/nekkora-local/Nekkora-Platform-API/api
./mvnw -q -B -DskipTests package
ls */target/*-0.1.0-SNAPSHOT.jar
```

**Preparar o frontend e a Nekkora-lib fixada:**

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
npm run lib:prepare      # termina com: nekkora-lib 0.2.0 @ 0a29d95fbadb: sha256 1a2e6145… confere
npm ci --no-audit --no-fund
npm run lib:verify       # repete a conferência do sha256
```

**Criar o ambiente** (banco, Redis, migrations, API, portal, gateway do Agent e nginx com TLS). Na pasta do frontend:

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh instalar ../Nekkora-Platform-API
```

O que esse comando faz, pelo runner existente `tools/lab/subir.sh`:

- confere que a cópia da API está **exatamente** no commit do contrato e sem alterações;
- confere que portas, sub-rede (`10.251.80.0/24`) e nome do projeto (`nekkora-frontlab-local`) estão livres. Ele nunca
  toca outros ambientes;
- gera segredos aleatórios só em `~/.nekkora/front-lab/frontlab-local/`, fora dos repositórios;
- aplica **todas** as migrations (001–028) numa instalação limpa, pelo migrador suportado
  (`db/bootstrap/aplicar_como_migrador.sh`), e exige o fim `estado=0|0|0` e as invariantes da 016;
- liga localmente o **cadastro**, a **entrada geral** e a **criação de organização**. As duas últimas já vêm do compose
  E2E da API; o cadastro vem de `tools/lab/compose.front.yml`;
- usa como transporte de e-mail a **caixa de homologação**: cada mensagem vira um arquivo num volume local;
- gera um certificado TLS local para `localhost` (o nginx da API atende em `https://localhost:47443`);
- espera a API responder e grava o resumo em `tools/lab/saidas/frontlab-local/laboratorio.txt`.

Termina com `LABORATORIO OK: https://localhost:47443`. Para conferir que a API está pronta:

```bash
bash tools/lab/local.sh estado
# ...os 6 serviços "running" e: API: https://localhost:47443/api/v1/csrf -> 200 (200 = pronta)
```

> Outras portas: `LOCAL_PORTA=47543 LOCAL_PG_PORTA=47532 bash tools/lab/local.sh instalar ../Nekkora-Platform-API`. As
> portas ficam gravadas no ambiente; os demais comandos não precisam delas.

---

## 4. Frontend e acesso

Num **segundo** Git Bash (este fica ocupado enquanto o frontend roda):

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh front
```

Abra no navegador (Chrome ou Edge): **<http://localhost:5173/cadastro>**. A entrada fica em <http://localhost:5173/entrar>.

O caminho é o seguinte:

- O navegador fala **só** com `http://localhost:5173` (o Vite). O Vite repassa `/api` para a API em
  `https://localhost:47443`. O navegador trata `localhost` como contexto seguro, por isso os cookies `__Host-`
  (`Secure`, `HttpOnly`, `SameSite=Strict`) funcionam nesse endereço.
- O trecho Vite → API usa **TLS conferido**. O `local.sh front` passa o certificado do ambiente (`NEKKORA_API_CA`), e o
  Vite recusa qualquer outro. Na validação, um certificado errado deu 502.
- O CSRF fica a cargo da API: o token vive só na memória da página. Um pedido de escrita sem o token é recusado com 403.
- O navegador não mostra nenhum aviso de certificado, porque não fala com o nginx diretamente.

Para encerrar o frontend, use `Ctrl+C` nesse terminal.

---

## 5. E-mail local e MFA

**A caixa local.** Use qualquer e-mail no cadastro: nada é enviado. Um endereço fictício, como
`nicolly@local.test`, evita confusão. Depois de pedir o cadastro, rode num Git Bash, na pasta do frontend:

```bash
bash tools/lab/local.sh caixa                       # lista as mensagens (tipo e destinatário, sem links)
bash tools/lab/local.sh link nicolly@local.test     # mostra o link da última confirmação de cadastro
```

Copie o link exibido (`http://localhost:5173/cadastro/confirmar#token=…`) e abra-o no navegador. Ele vale uma vez. Não o
cole em arquivos, issues ou evidências. A mensagem pode levar alguns segundos para chegar; se o `link` disser
"nenhuma confirmação", espere e repita.

**A autenticação em duas etapas é opcional** (API com a migration 029). Depois de confirmar o e-mail, você entra só com
a senha, sem QR. Enquanto ela estiver desativada, as ações sensíveis (criar organização, convidar, mudar papéis,
publicar, credenciais do Agent etc.) pedem a **senha de novo**, imediatamente antes do ato.

**Para ativar:** Segurança da conta → **Ativar autenticação em duas etapas** → confirme a senha → leia o QR com o seu
aplicativo (Microsoft Authenticator, Google Authenticator, 1Password etc.) → digite o código de 6 dígitos. A tela mostra
os **códigos de recuperação** uma única vez: guarde-os fora do Git e fora de qualquer pasta do projeto. A ativação
encerra as suas outras sessões. A partir daí, o código é pedido sempre, ao entrar e nas ações sensíveis, e a senha
sozinha não basta mais. Cada código vale uma vez: para usar outro logo em seguida, espere o próximo.

Quem já tinha o autenticador (contas criadas antes da 029) continua exatamente como antes. A recuperação de senha não
remove o autenticador.

---

## 6. O roteiro de exploração

O que é **da tela** você faz no navegador. O que é **do operador** (a operação da Nekkora) é um comando no terminal,
na seção seguinte: no seu computador, você faz os dois papéis.

1. **Entrar (tela).** Cadastro em <http://localhost:5173/cadastro> → `bash tools/lab/local.sh link <seu e-mail>` →
   abra o link → nome e senha → **Entrar**. Sem autenticação em duas etapas, você chega direto à entrada geral; com ela,
   o código é pedido (seção 5).
2. **Criar a organização (tela).** Sem organização, a entrada geral mostra **Criar minha primeira organização**. Informe
   o nome → **Continuar** → confirme com a senha (ou com o código, se ativou). A organização aparece com o selo
   **Aguardando ativação** e o botão **Entrar em <nome>**.
3. **Reconhecer a ativação (tela).** Dentro da organização, o início explica: enquanto aguarda ativação, nenhum Worker é
   registrado e nenhuma automação executa; quem ativa é a operação da Nekkora, não a tela. Você já pode preparar pessoas,
   workspaces e automações.
4. **Ativar (operador).** Seção "Ativação pelo operador": `bash tools/lab/local.sh operador preparar` (uma vez) e
   `bash tools/lab/local.sh ativar <org> 2 1 10 "laboratório: exploração local"`. Recarregue: o selo vira **Ativada**.
5. **Criar o primeiro workspace (tela).** No início da organização, **Criar primeiro workspace** (não pede
   confirmação extra). Sem automações, o início passa a oferecer **Criar primeira automação**.
6. **Convidar uma segunda pessoa (tela).** Administração → Convites: e-mail, papel (por exemplo **Operação** num
   workspace) → **Convidar** → confirme com a senha ou o código. Em outro navegador (ou janela anônima), cadastre a segunda
   pessoa com o e-mail convidado, rode `bash tools/lab/local.sh convite <e-mail dela>` e abra o link exibido (ele vale
   uma vez; não o cole em arquivos) → **Aceitar convite** → confirme com a senha ou o código dela.
7. **Conferir o papel dela (tela).** Administração → Membros → **Acessos de <nome>**: os papéis ativos e o escopo.
8. **Parar sem perder dados.** `Ctrl+C` no terminal do frontend e `bash tools/lab/local.sh parar` (seção 7). Na volta,
   `subir` e `front`: a conta, o autenticador (se ativou), as organizações e a ativação continuam.

Identificadores técnicos não aparecem no início: os dados da conta ficam em **Minha conta** (dentro da organização) e
em **Segurança da conta** (na identidade).

---

## Ativação pelo operador (laboratório)

**O que é da tela e o que é do operador.** Pela tela, você cria a organização e vê o estado dela: **Aguardando
ativação** ou **Ativada**. Não existe botão de ativação, e isso é proposital. A ativação define a capacidade de execução:
quantos Workers, quantas execuções simultâneas e quantas pendentes. Ela é um ato da **operação da Nekkora**, feito pela
CLI real dos operadores (`ativar-organizacao`, migration 022). A ativação é auditada com o operador, o certificado, a conta
responsável, o motivo e os limites. No laboratório, você faz o papel da operação no terminal, separado da sua conta
pessoal: a sua conta **nunca** vira operadora.

Enquanto a organização aguarda ativação, pessoas, workspaces e automações já podem ser preparados. Nenhum Worker pode
ser registrado: o código de pareamento de um Agent com Worker novo é recusado. Depois da ativação, ele passa a ser emitido.

### Pré-requisito (uma vez por ambiente)

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh subir                 # o ambiente precisa estar no ar
bash tools/lab/local.sh operador preparar     # ~2 min na primeira vez (compila a imagem do job de operação)
```

O `preparar` monta, sobre o ambiente **já instalado e com os seus dados**, o mesmo desenho da homologação descartável
da API (`ops/homologacao`):

1. **Job de operação**: imagem de `api/e2e/Dockerfile.operacao`, construída da cópia da API. Ela tem a CLI real e a
   ferramenta da homologação.
2. **TLS no PostgreSQL**:
   - certificado do servidor (nome `postgres`) emitido por uma CA do laboratório;
   - CA **operacional** separada, a única que vale para certificados de operador.
3. **Regras novas no `pg_hba`**, à frente das linhas atuais, que não mudam:
   - os papéis `op_*` só entram por **certificado de cliente** (CN = papel), com TLS e só do job de operação;
   - senha, socket local e qualquer outro endereço são recusados.
   O container do PostgreSQL é recriado com o **mesmo volume de dados**; o script confere o volume antes e depois. A API,
   o portal e o gateway reiniciam, e você precisa entrar de novo.
4. **Operadores**: o papel do banco cria `op_lab_cad` e `op_lab_atv`, membros só de `nekkora_ops_mfa`.
   - `op_lab_cad` é o primeiro operador: o cadastro operacional começa por ele (bootstrap da 016);
   - `op_lab_atv` é cadastrado pelas funções da 016, com o certificado do `op_lab_cad`;
   - só depois o `op_lab_atv` recebe `nekkora_org_activation`.
5. **Conta responsável do operador**: uma conta própria do operador, `operador-…@operacao.frontlab.test`, com
   organização própria.
   - Ela é criada pelo fluxo real: cadastro, mensagem da caixa local, autenticador. Não é a sua conta.
   - O código de vínculo é emitido na sessão dela, e a CLI vincula a conta (`vincular-conta`).

**Segredos fora do Git.** Chaves das CAs, a senha do serviço `nekkora_ops_ca` e o estado da conta do operador (e-mail,
senha e chave do autenticador) ficam só em `~/.nekkora/front-lab/frontlab-local/operador/` (0700). As credenciais de
operador (PKCS#12 de **15 minutos**) ficam só no volume `nekkora-frontlab-local_operadores`. Cada ato emite uma
credencial nova. A saída mostra só ids e resultados.

**Limite declarado** (o mesmo da homologação descartável): o certificado do operador é emitido pela biblioteca real
(`EmissorCertificados`), com a CA operacional do laboratório, mas a autenticação do operador no IdP é a do **IdP
simulado** da ferramenta de homologação (`FerramentaHomologacao`/`IdpSimulado`, código de teste). Sem IdP real, não há
outra forma, e por isso o operador local só funciona em ambiente `ensaio-*`. Os certificados das CAs do laboratório
valem 1 ano.

### Ativar uma organização

1. Na tela, crie a organização e confira o selo **Aguardando ativação**.
2. No terminal, veja o identificador dela e ative com limites **explícitos**: Workers, execuções simultâneas,
   execuções pendentes e motivo.

   ```bash
   bash tools/lab/local.sh operador estado       # nome | organização | estado, e os últimos atos (somente leitura)
   bash tools/lab/local.sh ativar <organização> 2 1 10 "laboratório: exploração local"
   # organizacao=<id> resultado=OK evento=<id> motivo=- limites_aplicados=trabalhadores=2,simultaneas=1,pendentes=10,...
   ```

   Repetir dá `resultado=RECUSA motivo=JA_ATIVADA`, sem efeito. Para mudar a capacidade depois, use
   `bash tools/lab/local.sh operador revisar <organização> <workers> <simultaneas> <pendentes> <motivo>`.
3. Volte ao navegador e recarregue **Suas organizações**: o selo passa a **Ativada**. Na organização, **Agents → Parear
   novo Agent** com um Worker novo agora gera o código de uso único. Antes da ativação, a tela dizia que a organização
   ainda não tinha capacidade para registrar Workers.

O `operador estado` mostra a auditoria de cada ato, OK ou RECUSA, com o operador e o motivo. O registro completo fica em
`ops_activation.activation_events`: certificado, conta responsável e as 5 revisões de limite.

---

## 7. Uso no dia seguinte

Todos os comandos rodam na pasta `~/nekkora-local/Nekkora-Platform-Web`, no Git Bash. O Docker Desktop precisa estar
aberto.

```bash
bash tools/lab/local.sh estado    # serviços, resposta da API (200 = pronta) e validade do certificado
bash tools/lab/local.sh parar     # para tudo SEM apagar dados (antes, Ctrl+C no terminal do frontend)
bash tools/lab/local.sh subir     # sobe de novo: banco, Redis, API, portal, gateway e nginx
bash tools/lab/local.sh front     # frontend em http://localhost:5173 (segundo terminal)
```

- **Dados preservados.** O banco fica no volume `nekkora-frontlab-local_pgdados`, e a caixa no
  `nekkora-frontlab-local_caixa`. O `parar` usa `docker compose stop`: nada é removido, e as migrations **não** rodam
  de novo na subida. Conta, MFA e organizações continuam lá. Desligar o PC ou fechar o Docker Desktop tem o mesmo
  efeito do `parar`.
- **Sessões.** As sessões ficam no Redis, que não guarda dados em disco. Depois de uma subida, entre de novo (senha e
  código). Isso é esperado.
- **Certificado.** A chave TLS do nginx nunca fica em disco: ela é apagada assim que o nginx a carrega. Por isso, cada
  `subir` gera um certificado novo, válido por 7 dias. O `front` sempre usa o certificado atual: depois de um `subir`,
  reinicie o `front`.
- **Diagnóstico.** `node tools/lab/lab.mjs frontlab-local compose logs --tail 50 platform` mostra o log da API. O log
  não traz senhas, tokens nem cookies.

### Atualizar o ambiente para uma revisão nova (sem reinstalar)

Quando uma revisão nova for integrada (por exemplo, depois do merge dos PRs), leve as **duas** pastas juntas e rode o
`atualizar`. Ele não apaga nada: faz uma cópia de segurança do banco, aplica **só** as migrations que o banco ainda não
tem, pelo mesmo migrador da instalação (com as mesmas janelas de privilégio e a retirada conferida), e sobe a API nova.

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh parar                         # se estiver no ar (Ctrl+C no front antes)
git fetch origin && git checkout <branch ou main> && git pull --ff-only
npm run lib:prepare && npm ci
# a cópia da API na revisão em que o contrato deste frontend está fixado
API=$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' contract/SOURCE.json)
git -C ../Nekkora-Platform-API fetch origin && git -C ../Nekkora-Platform-API checkout --detach "$API"
bash tools/lab/local.sh atualizar ../Nekkora-Platform-API
bash tools/lab/local.sh front
```

- **Recusas que protegem os dados:** cópia da API com alterações locais, revisão diferente da fixada no contrato,
  migration já aplicada que mudou ou sumiu na revisão nova, banco sem o marcador de inicialização completa. Em qualquer
  delas, nada é alterado.
- **Cópia de segurança:** `~/.nekkora/front-lab/frontlab-local/copias/antes-de-<versão>-<data>.dump` (formato do
  `pg_dump`). Fica só neste computador, fora do Git: ela contém os seus dados.
- **Registro:** `tools/lab/saidas/frontlab-local/atualizacoes.txt` (data, commit da API, versões) e o log do migrador
  em `atualizacao-<versão>.txt`.
- **Se o migrador falhar:** a API fica parada e o banco continua na versão anterior (cada migration é uma transação). O
  caminho de volta é restaurar a cópia de segurança, que é destrutivo; peça ajuda antes.

### Fora do caminho normal: apagar o ambiente (destrutivo)

Só quando quiser recomeçar do zero. **Este comando apaga a conta, o MFA, as organizações e a caixa.** Ele remove só
este ambiente:

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh parar
node tools/lab/lab.mjs frontlab-local compose down -v      # containers, rede e volumes DESTE projeto
docker volume rm nekkora-frontlab-local_operadores 2>/dev/null   # só se o operador local foi preparado
rm -rf ~/.nekkora/front-lab/frontlab-local tools/lab/saidas/frontlab-local
```

Depois, volte à seção 3 (`instalar`).

---

## 8. Validação deste guia (2026-11-02, Windows 11 Pro 26200, Git Bash)

Feita numa pasta limpa, com clones novos (API `e04a57c`, frontend `feat/front-v1-002-provas`), num ambiente de ensaio
próprio (`frontlab-ensaio-uso`, portas 47453/47452, sub-rede 10.251.81). As portas e a sub-rede eram diferentes das
padrão deste guia, para não ocupar as suas. Ferramentas: Git 2.55, Docker Engine 29.7.2 com Compose v5.3.1, Node
24.19.0, npm 11.17.0 e JDK 21.0.12.

| Passo | Resultado |
|---|---|
| Pré-requisitos e clones | conferidos; `mvnw -DskipTests package` gerou os 5 jars |
| `lib:prepare` / `npm ci` / `lib:verify` | sha256 `1a2e6145…` confere; sha512 do lock confere |
| `instalar` | migrations 001–028, `fim … estado=0\|0\|0`, invariantes da 016 OK; API 200 em 43 s |
| TLS do repasse | CA do ambiente → 200; CA de outro ambiente → 502 (recusado) |
| 1–4 pela interface | cadastro → "Confira seu e-mail" → link pela caixa local → conclusão → primeiro MFA → organização com confirmação de segurança → uma vez, "Aguardando ativação" → entrar (nome visível) → sair |
| Cookies e CSRF | todos os `__Host-` com `Secure`, `HttpOnly`, `Path=/`; escrita sem CSRF → 403 |
| 5 | `parar`, Docker Desktop encerrado e reaberto, `subir` (12 s), `front`. A mesma conta entrou com MFA, e a organização estava lá. O banco foi inicializado uma única vez ("Skipping initialization" na segunda subida) |

O percurso automatizado que reproduz a validação está em `e2e-real/uso-local.spec.ts`. A conta é descartável e criada
pela interface, sem SQL, sem fixture e sem chamada direta à API. O link vem do mesmo `local.sh link`.

**Achado corrigido durante a validação.** No passo 4, a área da organização mostrava só o identificador abreviado
("Organização e6a3122e…29a3"), e não o nome. A causa estava no frontend: a sessão de organização não traz o nome
(D1/D7), mas a lista da identidade traz. A área interna agora lê o nome dessa lista. Sem sessão de identidade, como na
entrada antiga por organização, ela mantém o identificador abreviado.

## 9. Validação da atualização e do MFA opcional (2026-11-02)

Ambientes descartáveis próprios (`frontlab-ensaio-atualiza`, `frontlab-ensaio-mfa`), contas `@frontlab.test` e
`@ensaio.nekkora.test`, caixa local. Nenhum dado do `frontlab-local` foi lido ou alterado.

| Prova | Resultado |
|---|---|
| Ambiente instalado na revisão anterior (frontend `4943b4b`, API `e04a57c`, banco 028) com conta COM autenticador e organização → `atualizar` para a API `40b1e1c` | cópia de segurança de 1,3 MB; só a 029 aplicada, janela de SUPERUSER com retirada `0\|0\|0`; marcador `versao=029`; 1 identidade, 1 fator ativo, 10 códigos e 1 organização antes e depois |
| A mesma conta depois da atualização (`uso-local.spec.ts`, passo 5) | entra com senha **e código**; a organização continua |
| MFA opcional e roteiro (`mfa-opcional.spec.ts`) | conta sem autenticador entra sem QR; ação sensível sem confirmação: 403; organização e convite com a senha; a segunda pessoa (sem autenticador) aceita com a senha; papel conferido; ativação voluntária; a entrada seguinte pede o código e a senha não substitui mais |
| Ativação real (`ativacao-operador.spec.ts`, API 029) | Aguardando ativação → CLI `ativar-organizacao` com `op_lab_atv`, certificado e limites 2/1/10 → Ativada; repetição `JA_ATIVADA`; Worker novo passa a ser aceito |
