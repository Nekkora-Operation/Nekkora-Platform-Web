import { Alert, Text } from 'nekkora-lib';
import type { UserMessage } from '../auth/messages';

/** Erro técnico/temporário, com correlação segura discreta quando a API fornece. */
export function ErrorAlert({ message }: { message: UserMessage }) {
  return (
    <Alert tone="danger" title={message.title}>
      {message.description}
      {message.requestId && (
        <Text as="span" variant="caption" color="muted" style={{ display: 'block', marginTop: 4 }}>
          Código de referência: <code>{message.requestId}</code>
        </Text>
      )}
    </Alert>
  );
}
