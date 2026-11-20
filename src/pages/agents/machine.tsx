import { Badge, Text } from 'nekkora-lib';
import { DateTimeText } from '../product/shared';

/**
 * PLATFORM-FLUXO-002 — a MÁQUINA como a pessoa a reconhece. Na interface, "máquina" é o que o contrato chama de Worker: o
 * nome amigável que a pessoa cadastrou. O computador onde o Agent está instalado fica vinculado a uma máquina por vez; o
 * nome dele é o informado na vinculação (a Platform não coleta o nome real do computador). Identificadores, rotas e
 * campos do contrato continuam workerId, /workers etc. Cadastrar ou conectar uma máquina não consome licença: a licença é
 * da automação.
 */
export type MachineState = 'REGISTERED' | 'AWAITING_CONNECTION' | 'CONNECTED' | 'NO_CONTACT' | 'LINK_SUSPENDED' | 'INACTIVE';

export const MACHINE_STATE: Record<MachineState, { label: string; tone: 'success' | 'warning' | 'neutral' | 'info'; text: string }> = {
  REGISTERED: { label: 'Cadastrada', tone: 'neutral', text: 'Ainda sem computador vinculado.' },
  AWAITING_CONNECTION: {
    label: 'Aguardando conexão',
    tone: 'info',
    text: 'O código de vinculação foi gerado ou o computador foi vinculado, mas ainda não fez contato.',
  },
  CONNECTED: { label: 'Conectada', tone: 'success', text: 'O computador fez contato com a Platform nos últimos 3 minutos.' },
  NO_CONTACT: {
    label: 'Sem contato',
    tone: 'warning',
    text: 'Vinculada, mas sem contato recente. Não quer dizer que foi desligada ou desvinculada.',
  },
  LINK_SUSPENDED: { label: 'Vínculo suspenso', tone: 'warning', text: 'O vínculo do computador está suspenso.' },
  INACTIVE: { label: 'Desativada', tone: 'neutral', text: 'A máquina foi desativada.' },
};

/** O selo do estado da máquina, com o último contato quando há. */
export function MachineStateBadge({ state, lastContactAt }: { state?: MachineState | null; lastContactAt?: string | null }) {
  if (!state) return null;
  const s = MACHINE_STATE[state];
  return (
    <span className="pw-machine-state">
      <Badge tone={s.tone} dot>
        {s.label}
      </Badge>
      {state === 'NO_CONTACT' && lastContactAt && (
        <Text as="span" variant="body-sm" color="secondary">
          {' '}
          último contato <DateTimeText iso={lastContactAt} />
        </Text>
      )}
    </span>
  );
}

/** "Nome amigável (computador NOTE-01)": o computador só aparece quando há um vinculado e com nome diferente. */
export function machineName(name: string | null | undefined, computerName?: string | null): string {
  const n = name ?? 'Máquina sem nome';
  return computerName && computerName !== n ? `${n} (computador ${computerName})` : n;
}

export const LICENSE_NOT_CONSUMED = 'Cadastrar ou conectar uma máquina não consome licença: a licença é da automação.';
