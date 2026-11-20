import type { Tone } from 'nekkora-lib';
import type { OrganizationActivationState } from '../api/identity';

/** Papéis do contrato (RoleCode), em português. Código desconhecido aparece como veio (nunca omitido). */
export const ROLE_LABEL: Record<string, string> = {
  ORG_ADMIN: 'Administração da organização',
  WORKSPACE_ADMIN: 'Administração de ambiente de trabalho',
  OPERATOR: 'Operação',
  VIEWER: 'Leitura',
};

export const LICENSED_MODEL_TEXT =
  'Organização pronta para configurar: pessoas, ambientes de trabalho, automações e Workers já podem ser preparados, dentro do limite técnico de capacidade, sem depender de aprovação da Nekkora. Para executar e monitorar uma automação, vincule a ela uma licença vigente.';

/**
 * O que dizer ANTES de criar, pelo modelo em que a organização nova nasce (D7, `newOrganizationLicenseModel`). No modelo por
 * licença a criação não depende de autorização da Nekkora e não há ativação a esperar: a falta de licença só impede executar
 * e monitorar, não preparar.
 */
export const BORN_LICENSED = {
  title: 'A organização nasce pronta para configurar.',
  body: 'Você já pode preparar pessoas, ambientes de trabalho, automações e Workers, sem depender de aprovação da Nekkora. Para executar e monitorar uma automação, vincule a ela uma licença vigente.',
};

/**
 * DISPONIBILIDADE DE EXECUÇÃO da organização, que é outra coisa que a SITUAÇÃO dela (ativa, desativada pelo responsável,
 * bloqueada pela Nekkora; ver {@link SITUATION_LABEL}). Os rótulos dizem a dimensão ("Execução: …") para que "ativa" e
 * "aguardando ativação" não apareçam lado a lado como se fossem a mesma coisa.
 *
 * Modelo anterior (022): AGUARDANDO_ATIVACAO é capacidade de execução zero até a operação da Nekkora ativar; a interface
 * não promete execução nem oferece botão de ativação (não há rota).
 */
export function activationLabel(
  state: OrganizationActivationState,
  licenseModel?: 'legacy' | 'licensed',
): { label: string; tone: Tone; description: string } {
  // PLATFORM-LICENCIAMENTO-001: no modelo por licença a capacidade é técnica e não depende da ativação. Dizer "aguardando
  // ativação: nenhum Worker pode ser registrado" seria falso; o que habilita cada automação é a licença.
  if (licenseModel === 'licensed') {
    return {
      label: 'Execução: por licença',
      tone: 'info',
      description: LICENSED_MODEL_TEXT,
    };
  }
  return state === 'ATIVADA'
    ? { label: 'Execução: liberada', tone: 'success', description: 'A operação da Nekkora definiu a capacidade de execução desta organização.' }
    : {
        label: 'Execução: aguardando ativação',
        tone: 'warning',
        description:
          'Organização criada, ainda sem capacidade de execução: nenhum Worker pode ser registrado e nenhuma automação executa até a ativação pela operação da Nekkora. Pessoas, ambientes de trabalho e automações já podem ser preparados.',
      };
}

/** SITUAÇÃO da organização (não é a disponibilidade de execução): quem a mantém em funcionamento ou a parou. */
export const SITUATION_LABEL = {
  ACTIVE: 'Situação: ativa',
  DEACTIVATED: 'Situação: desativada por você',
  BLOCKED: 'Situação: bloqueada pela Nekkora',
} as const;
