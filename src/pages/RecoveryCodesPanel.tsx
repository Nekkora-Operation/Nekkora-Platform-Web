import { useState } from 'react';
import { Alert, Button, Card } from 'nekkora-lib';
import './RecoveryCodesPanel.css';

/**
 * Exibe os códigos de recuperação recebidos da API (só em memória). Copiar e baixar acontecem localmente;
 * nada vai para log, analytics ou storage.
 */
export function RecoveryCodesPanel({ codes, context }: { codes: string[]; context: string }) {
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setFeedback({ tone: 'success', text: 'Códigos copiados. Cole-os em um local seguro, como um gerenciador de senhas.' });
    } catch {
      setFeedback({ tone: 'warning', text: 'Não foi possível copiar automaticamente. Selecione os códigos e copie manualmente, ou baixe o arquivo.' });
    }
  };

  const download = () => {
    const content = [
      'Nekkora Platform — códigos de recuperação',
      context,
      `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
      '',
      ...codes,
      '',
      'Cada código pode ser usado uma única vez. Guarde este arquivo em local seguro.',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nekkora-codigos-de-recuperacao.txt';
    a.click();
    URL.revokeObjectURL(url);
    setFeedback({ tone: 'success', text: 'Arquivo gerado. Guarde-o em um local seguro.' });
  };

  return (
    <div className="pw-codes">
      <Card variant="outlined" padding="md">
        <ol className="pw-codes__list" aria-label="Códigos de recuperação">
          {codes.map((c) => (
            <li key={c}>
              <code>{c}</code>
            </li>
          ))}
        </ol>
      </Card>
      <div className="pw-codes__actions">
        <Button variant="secondary" leftIcon="copy" onClick={() => void copy()}>
          Copiar códigos
        </Button>
        <Button variant="secondary" leftIcon="download" onClick={download}>
          Baixar como arquivo
        </Button>
      </div>
      {feedback && <Alert tone={feedback.tone}>{feedback.text}</Alert>}
    </div>
  );
}
