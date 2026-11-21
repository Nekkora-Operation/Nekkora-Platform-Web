import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';

/**
 * Confirma um diálogo de ato (StepUpDialog) como uma pessoa faria: o botão de confirmar só fica habilitado depois que o registro
 * de operações (a proteção contra envio duplicado, lida de forma assíncrona) responde. Clicar antes disso é ignorado pelo
 * navegador (botão desabilitado) — e foi a causa da intermitência do teste do convite sob carga, não um defeito do produto.
 */
export async function confirmWhenReady(dialog: HTMLElement, name: string) {
  const button = within(dialog).getByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled(), { timeout: 5000 });
  fireEvent.click(button);
}
