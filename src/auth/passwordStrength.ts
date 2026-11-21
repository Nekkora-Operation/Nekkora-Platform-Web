/**
 * Força ESTIMADA da senha (zxcvbn-ts, com os dicionários comum e pt-br). É só uma indicação, separada dos requisitos: cumprir
 * as regras não torna a senha "forte" (ex.: "Password@12345", com 14 caracteres, cumpre as cinco regras e é das primeiras a serem tentadas). A biblioteca
 * e os dicionários (algumas centenas de KB) são carregados sob demanda, só nas telas que definem senha; a senha nunca sai do
 * navegador por aqui.
 */
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

export type PasswordStrength = {
  level: StrengthLevel;
  /** Rótulo curto (sempre em texto; a barra é só reforço visual). */
  label: string;
  /** Aviso da estimativa, em português, quando houver (ex.: "Esta é uma senha muito comum."). */
  warning?: string;
};

export const STRENGTH_LABELS: Record<StrengthLevel, string> = {
  0: 'muito fraca',
  1: 'fraca',
  2: 'razoável',
  3: 'boa',
  4: 'forte',
};

type Checker = (password: string, userInputs: string[]) => PasswordStrength;

let loading: Promise<Checker> | null = null;

/** Carrega (uma vez) o estimador. Em falha de carga, a tela segue só com os requisitos. */
export function loadStrengthChecker(): Promise<Checker> {
  loading ??= Promise.all([import('@zxcvbn-ts/core'), import('@zxcvbn-ts/language-common'), import('@zxcvbn-ts/language-pt-br')]).then(
    ([core, common, ptBr]) => {
      const factory = new core.ZxcvbnFactory({
        translations: ptBr.translations,
        graphs: common.adjacencyGraphs,
        dictionary: { ...common.dictionary, ...ptBr.dictionary },
      });
      return (password, userInputs) => {
        const r = factory.check(password, userInputs);
        const level = r.score as StrengthLevel;
        return { level, label: STRENGTH_LABELS[level], warning: r.feedback.warning || undefined };
      };
    },
  );
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
