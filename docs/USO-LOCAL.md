# Platform no seu Windows: primeiro uso local

Este guia instala, no seu computador, o frontend da Platform ligado à **API real**, com banco, Redis, gateway e caixa de
e-mail locais. Nada sai da máquina: sem Microsoft 365, sem AWS e sem envio para uma caixa real.

- **Terminal:** use o **Git Bash** em todos os comandos (Menu Iniciar → "Git Bash"). Os scripts do laboratório são Bash.
  O PowerShell não serve para estes comandos.
- **Frontend:** o candidato cumulativo da pilha #10–#17, na branch `feat/front-v1-002-provas` (PR #17). O código
  validado é o commit `8f65200`; commits posteriores só de documentação não mudam o resultado. As telas ainda **não
  estão na `main`**: não clone a `main` do frontend.
- **API:** `Nekkora-Platform-API` no commit `e04a57ceeb880de603252fcca4e3d7ccc16cc9d5`, que é a `main` atual. O
  contrato do frontend está fixado nesse commit (`contract/SOURCE.json`), e o runner recusa outro.
- **Validação:** cada comando foi executado e conferido no Windows 11 em 2026-11-02 (seção 8).

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

**O autenticador.** No primeiro acesso, a tela "Configure o autenticador" mostra um QR e a chave manual. Leia o QR com o
seu aplicativo (Microsoft Authenticator, Google Authenticator, 1Password etc.) e digite o código de 6 dígitos. Em
seguida, a tela mostra os **códigos de recuperação** uma única vez. Guarde-os fora do Git e fora de qualquer pasta do
projeto. Cada código do autenticador vale uma vez: para entrar de novo logo em seguida, espere o próximo código.

---

## 6. O percurso

1. Em <http://localhost:5173/cadastro>, informe o e-mail e clique em **Continuar**. A tela "Confira seu e-mail" aparece.
   Rode `bash tools/lab/local.sh link <seu e-mail>`.
2. Abra o link. Em "Conclua seu cadastro", informe nome e senha. Em **Entrar**, digite e-mail e senha, configure o
   autenticador e guarde os códigos. Você chega em **Suas organizações**, com "Você ainda não participa de nenhuma
   organização."
3. Clique em **Criar organização**, informe o nome e clique em **Continuar**. A confirmação de segurança pede o código do
   autenticador. Depois de concluir, a organização aparece **uma vez** na lista, com o nome informado e o selo
   **Aguardando ativação**.
4. No cartão da organização, clique em **Entrar em <nome>**. O nome da organização aberta aparece no topo, à esquerda de
   "Trocar organização", e no rodapé do menu. **Trocar organização** volta à lista, e **Sair** encerra a sessão e leva a
   "Você saiu da sua conta."
5. Pare e suba o ambiente (seção 7). Depois, entre de novo em <http://localhost:5173/entrar> com o mesmo e-mail, a mesma
   senha e o código do autenticador. A organização continua na lista.

A ativação da organização, as concessões e a execução remota **não** fazem parte deste percurso. Uma organização nova
fica em "Aguardando ativação".

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

### Fora do caminho normal: apagar o ambiente (destrutivo)

Só quando quiser recomeçar do zero. **Este comando apaga a conta, o MFA, as organizações e a caixa.** Ele remove só
este ambiente:

```bash
cd ~/nekkora-local/Nekkora-Platform-Web
bash tools/lab/local.sh parar
node tools/lab/lab.mjs frontlab-local compose down -v      # containers, rede e volumes DESTE projeto
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
