import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Input } from 'nekkora-lib';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/http';
import { createOperationRegistry, setOperationRegistryForTest } from '../api/pendingOps';
import { stepUpMethods } from '../api/stepUpMethod';
import { fakeLocks } from '../test/fakeLocks';
import { OperationScopeProvider } from './operationScope';
import { STEP_UP_NEEDED_TEXT, StepUpDialog } from './StepUpDialog';

/**
 * PLATFORM-V2-001, T01 — confirmação conforme a resposta da API (sessão de organização). Dentro da hora, o ato vai sem
 * pedir o fator; com 403 step_up_required (nada feito), o diálogo pede o código (ou a senha), mantém os campos do ato e
 * envia o ato UMA vez depois da confirmação aceita, sem repetir sozinho. Na sessão de identidade, o fator continua
 * imediatamente antes do ato.
 */
const ORG = '0a6e1f9c-3b2d-4c5e-8f71-2a9b3c4d5e6f';
const required = () => new ApiError('step_up_required', 403);

function Harness(props: { org?: string; stepUp: (c: string) => Promise<void>; action: (value: string) => Promise<string>; onDone?: (r: string) => void; guard?: boolean }) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState('');
  const scope = { org: props.org, subject: async () => 'sujeito-teste' };
  return (
    <OperationScopeProvider value={scope}>
      <button onClick={() => setOpen(true)}>abrir</button>
      <StepUpDialog<string>
        open={open}
        title="Ato sensível"
        confirmLabel="Confirmar ato"
        ready={value.trim().length > 0}
        stepUp={props.stepUp}
        guard={props.guard ? { operation: 'teste.ato', target: 'alvo' } : undefined}
        action={() => props.action(value)}
        onDone={(r) => {
          props.onDone?.(r);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
        refusalText={() => 'Recusado. Nada foi feito.'}
        uncertainText="Resultado desconhecido."
        onUnauthenticated={() => {}}
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

const dialog = () => screen.getByRole('alertdialog', { name: 'Ato sensível' });
const confirmButton = () => within(dialog()).getByRole('button', { name: 'Confirmar ato' });
const codeField = () => within(dialog()).queryByLabelText(/Código do seu aplicativo autenticador/);

describe('confirmação sob demanda na organização (T01)', () => {
  it('dentro da hora: o ato vai sem pedir o fator', async () => {
    const stepUp = vi.fn(async () => {});
    const action = vi.fn(async (v: string) => `ok:${v}`);
    const onDone = vi.fn();
    render(<Harness org={ORG} stepUp={stepUp} action={action} onDone={onDone} />);
    expect(codeField()).toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Campo do ato'), { target: { value: 'A' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('ok:A'));
    expect(stepUp).not.toHaveBeenCalled();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('step_up_required: pede o código, mantém o campo, envia o ato uma vez depois da confirmação (com guarda)', async () => {
    const order: string[] = [];
    let window = false;
    const stepUp = vi.fn(async (c: string) => {
      order.push(`step-up:${c}`);
      window = true;
    });
    const action = vi.fn(async (v: string) => {
      order.push(`ato:${v}`);
      if (!window) throw required();
      return 'feito';
    });
    const onDone = vi.fn();
    render(<Harness org={ORG} stepUp={stepUp} action={action} onDone={onDone} guard />);
    const campo = within(dialog()).getByLabelText('Campo do ato') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Contas a pagar' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton()); // duplo clique: um envio só

    expect(await within(dialog()).findByText(STEP_UP_NEEDED_TEXT)).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    expect(stepUp).not.toHaveBeenCalled();
    expect(campo.value).toBe('Contas a pagar'); // campos do ato preservados
    expect(codeField()).not.toBeNull();
    expect(confirmButton()).toBeDisabled(); // falta o código
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.change(codeField()!, { target: { value: '123456' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('feito'));
    expect(order).toEqual(['ato:Contas a pagar', 'step-up:123456', 'ato:Contas a pagar']);

    // a próxima ação, ainda na hora: sem código
    fireEvent.click(screen.getByRole('button', { name: 'abrir' }));
    await screen.findByRole('alertdialog', { name: 'Ato sensível' });
    expect(codeField()).toBeNull();
  });

  it('confirmação aceita mas o ato ainda pede a prova (relógio na virada): não repete sozinho', async () => {
    const stepUp = vi.fn(async () => {});
    const action = vi.fn(async () => {
      throw required();
    });
    render(<Harness org={ORG} stepUp={stepUp} action={action} />);
    fireEvent.change(within(dialog()).getByLabelText('Campo do ato'), { target: { value: 'X' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await within(dialog()).findByText(STEP_UP_NEEDED_TEXT);
    fireEvent.change(codeField()!, { target: { value: '654321' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText(/A Platform ainda pede a confirmação para este ato\. Nada foi feito\./)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('código recusado: o ato não é reenviado e o campo do ato continua', async () => {
    const stepUp = vi.fn(async () => {
      throw new ApiError('forbidden', 403);
    });
    const action = vi.fn(async () => {
      throw required();
    });
    render(<Harness org={ORG} stepUp={stepUp} action={action} />);
    const campo = within(dialog()).getByLabelText('Campo do ato') as HTMLInputElement;
    fireEvent.change(campo, { target: { value: 'Y' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await within(dialog()).findByText(STEP_UP_NEEDED_TEXT);
    fireEvent.change(codeField()!, { target: { value: '000000' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    expect(await within(dialog()).findByText(/Não foi possível confirmar sua identidade com este código/)).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(1);
    expect(campo.value).toBe('Y');
    expect(codeField()).not.toBeNull();
  });

  it('sessão sem MFA: pede a senha sob demanda', async () => {
    stepUpMethods.set(ORG, 'password');
    let window = false;
    const stepUp = vi.fn(async () => {
      window = true;
    });
    const action = vi.fn(async () => {
      if (!window) throw required();
      return 'ok';
    });
    const onDone = vi.fn();
    render(<Harness org={ORG} stepUp={stepUp} action={action} onDone={onDone} />);
    fireEvent.change(within(dialog()).getByLabelText('Campo do ato'), { target: { value: 'Z' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await within(dialog()).findByText(STEP_UP_NEEDED_TEXT);
    const senha = within(dialog()).getByLabelText(/Sua senha/);
    expect(within(dialog()).getByText(/a senha confirma a sua identidade por uma hora/)).toBeInTheDocument();
    fireEvent.change(senha, { target: { value: 'senha-de-teste' } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('ok'));
    expect(stepUp).toHaveBeenCalledWith('senha-de-teste');
  });

  it('sessão de identidade: inalterada (o fator imediatamente antes do ato)', async () => {
    const stepUp = vi.fn(async () => {});
    const action = vi.fn(async () => 'ok');
    const onDone = vi.fn();
    render(<Harness stepUp={stepUp} action={action} onDone={onDone} />);
    expect(codeField()).not.toBeNull();
    fireEvent.change(within(dialog()).getByLabelText('Campo do ato'), { target: { value: 'W' } });
    expect(confirmButton()).toBeDisabled();
    fireEvent.change(codeField()!, { target: { value: '111111' } });
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(stepUp).toHaveBeenCalledTimes(1);
  });
});
