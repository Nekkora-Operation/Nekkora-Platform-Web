import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { meetsPasswordPolicy, passwordChecks, passwordProblem } from '../auth/passwordPolicy';
import { loadStrengthChecker } from '../auth/passwordStrength';
import { NewPasswordFields } from './NewPasswordFields';

function Harness() {
  const [v, setV] = useState('');
  const [c, setC] = useState('');
  return <NewPasswordFields label="Senha" confirmLabel="Confirmar senha" value={v} onChange={setV} confirmation={c} onConfirmationChange={setC} userInputs={['Ana Souza']} />;
}

const field = () => screen.getByLabelText(/^Senha\*?$/) as HTMLInputElement;
const req = (id: string) => document.querySelector(`[data-requisito="${id}"]`) as HTMLElement;
const described = (suffix: string) =>
  document.getElementById(
    field()
      .getAttribute('aria-describedby')!
      .split(' ')
      .find((i) => i.endsWith(suffix))!,
  )!;

describe('política de senha (espelho da API)', () => {
  it('cada requisito ausente é apontado sozinho; a válida cumpre todos', () => {
    const casos: [string, string][] = [
      ['Nk#2026ok', 'length'],
      ['Nekkora#2026ok' + 'x'.repeat(115), 'length'], // 129
      ['nekkora#2026ok', 'uppercase'],
      ['NEKKORA#2026OK', 'lowercase'],
      ['Nekkora#Teste!', 'digit'],
      ['Nekkora2026ok7', 'symbol'],
    ];
    for (const [senha, falta] of casos) {
      const c = passwordChecks(senha);
      expect(
        Object.entries(c)
          .filter(([, ok]) => !ok)
          .map(([k]) => k),
        senha,
      ).toEqual([falta]);
      expect(meetsPasswordPolicy(senha)).toBe(false);
    }
    expect(meetsPasswordPolicy('Nekkora#2026ok')).toBe(true);
    expect(passwordProblem('Nekkora#2026ok')).toBeUndefined();
    expect(passwordProblem('nekkora2026ok')).toBe('A senha ainda não atende aos requisitos: uma letra maiúscula; um símbolo (por exemplo ! @ # - _).');
    expect(passwordProblem('')).toBe('Informe a senha.');
  });

  it('conta pontos de código, aceita espaços e Unicode como a API', () => {
    expect(meetsPasswordPolicy('Ab1!' + '😀'.repeat(124))).toBe(true); // 128
    expect(meetsPasswordPolicy('Ab1!' + '😀'.repeat(125))).toBe(false); // 129
    expect(passwordProblem('Ab1!' + 'x'.repeat(125))).toBe('A senha deve ter no máximo 128 caracteres.');
    expect(passwordChecks('Nekkora 2026 ok').symbol).toBe(false); // espaço não é símbolo
    expect(meetsPasswordPolicy(' Nekkora#2026 ')).toBe(true);
    expect(meetsPasswordPolicy('Ação#2026ébom')).toBe(true);
    expect(meetsPasswordPolicy('Nekkora€2026ok')).toBe(true);
  });
});

