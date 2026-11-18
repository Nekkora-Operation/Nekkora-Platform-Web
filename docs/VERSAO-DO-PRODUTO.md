# Versão do produto (Nekkora Platform)

O rodapé do menu e "Sobre esta versão" mostram a versão **do produto**, lida de `product.json`, na raiz deste
repositório. É a única fonte: não é a versão do pacote do frontend (`package.json`), nem a da Nekkora-lib, nem a da API,
nem um commit.

## Valor atual: 2.1

`product.json` traz `2.1` porque **2.1 é a última release da Nekkora Platform publicada com esse nome**
(NEKKORA-RELEASE-2.1, em produção desde 12/11/2026).

| Referência | Onde conferir |
|---|---|
| Web | PR #41 "Release 2.1: promoção dev → main (Web)", mesclada em 12/11/2026; commit de merge na `main`: `95f7ee3ad608cfc8fc82d7ded0e81fc181917f17` |
| API | Nekkora-Platform-API, PR #57 "Release 2.1: promoção dev → main (API)", mesclada em 12/11/2026; commit de merge na `main`: `50d673680873f0d9cc44adbc9f7bf51e5b4a728c` |
| Agent | Nekkora-Agent, PR #10; commit na `main`: `4097e0763eb2e6189dc02d527b684e9ce7727854` |
| Banco | migrations 031 a 035 (produção foi de 030 a 035) |
| Manifesto e relatório da release | `MANIFESTO-2.1.md` e `RELATORIO-RELEASE-2.1.md`, guardados com a release, fora deste repositório |

## O que esta referência não cobre

- **Não existe tag nem Release do GitHub** chamada 2.1 (ou qualquer outra) nos repositórios da Web e da API. O nome "2.1"
  está só nos títulos das PRs de promoção acima e no manifesto. Por isso o número foi gravado à mão em `product.json`.
- **A `main` andou depois da 2.1 sem um novo nome de release**: Web PR #46 (15/11/2026, "entrada do aplicativo desktop e
  download de pacote") e API PR #65 (15/11/2026, migrations 036 a 041). Nenhum documento dá a essas promoções um número de
  versão; a 2.1 continua sendo o último número oficial conhecido.
- O número **2.2.1** que aparece na referência visual do rodapé é do desenho, não de uma release, e não foi usado.

## Quando mudar

O número muda quando uma release é publicada com um novo nome, na mesma PR que a prepara: altere `version` em
`product.json` e acrescente a referência da release nesta página. Os testes conferem o formato do rodapé, não o número.
