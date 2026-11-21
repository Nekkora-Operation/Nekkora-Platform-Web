/**
 * Política de senha nova (PasswordPolicy da API, PLATFORM-SENHA-001): de 12 a 128 caracteres (pontos de código Unicode), com
 * ao menos uma letra maiúscula, uma minúscula, um número e um símbolo. Vale onde uma senha é criada ou substituída (cadastro,
 * inclusive o primeiro acesso pelo convite de cliente; troca; recuperação). O login NÃO aplica a política: as senhas
 * existentes continuam valendo.
 *
 * As classes são as mesmas da API (categorias gerais do Unicode): maiúscula = \p{Lu}; minúscula = \p{Ll}; número = \p{Nd};
 * símbolo = pontuação ou símbolo (\p{P} ou \p{S}). Espaço é permitido, mas não conta como símbolo. Nada é cortado nem
 * aparado: a senha vai à API exatamente como foi digitada, colada ou preenchida. A conferência local só orienta; a API decide.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Ao digitar no limite (a tecla não entra). */
export const PASSWORD_LIMIT_NOTICE = `Limite de ${PASSWORD_MAX} caracteres.`;
/** Colada ou preenchida acima do limite: nada é cortado; o envio fica bloqueado até corrigir. */
export const PASSWORD_TOO_LONG = `A senha deve ter no máximo ${PASSWORD_MAX} caracteres.`;

export type PasswordRequirement = 'length' | 'uppercase' | 'lowercase' | 'digit' | 'symbol';

/** Na ordem em que a tela os mostra. */
export const PASSWORD_REQUIREMENTS: readonly { id: PasswordRequirement; label: string }[] = [
  { id: 'length', label: `Entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres` },
  { id: 'uppercase', label: 'Uma letra maiúscula' },
  { id: 'lowercase', label: 'Uma letra minúscula' },
  { id: 'digit', label: 'Um número' },
  { id: 'symbol', label: 'Um símbolo (por exemplo ! @ # - _)' },
];

/**
 * Regra da senha para gerenciadores que a leem ao sugerir uma senha (atributo `passwordrules`). O comprimento máximo NÃO vai
 * em `maxlength`: o navegador cortaria em silêncio o que fosse colado ou preenchido além dele. A digitação no limite é barrada
 * pelo campo (beforeinput); colar ou preencher acima dele mostra PASSWORD_TOO_LONG e bloqueia o envio.
 */
export const PASSWORD_RULES_ATTRIBUTE = `minlength: ${PASSWORD_MIN}; maxlength: ${PASSWORD_MAX}; required: upper; required: lower; required: digit; required: [-!#$%&*+.@_?];`;

export function passwordLength(password: string): number {
  return Array.from(password).length;
}

const UPPER = /\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const DIGIT = /\p{Nd}/u;
const SYMBOL = /[\p{P}\p{S}]/u;

/** O que a senha cumpre, requisito a requisito. */
export function passwordChecks(password: string): Record<PasswordRequirement, boolean> {
  const n = passwordLength(password);
  return {
    length: n >= PASSWORD_MIN && n <= PASSWORD_MAX,
    uppercase: UPPER.test(password),
    lowercase: LOWER.test(password),
    digit: DIGIT.test(password),
    symbol: SYMBOL.test(password),
  };
}

export function meetsPasswordPolicy(password: string): boolean {
  return Object.values(passwordChecks(password)).every(Boolean);
}

/** Mensagem de erro do campo (envio), dizendo o que falta. */
export function passwordProblem(password: string): string | undefined {
  if (!password) return 'Informe a senha.';
  if (passwordLength(password) > PASSWORD_MAX) return PASSWORD_TOO_LONG;
  const checks = passwordChecks(password);
  const missing = PASSWORD_REQUIREMENTS.filter((r) => !checks[r.id]).map((r) => r.label.toLowerCase());
  if (missing.length === 0) return undefined;
  return `A senha ainda não atende aos requisitos: ${missing.join('; ')}.`;
}
