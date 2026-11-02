import type { Tone } from 'nekkora-lib';
import type { OrganizationActivationState } from '../api/identity';

/** Papéis do contrato (RoleCode), em português. Código desconhecido aparece como veio (nunca omitido). */
export const ROLE_LABEL: Record<string, string> = {
  ORG_ADMIN: 'Administração da organização',
  WORKSPACE_ADMIN: 'Administração de workspace',
  OPERATOR: 'Operação',
  VIEWER: 'Leitura',
};

/**
 * Ciclo de ativação (022), independente da situação administrativa. AGUARDANDO_ATIVACAO: capacidade de execução zero
 * até a operação da Nekkora ativar; a interface não promete execução nem oferece botão de ativação (não há rota).
 */
export function activationLabel(state: OrganizationActivationState): { label: string; tone: Tone; description: string } {
  return state === 'ATIVADA'
    ? { label: 'Ativada', tone: 'success', description: 'A operação da Nekkora definiu a capacidade de execução desta organização.' }
    : {
        label: 'Aguardando ativação',
        tone: 'warning',
        description:
          'Organização criada, ainda sem capacidade de execução: nenhum Worker pode ser registrado e nenhuma automação executa até a ativação pela operação da Nekkora. Pessoas, workspaces e automações já podem ser preparados.',
      };
}
