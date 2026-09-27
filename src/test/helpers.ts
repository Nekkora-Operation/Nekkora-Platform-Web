import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, vi } from 'vitest';
import { csrfStore } from '../api/csrf';
import { sessionMemory } from '../app/notices';
import { captureInitialLinkToken, resetLinkTokenCapture } from '../auth/linkToken';
import { FakeApi, ORG } from './fakeApi';

export { ORG };

/** Rótulo do campo, com ou sem o marcador visual de obrigatório (*). */
export function lbl(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\*?$`);
}

export function setupFake(): { api: () => FakeApi } {
  let api: FakeApi;
  beforeEach(() => {
    csrfStore.clear();
    sessionMemory.reset();
    resetLinkTokenCapture();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    api = new FakeApi().install();
  });
  return { api: () => api };
}

export const user = () => userEvent.setup();

export function location() {
  return screen.getByTestId('location').textContent;
}

/** Simula a abertura de um link de e-mail: a URL real contém o token no fragmento. */
export function openLink(path: string, token: string) {
  window.history.replaceState(null, '', `${path}#token=${token}`);
  captureInitialLinkToken();
}

export async function fillLogin(email: string, password: string) {
  const u = user();
  await u.type(screen.getByLabelText(lbl('E-mail')), email);
  await u.type(screen.getByLabelText(lbl('Senha')), password);
  await u.click(screen.getByRole('button', { name: 'Entrar' }));
  return u;
}

export function withinCard(title: string) {
  return within(screen.getByRole('region', { name: title }));
}
