import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Input } from 'nekkora-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';
import { stepUpMethods } from '../api/stepUpMethod';
import { fakeLocks } from '../test/fakeLocks';
import { OperationScopeProvider } from './operationScope';
import { StepUpDialog } from './StepUpDialog';

/**
 * A1 (LICENCIAMENTO-002) — o diálogo de ato sensível diante do limite de pedidos (429) e do resultado incerto:
 * - 429 (na confirmação ou no ato) é recusa: nada foi feito; o diálogo mantém os campos, diz quando dá para tentar de novo
 *   pelo Retry-After e só libera o botão depois desse tempo; nada é reenviado sozinho;
 * - resultado incerto: o estado atual é consultado (só leitura) antes de oferecer nova tentativa; em vigor = concluído;
 *   ausente = a pessoa libera; leitura que falha = "Conferir de novo", sem liberar sozinho.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const limited = (s?: number) => new ApiError('rate_limited', 429, s);

function Harness(props: {
  action: (value: string) => Promise<string>;
  onDone?: (r: string) => void;
  verify?: () => Promise<boolean>;
  onVerified?: () => void;
  stepUp?: (c: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('');
  const scope = { org: ORG, subject: async () => 'sujeito-teste' };
  return (
    <OperationScopeProvider value={scope}>
      <StepUpDialog<string>
        open={open}
        title="Ato sensível"
        confirmLabel="Confirmar ato"
        ready={value.trim().length > 0}
        stepUp={props.stepUp}
        guard={{ operation: 'teste.ato', target: 'alvo' }}
        action={() => props.action(value)}
        onDone={(r) => {
          props.onDone?.(r);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        refusalText={() => 'Recusado. Nada foi feito.'}
        uncertainText="Resultado desconhecido."
        onUnauthenticated={() => {}}
        verify={props.verify}
        onVerified={() => {
          props.onVerified?.();
          setOpen(false);
        }}
      >
        <Input label="Campo do ato" value={value} onChange={(e) => setValue(e.target.value)} />
      </StepUpDialog>
    </OperationScopeProvider>
  );
}

beforeEach(() => {
  stepUpMethods.clear();
  localStorage.clear();
  const locks = fakeLocks();
  setOperationRegistryForTest(createOperationRegistry({ storage: () => localStorage, locks: () => locks, now: () => Date.now() }));
});
afterEach(() => {
  vi.useRealTimers();
});

const dialog = () => screen.getByRole('alertdialog', { name: 'Ato sensível' });
const field = () => within(dialog()).getByLabelText('Campo do ato') as HTMLInputElement;

async function fillAndConfirm(value = 'Contas a pagar') {
  fireEvent.change(field(), { target: { value } });
  const b = await within(dialog()).findByRole('button', { name: 'Confirmar ato' });
  await waitFor(() => expect(b).toBeEnabled());
  fireEvent.click(b);
}

describe('429 no ato (A1)', () => {
  it('mostra o tempo do Retry-After, mantém o campo, segura o botão até o tempo passar e não reenvia sozinho', async () => {
    let calls = 0;
    const action = vi.fn(async () => {
      calls++;
      if (calls === 1) throw limited(3);
      return 'feito';
    });
    const onDone = vi.fn();
    render(<Harness action={action} onDone={onDone} />);
    await fillAndConfirm();

    expect(await within(dialog()).findByText(/Muitas tentativas em pouco tempo\. Nada foi feito\. Você poderá tentar de novo em 3 segundos/)).toBeInTheDocument();
    expect(field().value).toBe('Contas a pagar');
    const waiting = within(dialog()).getByRole('button', { name: /^Tentar de novo em \d s$/ });
    expect(waiting).toBeDisabled();
    fireEvent.click(waiting);
    expect(action).toHaveBeenCalledTimes(1);

    // depois do tempo informado, o botão volta (sem reenviar nada sozinho)
    const back = await within(dialog()).findByRole('button', { name: 'Confirmar ato' }, { timeout: 5_000 });
    expect(back).toBeEnabled();
    expect(action).toHaveBeenCalledTimes(1);
    fireEvent.click(back);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('feito'));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('sem Retry-After (limite do gateway): pede para aguardar, sem inventar um tempo', async () => {
    const action = vi.fn(async () => {
      throw limited();
    });
    render(<Harness action={action} />);
    await fillAndConfirm();
    expect(await within(dialog()).findByText(/Muitas tentativas em pouco tempo\. Nada foi feito\. Aguarde alguns segundos/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Confirmar ato' })).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('429 na confirmação de identidade: mesmo tratamento; o ato não é enviado', async () => {
    let asked = false;
    const action = vi.fn(async () => {
      if (!asked) {
        asked = true;
        throw new ApiError('forbidden', 403, undefined, undefined, 'step_up_required');
      }
      return 'feito';
    });
    const stepUp = vi.fn(async () => {
      throw limited(2);
    });
    render(<Harness action={action} stepUp={stepUp} />);
    await fillAndConfirm();
    const code = await within(dialog()).findByLabelText(/Código do seu aplicativo autenticador/);
    fireEvent.change(code, { target: { value: '123456' } });
    const b = within(dialog()).getByRole('button', { name: 'Confirmar ato' });
    await waitFor(() => expect(b).toBeEnabled());
    fireEvent.click(b);
    expect(await within(dialog()).findByText(/Você poderá tentar de novo em 2 segundos/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: /^Tentar de novo em \d s$/ })).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1); // só a primeira, que pediu a confirmação
    expect(field().value).toBe('Contas a pagar');
  });
});

describe('resultado incerto com consulta do estado (A1)', () => {
  const network = () => new ApiError('network', 0);

  it('a leitura mostra o ato em vigor: concluído, sem nova tentativa', async () => {
    const action = vi.fn(async () => {
      throw network();
    });
    const verify = vi.fn(async () => true);
    const onVerified = vi.fn();
    render(<Harness action={action} verify={verify} onVerified={onVerified} />);
    await fillAndConfirm();
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    // o registro da incerteza foi encerrado: nenhuma chave nk.op.* em "unknown"
    expect(Object.keys(localStorage).filter((k) => k.startsWith('nk.op.') && localStorage.getItem(k)?.includes('"unknown"'))).toEqual([]);
  });

  it('a leitura não mostra o ato: informa e só a pessoa libera a nova tentativa', async () => {
    let calls = 0;
    const action = vi.fn(async () => {
      calls++;
      if (calls === 1) throw network();
      return 'feito';
    });
    const verify = vi.fn(async () => false);
    const onDone = vi.fn();
    render(<Harness action={action} verify={verify} onDone={onDone} />);
    await fillAndConfirm();
    expect(await within(dialog()).findByText(/Conferido agora: a Platform não mostra este ato em vigor/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Confirmar ato' })).toBeDisabled();
    expect(action).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Liberar nova tentativa' }));
    const b = within(dialog()).getByRole('button', { name: 'Confirmar ato' });
    await waitFor(() => expect(b).toBeEnabled());
    expect(field().value).toBe('Contas a pagar');
    fireEvent.click(b);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('feito'));
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('a leitura falha: "Conferir de novo", sem liberar sozinho', async () => {
    const action = vi.fn(async () => {
      throw network();
    });
    let reads = 0;
    const verify = vi.fn(async () => {
      reads++;
      if (reads === 1) throw limited(1);
      return true;
    });
    const onVerified = vi.fn();
    render(<Harness action={action} verify={verify} onVerified={onVerified} />);
    await fillAndConfirm();
    expect(await within(dialog()).findByText(/Não foi possível conferir o estado atual agora/)).toBeInTheDocument();
    expect(within(dialog()).getByRole('button', { name: 'Confirmar ato' })).toBeDisabled();
    expect(within(dialog()).queryByRole('button', { name: 'Liberar nova tentativa' })).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Conferir de novo' }));
    });
    await waitFor(() => expect(onVerified).toHaveBeenCalledTimes(1));
    expect(action).toHaveBeenCalledTimes(1);
  });
});
