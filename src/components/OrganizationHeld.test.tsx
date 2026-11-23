/**
 * LICENCIAMENTO-002 (075): o bloqueio da Nekkora aparece como estado próprio da organização, com orientação de suporte, e a
 * recusa dele nunca é apresentada como falta de permissão.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import type { Me } from '../api/auth';
import { SessionProvider, type Session } from '../area/session';
import { accessRefusal } from '../pages/access/shared';
import { refusalText } from '../pages/agents/RemoteExecutions';
import { isOrganizationHeld, OrganizationHeldNotice, ORGANIZATION_HELD_REFUSAL, ORGANIZATION_HELD_TITLE } from './OrganizationHeld';

const ME: Me = { accountType: 'internal', displayName: 'Ana', email: 'ana@empresa.com', organizationId: 'o', organizationActivationState: 'ATIVADA' };

function withSession(me: Me) {
  const session = { org: 'o', me, expired: false, signOut: async () => {}, signingOut: false } as unknown as Session;
  return render(
    <SessionProvider value={session}>
      <OrganizationHeldNotice />
    </SessionProvider>,
  );
}

describe('bloqueio da Nekkora', () => {
  it('mostra o estado e a orientação de suporte só quando a API diz que a organização está bloqueada', () => {
    withSession({ ...ME, organizationHeldByNekkora: true });
    expect(screen.getByText(ORGANIZATION_HELD_TITLE)).toBeInTheDocument();
    expect(screen.getByText(/fale com o suporte da Nekkora; só o suporte desfaz o bloqueio/i)).toBeInTheDocument();
  });

  it('sem o campo (API anterior) ou com false: nada aparece', () => {
    const { container } = withSession(ME);
    expect(container.textContent).toBe('');
    const second = withSession({ ...ME, organizationHeldByNekkora: false });
    expect(second.container.textContent).toBe('');
  });

  it('a recusa pelo bloqueio não se confunde com falta de permissão nem com licença', () => {
    const held = new ApiError('forbidden', 403, undefined, undefined, 'organization_held');
    expect(isOrganizationHeld(held)).toBe(true);
    expect(accessRefusal(held)).toBe(ORGANIZATION_HELD_REFUSAL);
    expect(accessRefusal(new ApiError('forbidden', 403))).toMatch(/permissões/);
    expect(isOrganizationHeld(new ApiError('conflict', 409, undefined, undefined, 'license_required'))).toBe(false);
    expect(refusalText('ORGANIZATION_HELD')).toBe('a organização foi bloqueada pela Nekkora antes do início');
  });
});
