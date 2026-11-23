import { Alert } from 'nekkora-lib';
import { ApiError } from '../api/http';
import { useOptionalSession } from '../area/session';

/**
 * NEKKORA-LICENCIAMENTO-002 (075): a organização está BLOQUEADA PELA NEKKORA (`me.organizationHeldByNekkora`). Separado da
 * desativação voluntária: quem administra a organização não desfaz. Trabalho e operações novos são recusados pela API (403
 * forbidden + organization_held); a leitura continua e o que já começou termina e entrega. O motivo fica com o suporte.
 * Ausente (API anterior ao campo) = não bloqueada. Quem decide continua sendo cada rota da API.
 */
export const ORGANIZATION_HELD_REASON = 'organization_held';
export const ORGANIZATION_HELD_TITLE = 'Organização bloqueada pela Nekkora';
export const ORGANIZATION_HELD_BODY =
  'Novas operações estão suspensas: criar, alterar, autorizar, parear máquinas e iniciar execuções. Você continua vendo o histórico, os resultados e os registros, e o que já estava em andamento termina e entrega. Para entender o motivo e regularizar, fale com o suporte da Nekkora; só o suporte desfaz o bloqueio.';
/** A recusa de um ato por causa do bloqueio, para as mensagens de erro das telas. */
export const ORGANIZATION_HELD_REFUSAL =
  'A organização está bloqueada pela Nekkora: novas operações estão suspensas. Fale com o suporte da Nekkora. Nada foi alterado.';

export function useOrganizationHeld(): boolean {
  return useOptionalSession()?.me.organizationHeldByNekkora === true;
}

/** A recusa veio do bloqueio da Nekkora (403 forbidden + organization_held)? */
export function isOrganizationHeld(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'forbidden' && e.reason === ORGANIZATION_HELD_REASON;
}

/** Aviso no topo da área da organização enquanto o bloqueio estiver aberto. */
export function OrganizationHeldNotice({ className }: { className?: string }) {
  const held = useOrganizationHeld();
  if (!held) return null;
  return (
    <Alert tone="danger" title={ORGANIZATION_HELD_TITLE} className={className}>
      {ORGANIZATION_HELD_BODY}
    </Alert>
  );
}
