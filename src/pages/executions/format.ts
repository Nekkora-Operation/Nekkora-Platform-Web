import type { ExecutionStatus } from '../../api/v1';

/** Rótulos em português dos estados do contrato (ExecutionStatus). */
export const STATUS_LABEL: Record<ExecutionStatus, string> = {
  pending: 'Na fila',
  starting: 'Iniciando',
  running: 'Em execução',
  succeeded: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

export const STATUS_ORDER: ExecutionStatus[] = ['pending', 'starting', 'running', 'succeeded', 'failed', 'cancelled'];

export const STATUS_TONE: Record<ExecutionStatus, 'neutral' | 'info' | 'success' | 'danger' | 'warning'> = {
  pending: 'neutral',
  starting: 'info',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'warning',
};

/** Motivos do contrato (ExecutionStatusReason); `process_completed` não precisa de texto extra. */
export const REASON_LABEL: Record<string, string> = {
  start_failed: 'falha ao iniciar',
  process_failed: 'o processo falhou',
  cancelled_before_dispatch: 'cancelada antes do envio',
  cancel_confirmed: 'cancelamento confirmado',
  queue_deadline_exceeded: 'prazo da fila esgotado',
};

export const ORIGIN_LABEL = { manual: 'Manual', scheduled: 'Agendada' } as const;

/** Deslocamento de fuso de um instante, no formato "UTC−03:00" (sinal tipográfico de menos). */
export function offsetLabel(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Fuso do navegador (nome IANA, quando disponível). */
export function timeZoneName(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

const dateTimeFormat = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const AS_RECEIVED = /^(\d{4})-(\d{2})-(\d{2})[Tt\s](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?([Zz]|[+-]\d{2}(?::?\d{2})?)$/;

/** Fuso escrito no próprio texto ("Z", "-03:00", "+0530"…) → "UTC±hh:mm". */
function receivedOffset(tz: string): string {
  if (tz === 'Z' || tz === 'z') return 'UTC+00:00';
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz)!;
  return `UTC${m[1] === '-' ? '−' : '+'}${m[2]}:${m[3] ?? '00'}`;
}

/**
 * Data e hora no fuso do navegador + o deslocamento daquele instante (pode mudar com horário de verão).
 *
 * Datas que o contrato aceita mas o `Date` não representa (ex.: segundo bissexto 2016-12-31T23:59:60Z, válido pela
 * RFC 3339 e pelo validador) NÃO são convertidas nem trocadas por outro instante: aparecem como recebidas, com o fuso do
 * próprio texto, e `asReceived` = true (a tela avisa). Nunca lança.
 */
export function formatDateTime(iso: string): { text: string; offset: string; asReceived: boolean } {
  const d = new Date(iso);
  if (!Number.isNaN(d.getTime())) return { text: dateTimeFormat.format(d), offset: offsetLabel(d), asReceived: false };
  const m = AS_RECEIVED.exec(iso);
  if (!m) return { text: iso, offset: '', asReceived: true };
  const [, y, mo, da, h, mi, se, tz] = m;
  return { text: `${da}/${mo}/${y}, ${h}:${mi}:${se}`, offset: receivedOffset(tz), asReceived: true };
}

/** Duração legível a partir de milissegundos inteiros (o contrato não calcula contra o relógio atual). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

// ------------------------------------------------------------------ período

export type PeriodPreset = '24h' | '7d' | '30d' | '90d' | 'all' | 'custom';

/** Padrão PROPOSTO para revisão (decisão de interface, não de desempenho): últimos 30 dias, visível e editável. */
export const DEFAULT_PERIOD: PeriodPreset = '30d';

export const PERIOD_LABEL: Record<PeriodPreset, string> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  all: 'Todo o histórico visível',
  custom: 'Personalizado',
};

const PRESET_MS: Partial<Record<PeriodPreset, number>> = {
  '24h': 24 * 3600_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
};

/** Máximo do contrato entre `from` e `to` (366 × 24 h exatos). */
export const MAX_PERIOD_MS = 366 * 86_400_000;

/**
 * Limites enviados à API: instantes ISO 8601 em UTC (`Z`), sem ambiguidade de fuso. `from` é inclusivo e `to`
 * exclusivo ([from, to)). Os períodos prontos só têm `from` (calculado no momento em que o filtro é aplicado).
 */
export function presetFrom(preset: PeriodPreset, now: number): string | undefined {
  const ms = PRESET_MS[preset];
  return ms === undefined ? undefined : new Date(now - ms).toISOString();
}

/**
 * Inverso de `presetFrom`: o momento de aplicação que gera exatamente `fromIso` (para reabrir a lista pela URL com o
 * MESMO início, sem recalcular). Undefined se o período não for relativo ou a data for inválida.
 */
export function presetAppliedAt(preset: PeriodPreset, fromIso: string): number | undefined {
  const ms = PRESET_MS[preset];
  const t = Date.parse(fromIso);
  return ms === undefined || Number.isNaN(t) ? undefined : t + ms;
}

export const PERIOD_PRESETS = Object.keys(PERIOD_LABEL) as PeriodPreset[];

/** Valor de <input type="datetime-local"> (hora local do navegador) → instante ISO em UTC. */
export function localInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const d = new Date(value); // sem fuso no texto → interpretado como hora local, como o campo mostra
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Instante → valor de <input type="datetime-local"> na hora local. */
export function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Erro de um período personalizado (antes de enviar); null = válido. */
export function customRangeError(from: string | undefined, to: string | undefined): string | null {
  if (!from && !to) return 'Informe pelo menos o início ou o fim do período.';
  if (from && to) {
    const span = Date.parse(to) - Date.parse(from);
    if (span <= 0) return 'O fim do período precisa ser depois do início.';
    if (span > MAX_PERIOD_MS) return 'O período pode ter no máximo 366 dias.';
  }
  return null;
}
