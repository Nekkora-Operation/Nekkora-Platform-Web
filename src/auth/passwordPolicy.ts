/**
 * Política de senha nova do contrato (PasswordPolicy da API): 12 a 128 caracteres (pontos de código Unicode),
 * sem regras de composição. A verificação local só evita enviar o que é evidentemente inválido; a API decide.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export function passwordLength(password: string): number {
  return Array.from(password).length;
}

export function meetsPasswordPolicy(password: string): boolean {
  const n = passwordLength(password);
  return n >= PASSWORD_MIN && n <= PASSWORD_MAX;
}