describe('NewPasswordFields', () => {
  it('requisitos abaixo do campo, atualizados ao digitar, com texto e ícone (não só cor)', async () => {
    render(<Harness />);
    expect(within(described('-requisitos')).getByText('A senha precisa ter:')).toBeInTheDocument();
    for (const id of ['length', 'uppercase', 'lowercase', 'digit', 'symbol']) {
      expect(within(req(id)).getByText('pendente')).toBeInTheDocument();
      expect(req(id).querySelector('svg')).not.toBeNull();
    }
    await userEvent.type(field(), 'abc');
    expect(within(req('lowercase')).getByText('atendido')).toBeInTheDocument();
    expect(within(req('uppercase')).getByText('pendente')).toBeInTheDocument();
    expect(screen.getByText('Faltam 4 requisitos.')).toBeInTheDocument();
    await userEvent.type(field(), 'D#1234567');
    for (const id of ['length', 'uppercase', 'lowercase', 'digit', 'symbol']) expect(within(req(id)).getByText('atendido')).toBeInTheDocument();
    expect(document.querySelector('.pw-password__summary')).toHaveTextContent('Senha atende aos requisitos.');
    expect(screen.getByRole('status')).toHaveTextContent('Senha atende aos requisitos.');
  });

  it('colar e preencher automaticamente: sem maxlength, nada é cortado nem aparado; gerenciadores orientados', async () => {
    render(<Harness />);
    const f = field();
    expect(f).not.toHaveAttribute('maxlength');
    expect(f).toHaveAttribute('autocomplete', 'new-password');
    expect(f.getAttribute('passwordrules')).toContain('maxlength: 128');
    f.focus();
    await userEvent.paste('  Colada#Senha2026-longa  ');
    expect(f.value).toBe('  Colada#Senha2026-longa  ');
    expect(within(req('length')).getByText('atendido')).toBeInTheDocument();
    fireEvent.change(f, { target: { value: 'Preenchida#2026' } }); // preenchimento automático
    expect(f.value).toBe('Preenchida#2026');
    expect(within(req('length')).getByText('atendido')).toBeInTheDocument();
  });

  it('limite de 128 ao digitar: a tecla não entra e aparece o aviso (nos dois campos)', async () => {
    render(<Harness />);
    const base = 'Ab1!'.repeat(31) + 'Ab1'; // 127
    fireEvent.change(field(), { target: { value: base } });
    await userEvent.type(field(), '!X');
    expect(field().value).toBe(base + '!');
    expect(Array.from(field().value)).toHaveLength(128);
    expect(within(field().closest('.nk-field') as HTMLElement).getByText('Limite de 128 caracteres.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Limite de 128 caracteres.');
    await userEvent.type(field(), '{Backspace}');
    expect(within(field().closest('.nk-field') as HTMLElement).queryByText('Limite de 128 caracteres.')).toBeNull();
    const conf = screen.getByLabelText(/^Confirmar senha\*?$/) as HTMLInputElement;
    fireEvent.change(conf, { target: { value: base } });
    await userEvent.type(conf, '!X');
    expect(conf.value).toBe(base + '!');
    expect(within(conf.closest('.nk-field') as HTMLElement).getByText('As senhas não coincidem. Limite de 128 caracteres.')).toBeInTheDocument();
  });

  it('colada ou preenchida acima de 128: nada é cortado, erro visível (nos dois campos) e o envio é recusado', async () => {
    render(<Harness />);
    const longa = 'Ab1!'.repeat(33); // 132
    field().focus();
    await userEvent.paste(longa);
    expect(field().value).toBe(longa);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(within(field().closest('.nk-field') as HTMLElement).getByText('A senha deve ter no máximo 128 caracteres.')).toBeInTheDocument();
    expect(passwordProblem(longa)).toBe('A senha deve ter no máximo 128 caracteres.');
    const conf = screen.getByLabelText(/^Confirmar senha\*?$/) as HTMLInputElement;
    fireEvent.change(conf, { target: { value: longa } }); // preenchimento automático
    expect(conf.value).toBe(longa);
    expect(within(conf.closest('.nk-field') as HTMLElement).getByText('A senha deve ter no máximo 128 caracteres.')).toBeInTheDocument();
    expect(screen.queryByText('As senhas coincidem.')).toBeNull();
  });

  it('mostrar/ocultar a senha', async () => {
    render(<Harness />);
    expect(field()).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getAllByRole('button', { name: 'Mostrar senha' })[0]);
    expect(field()).toHaveAttribute('type', 'text');
    await userEvent.click(screen.getByRole('button', { name: 'Ocultar senha' }));
    expect(field()).toHaveAttribute('type', 'password');
  });

  it('confirmação: diverge quando já tem o tamanho da senha; coincide com aviso em texto', async () => {
    render(<Harness />);
    await userEvent.type(field(), 'Nekkora#2026ok');
    const conf = screen.getByLabelText(/^Confirmar senha\*?$/);
    await userEvent.type(conf, 'Nekkora');
    expect(screen.queryByText('As senhas não coincidem.')).toBeNull(); // ainda digitando
    await userEvent.type(conf, '#2026oX');
    expect(screen.getByText('As senhas não coincidem.')).toBeInTheDocument();
    await userEvent.clear(conf);
    await userEvent.type(conf, 'Nekkora#2026ok');
    expect(screen.getByText('As senhas coincidem.')).toBeInTheDocument();
  });

  it('erro do envio some quando a pessoa corrige (senha e confirmação)', async () => {
    function WithErrors() {
      const [v, setV] = useState('nekkora2026ok');
      const [c, setC] = useState('outra');
      return (
        <NewPasswordFields
          label="Senha"
          confirmLabel="Confirmar senha"
          value={v}
          onChange={setV}
          confirmation={c}
          onConfirmationChange={setC}
          error="A senha ainda não atende aos requisitos: uma letra maiúscula; um símbolo (por exemplo ! @ # - _)."
          confirmationError="As senhas não coincidem."
        />
      );
    }
    render(<WithErrors />);
    expect(screen.getByText(/A senha ainda não atende aos requisitos/)).toBeInTheDocument();
    expect(screen.getByText('As senhas não coincidem.')).toBeInTheDocument();
    await userEvent.clear(field());
    await userEvent.type(field(), 'Nekkora#2026ok');
    expect(screen.queryByText(/A senha ainda não atende aos requisitos/)).toBeNull();
    expect(field()).not.toHaveAttribute('aria-invalid');
    const conf = screen.getByLabelText(/^Confirmar senha\*?$/);
    await userEvent.clear(conf);
    await userEvent.type(conf, 'Nekkora#2026ok');
    expect(screen.queryByText('As senhas não coincidem.')).toBeNull();
    expect(screen.getByText('As senhas coincidem.')).toBeInTheDocument();
  });

  it('força estimada separada: cumprir as regras não faz a senha aparecer como forte', async () => {
    const check = await loadStrengthChecker();
    // cumpre as cinco regras e é das primeiras a serem tentadas
    expect(Array.from('Password@12345')).toHaveLength(14);
    expect(check('Password@12345', []).level).toBeLessThanOrEqual(1);
    render(<Harness />);
    await userEvent.type(field(), 'Password@12345');
    expect(document.querySelector('.pw-password__summary')).toHaveTextContent('Senha atende aos requisitos.');
    const forca = described('-forca');
    await waitFor(() => expect(forca).toHaveTextContent(/Força estimada: (muito fraca|fraca)/));
    expect(forca).not.toHaveTextContent('Força estimada: forte');
    expect(forca).toHaveTextContent('Atende aos requisitos, mas é fácil de adivinhar.');
    expect(forca).toHaveTextContent('Isso é semelhante a uma senha comumente usada.');
    await act(async () => {
      await userEvent.clear(field());
      await userEvent.type(field(), 'Qv7#mZp2!xLr9wTe');
    });
    await waitFor(() => expect(forca).toHaveTextContent('Força estimada: forte'));
  });

  it('dados da pessoa entram na estimativa', async () => {
    const check = await loadStrengthChecker();
    expect(check('AnaSouza#2026', ['Ana Souza', 'anasouza']).level).toBeLessThanOrEqual(check('AnaSouza#2026', []).level);
  });
});
