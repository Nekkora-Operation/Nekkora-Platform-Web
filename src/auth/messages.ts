import { ApiError } from '../api/http';

/** Mensagem para o usuário a partir de um erro técnico — nunca inclui payload, token ou detalhe interno. */
export interface UserMessage {
  title: string;
  description?: string;
  /** Correlação segura (X-Request-Id) para erro técnico. */
  requestId?: string;
  /** Erros transitórios: faz sentido tentar de novo. */
  retryable: boolean;
}

function waitText(seconds?: number): string {
  if (!seconds) return 'Aguarde alguns minutos e tente novamente.';
  if (seconds < 60) return `Tente novamente em ${seconds} segundo${seconds === 1 ? '' : 's'}.`;
  const minutes = Math.ceil(seconds / 60);
  return `Tente novamente em ${minutes} minuto${minutes === 1 ? '' : 's'}.`;
}

/** Erros comuns a todas as telas (rede, limite, indisponibilidade, inesperado). */
export function commonMessage(error: unknown): UserMessage {
  if (!(error instanceof ApiError)) {
    return { title: 'Algo deu errado.', description: 'Recarregue a página e tente novamente.', retryable: true };
  }
  switch (error.code) {
    case 'network':
      return { title: 'Não foi possível conectar.', description: 'Verifique sua conexão e tente novamente.', retryable: true };
    case 'rate_limited':
      return { title: 'Muitas tentativas.', description: waitText(error.retryAfterSeconds), retryable: true };
    case 'service_unavailable':
      return {
        title: 'Serviço temporariamente indisponível.',
        description: 'Tente novamente em instantes.',
        retryable: true,
        requestId: error.requestId,
      };
    case 'forbidden':
      return {
        title: 'Não foi possível concluir a solicitação.',
        description: 'Recarregue a página e tente novamente.',
        retryable: true,
        requestId: error.requestId,
      };
    default:
      return {
        title: 'Algo deu errado do nosso lado.',
        description: 'Tente novamente em instantes.',
        retryable: true,
        requestId: error.requestId,
      };
  }
}

/** Credencial incorreta: nunca revela se o e-mail existe, se a conta está ativa ou verificada. */
export const INVALID_CREDENTIALS = 'E-mail ou senha incorretos.';
export const INVALID_CODE = 'Código inválido ou expirado. Confira e tente novamente.';
export const SESSION_EXPIRED = 'Sua sessão expirou. Entre novamente para continuar.';
/** Rota desligada pela chave da API (404): a funcionalidade não está disponível neste ambiente. */
export const UNAVAILABLE = 'Este acesso não está disponível no momento. Se precisar entrar, procure quem administra a sua organização.';
