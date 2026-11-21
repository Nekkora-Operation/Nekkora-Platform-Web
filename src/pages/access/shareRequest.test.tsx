import { StrictMode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { csrfStore } from '../../api/csrf';
import { createOperationRegistry, setOperationRegistryForTest } from '../../api/pendingOps';
import { OperationScopeProvider } from '../../components/operationScope';
import { fakeLocks } from '../../test/fakeLocks';
import { RouteApi } from '../../test/routeApi';
import { ShareAutomationPanel } from './ShareRequests';

/**
 * PLATFORM-FLUXO-002 (071) — pedido de compartilhamento de um membro (client_share.request) a partir da página da automação: o
 * pedido não envia nada à pessoa; o que foi digitado antes de as opções chegarem não se perde; só conteúdos que o membro pode ver.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const A1 = ID(21);
const WS = ID(11);
const T = '2026-11-20T10:00:00Z';

let api: RouteApi;
let release: () => void;
beforeEach(() => {
  csrfStore.clear();
  csrfStore.setSession(ORG, 'ses');
  vi.unstubAllGlobals();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
  api = new RouteApi().install();
  const held = new Promise<{ status: number; body: unknown }>((r) => {
    release = () =>
      r({
        status: 200,
        body: {
          mode: 'request',
          automations: [{ automationId: A1, name: 'Robô de notas', workspaceId: WS, workspaceName: 'Fiscal', machines: [], canShareDashboard: true, canShareFiles: false }],
        },
      });
  });
  api.on('GET', `/api/v1/o/${ORG}/client-share-options`, 'listClientShareOptions', () => ({ hold: held }) as never);
  api.on('GET', new RegExp(`^/api/v1/o/${ORG}/client-share-requests`), 'listClientShareRequests', { status: 200, body: { items: [] } });
});

describe('pedido de compartilhamento do membro', () => {
  it('o nome digitado antes das opções chegarem continua; só o que o membro pode ver; o corpo enviado é o pedido', async () => {
    api.on('POST', `/api/v1/o/${ORG}/client-share-requests`, 'requestClientShare', {
      status: 201,
      body: {
        shareRequestId: ID(90), status: 'PENDENTE', recipientName: 'Pedro', email: 'pedro@cliente.com', workspaceId: WS, automationId: A1, workerId: null,
        canViewDashboard: true, canDownloadResults: false, requestedByMembershipId: ID(52), createdAt: T, decidedAt: null, invitationId: null,
      },
    });
    render(
      <StrictMode>
        <MemoryRouter>
          <OperationScopeProvider value={{ org: ORG, subject: async () => ID(52) }}>
            <ShareAutomationPanel org={ORG} automationId={A1} automationName="Robô de notas" onUnauthenticated={() => undefined} />
          </OperationScopeProvider>
        </MemoryRouter>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pedir compartilhamento' }));
    fireEvent.change(screen.getByLabelText(/^Nome da pessoa/), { target: { value: 'Pedro' } });
    fireEvent.change(screen.getByLabelText(/^E-mail da pessoa/), { target: { value: 'pedro@cliente.com' } });
    release();
    const files = await screen.findByRole('checkbox', { name: /^Arquivos de retorno/ });
    expect(files).toBeDisabled();
    expect(screen.getByText('Você só pode compartilhar o que você mesmo pode ver nesta automação.')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Nome da pessoa/)).toHaveValue('Pedro');
    fireEvent.click(screen.getByRole('button', { name: 'Revisar pedido' }));
    const d = await screen.findByRole('alertdialog', { name: 'Pedir o compartilhamento de Robô de notas com Pedro?' });
    fireEvent.click(within(d).getByRole('button', { name: 'Enviar pedido' }));
    expect(await screen.findByText('Pedido enviado para aprovação. Nada foi enviado à pessoa ainda.')).toBeInTheDocument();
    expect(api.sent('POST', `/api/v1/o/${ORG}/client-share-requests`)[0].body).toEqual({
      email: 'pedro@cliente.com', name: 'Pedro', automationId: A1, workerId: null, canViewDashboard: true, canDownloadResults: false,
    });
  });
});
