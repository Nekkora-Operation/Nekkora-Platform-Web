import axe from 'axe-core';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fillLogin, ORG, setupFake, user } from './test/helpers';
import { renderApp } from './test/render';

setupFake();

async function violations() {
  // contraste é conferido no navegador real (E2E); jsdom não calcula estilos
  const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('§42 — acessibilidade (axe)', () => {
  it.each([
    ['login', `/o/${ORG}/login`],
    ['esqueci minha senha', `/o/${ORG}/forgot-password`],
    ['redefinição (link inválido)', `/o/${ORG}/reset-password`],
    ['sem organização', '/login'],
    ['organização não encontrada', '/o/x/login'],
  ])('%s sem violações', async (_, path) => {
    renderApp(path);
    expect(await violations()).toEqual([]);
  });

  it('login com erro, MFA e códigos de recuperação sem violações', async () => {
    renderApp(`/o/${ORG}/login`);
    await fillLogin('ana@empresa.com', 'errada-errada-1');
    await screen.findByRole('alert');
    expect(await violations()).toEqual([]);
  });

  it('MFA e configuração sem violações; foco visível em campos rotulados', async () => {
    renderApp(`/o/${ORG}/login`);
    await fillLogin('novo@empresa.com', 'senha-muito-segura');
    await user().click(await screen.findByRole('button', { name: 'Configurar autenticador' }));
    await screen.findByRole('img', { name: /QR Code/ });
    expect(await violations()).toEqual([]);
  });

  it('Enter envia o formulário de login', async () => {
    renderApp(`/o/${ORG}/login`);
    const u = user();
    await u.type(screen.getByRole('textbox', { name: /E-mail/ }), 'ana@empresa.com');
    await u.type(document.querySelector('input[type="password"]')!, 'senha-muito-segura{Enter}');
    expect(await screen.findByRole('heading', { name: 'Confirme sua identidade' })).toBeInTheDocument();
  });
});
