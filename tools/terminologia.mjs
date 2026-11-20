// PLATFORM-FLUXO-002 — troca de "Workspace" por "Ambiente de trabalho" SÓ no texto visível, pelo analisador do rolldown
// (oxc): literais de texto, partes de template e texto JSX. Nunca identificadores, tipos, rotas ("/workspaces"), chaves de
// objeto, importações, nem um literal que é exatamente "workspace"/"workspaces" em minúsculas (id de menu, ícone, escopo).
// Uso: node tools/terminologia.mjs <arquivos...>   (grava no lugar e imprime quantas trocas por arquivo)
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAst } from 'rolldown/parseAst';

const WORD = /(?<![A-Za-z0-9_/.\-#$@?&])(Workspaces|workspaces|Workspace|workspace)(?![A-Za-z0-9_/\-:(=]|\.[a-z_])/g;
const MAP = { Workspaces: 'Ambientes de trabalho', workspaces: 'ambientes de trabalho', Workspace: 'Ambiente de trabalho', workspace: 'ambiente de trabalho' };
const technical = (text) => /^(workspaces?)$/.test(text);

let total = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  const edits = [];
  const visit = (n, parent, key, inType) => {
    if (!n || typeof n.type !== 'string') return;
    // expressões que só embrulham um valor ("x as T", "x!", "x satisfies T") NÃO são posição de tipo: o tipo delas é um filho
    const wrapper = ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'].includes(n.type);
    const typeCtx = inType || (n.type.startsWith('TS') && !wrapper) || n.type === 'ImportDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source);
    let range = null;
    if (!typeCtx) {
      if (n.type === 'Literal' && n.regex && process.env.TERMINOLOGIA_REGEX === '1') {
        // só nos testes: expressões regulares que conferem o texto da tela
        range = [n.start + 1, n.end - 1 - n.regex.flags.length];
      } else if (n.type === 'Literal' && typeof n.value === 'string') {
        const isKey = parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key';
        const isImport = parent && (parent.type === 'ImportExpression' || parent.type === 'ExportAllDeclaration');
        if (!isKey && !isImport && !technical(n.value)) range = [n.start + 1, n.end - 1];
      } else if (n.type === 'TemplateElement') {
        range = [n.start, n.end];
      } else if (n.type === 'JSXText') {
        range = [n.start, n.end];
      }
    }
    if (range) {
      const raw = src.slice(range[0], range[1]);
      WORD.lastIndex = 0;
      let m;
      while ((m = WORD.exec(raw))) edits.push([range[0] + m.index, m[0].length, MAP[m[0]]]);
    }
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, n, k, typeCtx));
      else if (v && typeof v === 'object') visit(v, n, k, typeCtx);
    }
  };
  visit(ast, null, null, false);
  if (!edits.length) continue;
  // um mesmo trecho pode ser visitado duas vezes (nós que se repetem na árvore): sem duplicar
  const unique = [...new Map(edits.map((e) => [e[0], e])).values()].sort((a, b) => b[0] - a[0]);
  let out = src;
  for (const [at, len, rep] of unique) out = out.slice(0, at) + rep + out.slice(at + len);
  writeFileSync(file, out);
  total += unique.length;
  console.log(`${file}: ${unique.length}`);
}
console.log(`total: ${total}`);
