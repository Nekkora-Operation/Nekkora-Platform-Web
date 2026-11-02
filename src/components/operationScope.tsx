import { createContext, useContext } from 'react';
import { identityCsrf } from '../api/identity';
import { identitySubject } from '../api/pendingOps';

/**
 * Escopo do registro de operações incertas (FRONT-V1-002): quem age e em qual organização. Fora da área interna vale a
 * sessão de identidade; a área interna fornece o vínculo da organização (membershipId).
 */
export interface OperationScopeValue {
  org?: string;
  /** Sujeito para a chave do registro; `null` quando ainda não dá para saber (o envio protegido não começa). */
  subject: () => Promise<string | null>;
}

const identityScope: OperationScopeValue = {
  subject: async () => {
    try {
      return await identitySubject(await identityCsrf());
    } catch {
      return null;
    }
  },
};

const Ctx = createContext<OperationScopeValue>(identityScope);
export const OperationScopeProvider = Ctx.Provider;
export const useOperationScope = () => useContext(Ctx);
