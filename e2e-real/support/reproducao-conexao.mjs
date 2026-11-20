// Reprodução direcionada da ocorrência "conexão recusada" (passada 7 do roteiro da máquina): N navegações reais do navegador
// ao servidor de páginas do laboratório. Uso: node reproducao-conexao.mjs <origem> <N>
import { chromium } from '@playwright/test';
const [origin, n] = [process.argv[2], Number(process.argv[3] ?? 300)];
const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();
const errors = {};
let ok = 0;
const t0 = Date.now();
for (let i = 0; i < n; i++) {
  try {
    const r = await page.goto(`${origin}/entrar?i=${i}`, { waitUntil: 'load', timeout: 20000 });
    if (r && r.status() === 200) ok++;
    else errors[`status ${r?.status()}`] = (errors[`status ${r?.status()}`] ?? 0) + 1;
  } catch (e) {
    const k = String(e.message).split('\n')[0].replace(/\?i=\d+/, '').slice(0, 90);
    errors[k] = (errors[k] ?? 0) + 1;
  }
}
await browser.close();
console.log(JSON.stringify({ navegacoes: n, ok, erros: errors, segundos: Math.round((Date.now() - t0) / 1000) }));
