/**
 * Query string no formato do contrato: listas repetem o parâmetro (`status=a&status=b`, style form + explode);
 * valores ausentes, nulos ou vazios não são enviados. Datas vão em ISO-8601 COM fuso (a API recusa sem fuso).
 */
export type QueryValue = string | number | boolean | Date | null | undefined | readonly (string | number)[];

export function queryString(params: Record<string, QueryValue> = {}): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) q.append(key, String(v));
    } else if (value instanceof Date) {
      q.append(key, value.toISOString());
    } else {
      q.append(key, String(value));
    }
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
