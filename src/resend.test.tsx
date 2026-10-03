import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lbl, ORG, setupFake, user } from './test/helpers';
import { renderApp } from './test/render';

// Liga a flag só neste arquivo: a interface está pronta para quando a API tiver a rota (divergência D2).
vi.mock('./config', () => ({ config: { siteUrl: 'https://nekkora.com' }, features: { resendVerification: true } }));

setupFake();

describe('Reenviar verificação (flag ligada)', () => {
  it('link no login e resposta genérica idêntica exista ou não a conta', async () => {
    const texts: string[] = [];
    for (const email of ['ana@empresa.com', 'ninguem@empresa.com']) {
      const view = renderApp(`/o/${ORG}/login`);
      await user().click(screen.getByRole('link', { name: 'Reenviar verificação de e-mail' }));
      expect(await screen.findByRole('heading', { name: 'Reenviar verificação' })).toBeInTheDocument();
      await user().type(screen.getByLabelText(lbl('E-mail')), email);
      await user().click(screen.getByRole('button', { name: 'Enviar link' }));
      await screen.findByRole('heading', { name: 'Confira seu e-mail' });
      texts.push(screen.getByRole('main').textContent ?? '');
      view.unmount();
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).toContain('Se existir uma conta elegível que ainda precise de confirmação, enviaremos uma nova mensagem.');
    expect(texts[0]).not.toMatch(/não existe|já está confirmado/);
  });
});
