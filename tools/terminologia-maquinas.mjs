// PLATFORM-FLUXO-002 — "Worker" passa a "máquina" SÓ no texto visível (literais, partes de template e texto JSX), pelo
// analisador do rolldown (oxc), com a concordância de gênero ("o Worker autorizado" -> "a máquina autorizada"). Nunca
// identificadores, tipos, rotas (/workers), chaves de objeto nem importações. A revisão final é humana.
// Uso: node tools/terminologia-maquinas.mjs <arquivos...>   (TERMINOLOGIA_REGEX=1 também em expressões regulares)
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAst } from 'rolldown/parseAst';

const W = '(?<![A-Za-z0-9_/.\\-#$@?&])';
const E = '(?![A-Za-z0-9_/\\-:(=]|\\.[a-z_])';
const rule = (from, to) => [new RegExp(from.replace('<W>', `${W}`) + E, 'g'), to];
const RULES = [
  // artigos, demonstrativos e contrações: o gênero muda
  ...[
    ['Nenhum', 'Nenhuma'], ['nenhum', 'nenhuma'], ['Outro', 'Outra'], ['outro', 'outra'], ['Este', 'Esta'], ['este', 'esta'],
    ['Esse', 'Essa'], ['esse', 'essa'], ['deste', 'desta'], ['neste', 'nesta'], ['nesse', 'nessa'], ['desse', 'dessa'],
    ['do', 'da'], ['no', 'na'], ['ao', 'à'], ['pelo', 'pela'], ['Um', 'Uma'], ['um', 'uma'], ['O', 'A'], ['o', 'a'],
    ['seu', 'sua'], ['Seu', 'Sua'], ['cada', 'cada'], ['mesmo', 'mesma'], ['novo', 'nova'], ['próprio', 'própria'],
  ].map(([a, b]) => rule(`(?<![A-Za-zÀ-ú])${a} Worker\\b`, `${b} máquina`)),
  ...[
    ['dos', 'das'], ['nos', 'nas'], ['aos', 'às'], ['pelos', 'pelas'], ['Os', 'As'], ['os', 'as'], ['seus', 'suas'],
    ['outros', 'outras'], ['novos', 'novas'], ['Nenhuns', 'Nenhumas'],
  ].map(([a, b]) => rule(`(?<![A-Za-zÀ-ú])${a} Workers\\b`, `${b} máquinas`)),
  // o resto: plural e singular; maiúscula no começo do texto ou de frase
  [new RegExp(`(^|[.!?:]\\s+|\\n\\s*)Workers${E}`, 'g'), '$1Máquinas'],
  [new RegExp(`(^|[.!?:]\\s+|\\n\\s*)Worker${E}`, 'g'), '$1Máquina'],
  [new RegExp(`${W}Workers${E}`, 'g'), 'máquinas'],
  [new RegExp(`${W}Worker${E}`, 'g'), 'máquina'],
];
// concordância do que vem logo depois ("máquina autorizado" -> "máquina autorizada")
const ADJ = ['autorizad', 'criad', 'vinculad', 'escolhid', 'cadastrad', 'retirad', 'desativad', 'selecionad', 'ativad', 'listad', 'informad', 'associad', 'pareado', 'conectad', 'desvinculad', 'indicad', 'usad'];
const AGREE = [
  [new RegExp(`(máquina|Máquina) (${ADJ.join('|')})o\\b`, 'g'), '$1 $2a'],
  [new RegExp(`(máquinas|Máquinas) (${ADJ.join('|')})os\\b`, 'g'), '$1 $2as'],
  [/(máquina|Máquina) ativo\b/g, '$1 ativa'],
  [/(máquinas|Máquinas) ativos\b/g, '$1 ativas'],
  [/(máquina|Máquina) novo\b/g, '$1 nova'],
  [/(máquina|Máquina) suspenso\b/g, '$1 suspensa'],
];

const fix = (t) => {
  let out = t;
  for (const [re, to] of RULES) out = out.replace(re, to);
  for (const [re, to] of AGREE) out = out.replace(re, to);
  return out;
};

let total = 0;
for (const file of process.argv.slice(2)) {
  const src = readFileSync(file, 'utf8');
  const ast = parseAst(src, { lang: file.endsWith('x') ? 'tsx' : 'ts' });
  const ranges = new Map();
  const visit = (n, parent, key, inType) => {
    if (!n || typeof n.type !== 'string') return;
    const wrapper = ['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'].includes(n.type);
    const typeCtx = inType || (n.type.startsWith('TS') && !wrapper) || n.type === 'ImportDeclaration' || (n.type === 'ExportNamedDeclaration' && n.source);
    if (!typeCtx) {
      if (n.type === 'Literal' && n.regex && process.env.TERMINOLOGIA_REGEX === '1') ranges.set(n.start + 1, n.end - 1 - n.regex.flags.length);
      else if (n.type === 'Literal' && typeof n.value === 'string') {
        const isKey = parent && (parent.type === 'Property' || parent.type === 'PropertyDefinition') && key === 'key';
        const isImport = parent && (parent.type === 'ImportExpression' || parent.type === 'ExportAllDeclaration');
        if (!isKey && !isImport) ranges.set(n.start + 1, n.end - 1);
      } else if (n.type === 'TemplateElement' || n.type === 'JSXText') ranges.set(n.start, n.end);
    }
    for (const k of Object.keys(n)) {
      if (k === 'parent') continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, n, k, typeCtx));
      else if (v && typeof v === 'object') visit(v, n, k, typeCtx);
    }
  };
  visit(ast, null, null, false);
  const edits = [...ranges.entries()]
    .map(([a, b]) => [a, b, src.slice(a, b)])
    .filter(([, , t]) => /Workers?/.test(t))
    .map(([a, b, t]) => [a, b, fix(t)])
    .filter(([, , t], i, arr) => t !== src.slice(arr[i][0], arr[i][1]))
    .sort((x, y) => y[0] - x[0]);
  if (!edits.length) continue;
  let out = src;
  for (const [a, b, t] of edits) out = out.slice(0, a) + t + out.slice(b);
  writeFileSync(file, out);
  total += edits.length;
  console.log(`${file}: ${edits.length}`);
}
console.log(`total: ${total}`);
