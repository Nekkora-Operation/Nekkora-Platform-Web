import type { Tone } from 'nekkora-lib';
import type { OrganizationActivationState } from '../api/identity';

/** Papéis do contrato (RoleCode), em português. Código desconhecido aparece como veio (nunca omitido). */
export const ROLE_LABEL: Record<string, string> = {
  ORG_ADMIN: 'Administração da organização',
  WORKSPACE_ADMIN: 'Administração de workspace',
  OPERATOR: 'Operação',
  VIEWER: 'Leitura',
};

export const LICENSED_MODEL_TEXT =
  'Esta organização usa o modelo por licença: Workers podem ser registrados dentro do limite técnico de capacidade, e cada automação executa e é monitorada quando tem uma licença vigente vinculada. A ativação pela operação da Nekkora não se aplica a ela.';

/**
 * Ciclo de ativação (022), independente da situação administrativa. AGUARDANDO_ATIVACAO: capacidade de execução zero
 * até a operação da Nekkora ativar; a interface não promete execução nem oferece botão de ativação (não há rota).
 */
export function activationLabel(
  state: OrganizationActivationState,
  licenseModel?: 'legacy' | 'licensed',
): { label: string; tone: Tone; description: string } {
  // PLATFORM-LICENCIAMENTO-001: no modelo por licença a capacidade é técnica e não depende da ativação. Dizer "aguardando
  // ativação: nenhum Worker pode ser registrado" seria falso; o que habilita cada automação é a licença.
  if (licenseModel === 'licensed') {
    return {
      label: 'Modelo por licença',
      tone: 'info',
      description: LICENSED_MODEL_TEXT,
    };
  }
  return state === 'ATIVADA'
    ? { label: 'Ativada', tone: 'success', description: 'A operação da Nekkora definiu a capacidade de execução desta organização.' }
    : {
        label: 'Aguardando ativação',
        tone: 'warning',
        description:
          'Organização criada, ainda sem capacidade de execução: nenhum Worker pode ser registrado e nenhuma automação executa até a ativação pela operação da Nekkora. Pessoas, workspaces e automações já podem ser preparados.',
      };
}
