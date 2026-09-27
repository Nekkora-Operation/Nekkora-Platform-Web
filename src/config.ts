/** Configuração do frontend. Nada aqui é segredo nem regra de segurança. */

export const config = {
  /** Destino de "Voltar para Nekkora" quando a organização não pode ser identificada. */
  siteUrl: import.meta.env.VITE_NEKKORA_SITE_URL ?? 'https://nekkora.com',
};

/**
 * Funcionalidades que dependem de contrato ainda inexistente na API. Desligadas: a interface não inventa
 * comportamento (gate de integração, §50). Ver docs/DIVERGENCIAS.md.
 */
export const features = {
  /** D2 — a API v1 não tem rota de reenvio de verificação de e-mail. */
  resendVerification: import.meta.env.VITE_FEATURE_RESEND_VERIFICATION === 'true',
};
