/**
 * Cadastro recém-concluído NESTA aba (só memória, nunca storage): a primeira entrada sem autenticação em duas etapas
 * logo depois do cadastro mostra "Proteja sua conta" antes das organizações. Consumido uma vez; recarregar a página o
 * perde (a ativação continua sempre disponível em Segurança da conta).
 */
let signupCompleted = false;

export const onboarding = {
  markSignupCompleted: () => {
    signupCompleted = true;
  },
  /** Devolve e esquece. */
  takeSignupCompleted: (): boolean => {
    const v = signupCompleted;
    signupCompleted = false;
    return v;
  },
};
