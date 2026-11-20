/**
 * Textos de licença e de capacidade (PLATFORM-LICENCIAMENTO-001), usados pelas telas que iniciam trabalho. Licença e
 * capacidade são coisas diferentes e os textos nunca as misturam: faltar licença não é "limite atingido", e um limite de
 * capacidade não consome nem pede licença.
 */
import { ApiError } from '../../api/http';

export const LICENSE_REQUIRED_TEXT =
  'Esta automação não tem licença. Nesta organização, executar e monitorar pela Platform exige uma licença vinculada à automação. Quem administra a organização vincula uma licença disponível em Administração › Licenças e capacidade.';
export const LICENSE_EXPIRED_TEXT =
  'A licença desta automação venceu. O que já estava em execução termina e entrega os resultados, e o histórico continua disponível; trabalho novo só depois da renovação, que é feita pelo suporte da Nekkora.';
export const CAPACITY_PENDING_TEXT =
  'A fila de execuções desta organização está cheia. Isso é um limite de capacidade, não de licença: aguarde uma execução pendente começar ou terminar e tente de novo. Nada foi solicitado.';

/** O texto de uma recusa por licença ou por capacidade (409 conflict + reason), ou nulo quando o motivo é outro. */
export function licenseRefusalText(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.code !== 'conflict') return null;
  if (e.reason === 'license_required') return `${LICENSE_REQUIRED_TEXT} Nada foi alterado.`;
  if (e.reason === 'license_expired') return `${LICENSE_EXPIRED_TEXT} Nada foi alterado.`;
  if (e.reason === 'capacity_pending_limit_reached') return CAPACITY_PENDING_TEXT;
  return null;
}

const dateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/**
 * A validade que a pessoa pediu foi reduzida pelo servidor? Devolve o aviso com a data EFETIVA e o motivo, ou nulo quando a
 * autorização saiu com a validade pedida. A redução nunca fica em silêncio: a autorização não passa do fim da licença da
 * automação (nem atravessa um intervalo sem licença).
 */
export function reducedValidityText(requestedIso: string, effectiveIso: string | null | undefined): string | null {
  if (!effectiveIso) return null;
  const requested = new Date(requestedIso).getTime();
  const effective = new Date(effectiveIso).getTime();
  // um minuto de folga: o servidor guarda o instante com a precisão dele
  if (!Number.isFinite(requested) || !Number.isFinite(effective) || effective >= requested - 60_000) return null;
  return `A autorização vale até ${dateTime(effectiveIso)}, e não até ${dateTime(requestedIso)}, como você pediu. A validade foi reduzida porque a licença desta automação termina nessa data: uma autorização não vai além da licença. Depois que a licença for renovada, autorize de novo para estender.`;
}
