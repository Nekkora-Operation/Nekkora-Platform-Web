# LIB-01 — `Field` não exportado e `Input type="file"` inutilizável (encaminhamento à Nekkora-lib)

| | |
|---|---|
| Biblioteca | `nekkora-lib` 0.2.0, commit `0a29d95fbadb19da74cfa90a55542fb14885458d` (tarball sha256 `1a2e6145…26a6`) |
| Onde aparece | `src/pages/product/VersionPage.tsx` (envio do pacote ZIP) |
| Responsável | Equipe da Nekkora-lib (o frontend não altera a lib) |

## LIB-01a — `Field` existe em `src/components/Field` mas não é exportado

`import { Field } from 'nekkora-lib'` não existe (só `Fieldset`). Reprodução: `src/test/lib/libGaps.test.tsx`
(`'Field' in lib === false`). Sem ele, um controle que a lib não cobre (ex.: arquivo) não tem rótulo, dica e
mensagem de erro com a mesma marcação dos demais campos.

## LIB-01b — `Input type="file"` lança `InvalidStateError` ao escolher um arquivo

`Input` é sempre controlado (`value={current}`) e, no `onChange`, escreve `event.target.value = format(...)`. Num
input de arquivo o navegador só aceita escrever string vazia.

Reprodução mínima (navegador real; o jsdom NÃO reproduz): `tools/repro/lib-01/` —
`index.html` + `main.tsx` renderizam `<Input type="file" label="Arquivo" accept=".zip" onChange=…/>`, e `run.mjs`
(Playwright) escolhe um arquivo:

```
pageerror: Failed to set the 'value' property on 'HTMLInputElement': This input element accepts a filename,
which may only be programmatically set to the empty string.
onChange: nunca chamado    files depois da escolha: 0
```

Como rodar: `npx vite --port 5199 --strictPort` na raiz do frontend e, em outro terminal,
`node tools/repro/lib-01/run.mjs`.

## Composição local mantida (justificada)

`VersionPage` usa `<input type="file">` nativo com as classes `nk-field`, `nk-field__label` e `nk-field__message` da
própria lib, `aria-describedby` e `aria-invalid`. Não copia código da lib.

## Critérios de aceite

1. `Field` exportado (ou um `FileInput` com rótulo, dica, erro e `accept`).
2. `Input type="file"` não controla `value`, não reescreve `event.target.value`, entrega `event.target.files`.
3. Teste da lib em navegador real (o jsdom aceita a escrita e esconde o defeito).
4. Frontend: troca a composição local pelo componente; `libGaps.test.tsx` passa a falhar e é removido.
