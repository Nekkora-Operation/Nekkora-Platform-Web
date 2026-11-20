/**
 * PLATFORM-FLUXO-002 — acompanhamento unificado (Execuções: "Em andamento" e "Histórico") e atividade por máquina. Uma linha
 * por execução, com as mesmas origens e situações do resumo do Início: nada é contado em dobro. Só leitura.
 */
import { readJson } from './validate';
import { queryString } from './query';
import type { components, operations } from './generated/nekkora-api-v1';

type S = components['schemas'];
export type ActivityItem = S['ActivityItem'];
export type ActivityPage = S['ActivityPage'];
export type ActivityOutcome = ActivityItem['outcome'];
export type MachineActivity = S['MachineActivityList']['items'][number];
export type ActivityQuery = NonNullable<operations['listActivity']['parameters']['query']>;

const base = (org: string) => `/api/v1/o/${encodeURIComponent(org)}`;

export function listActivity(org: string, q: ActivityQuery): Promise<ActivityPage> {
  return readJson<ActivityPage>('listActivity', `${base(org)}/activity${queryString(q)}`);
}

export function listMachineActivity(org: string): Promise<S['MachineActivityList']> {
  return readJson<S['MachineActivityList']>('listMachineActivity', `${base(org)}/activity/machines`);
}
