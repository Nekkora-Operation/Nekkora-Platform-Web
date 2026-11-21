import { useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { Icon, Input } from 'nekkora-lib';
import { PASSWORD_REQUIREMENTS, PASSWORD_RULES_ATTRIBUTE, passwordChecks, passwordLength } from '../auth/passwordPolicy';
import { loadStrengthChecker, type PasswordStrength } from '../auth/passwordStrength';
import './newPassword.css';

type Checker = Awaited<ReturnType<typeof loadStrengthChecker>>;

/** Só a parte inicial entra na estimativa (custo da biblioteca); a senha em si nunca é alterada. */
const STRENGTH_SAMPLE = 64;

/**
 * Senha nova + confirmação (PLATFORM-SENHA-001), igual nas telas de cadastro (inclusive o primeiro acesso pelo convite de
 * cliente), troca e recuperação:
 * - os requisitos ficam abaixo do campo e acompanham a digitação; cada um diz em TEXTO e com ícone de FORMA própria se está
 *   atendido (nunca só pela cor) e o campo os anuncia pelo aria-describedby;
 * - "Senha atende aos requisitos" é separado da FORÇA ESTIMADA (zxcvbn-ts, só indicação): cumprir as regras não basta para a
 *   senha aparecer como forte;
 * - mostrar/ocultar (botão do Input da Nekkora-Lib); colar, preenchimento automático e gerenciadores liberados (sem
 *   `maxlength`, que cortaria em silêncio; `passwordrules` orienta quem gera senhas); nada é aparado.
 * A tela faz a conferência final no envio e mostra os erros que receber (`error`, `confirmationError`).
 */
export function NewPasswordFields({
  label,
  confirmLabel,
  value,
  onChange,
  confirmation,
  onConfirmationChange,
  error,
  confirmationError,
  readOnly,
  autoFocus,
  name = 'new-password',
  userInputs = [],
}: {
  label: string;
  confirmLabel: string;
  value: string;
  onChange: (v: string) => void;
  confirmation: string;
  onConfirmationChange: (v: string) => void;
  error?: string;
  confirmationError?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  name?: string;
  /** Dados da pessoa (e-mail, nome) que tornam a senha previsível. */
  userInputs?: string[];
}) {
  const id = useId().replace(/:/g, '');
  const pwId = `senha-${id}`;
  const checks = passwordChecks(value);
  const allMet = Object.values(checks).every(Boolean);
  const missingCount = Object.values(checks).filter((v) => !v).length;

  const [checker, setChecker] = useState<Checker | null | 'indisponivel'>(null);
  useEffect(() => {
    let alive = true;
    loadStrengthChecker().then(
      (c) => alive && setChecker(() => c),
      () => alive && setChecker('indisponivel'),
    );
    return () => {
      alive = false;
    };
  }, []);
  const deferred = useDeferredValue(value);
  const inputsKey = userInputs.join('\n');
  const strength: PasswordStrength | null = useMemo(() => {
    if (!deferred || typeof checker !== 'function') return null;
    const sample = Array.from(deferred).slice(0, STRENGTH_SAMPLE).join('');
    return checker(sample, ['nekkora', 'platform', ...inputsKey.split('\n').filter(Boolean)]);
  }, [deferred, checker, inputsKey]);

  // anúncio só na MUDANÇA (passou a atender / deixou de atender), não a cada tecla
  const [announce, setAnnounce] = useState('');
  const [wasMet, setWasMet] = useState(false);
  if (allMet !== wasMet) {
    setWasMet(allMet);
    setAnnounce(allMet ? 'Senha atende aos requisitos.' : value ? 'A senha deixou de atender aos requisitos.' : '');
  }

  const typedConfirmation = confirmation.length > 0;
  const mismatchNow = typedConfirmation && confirmation !== value && passwordLength(confirmation) >= passwordLength(value);
  const confirmError = confirmationError ?? (mismatchNow ? 'As senhas não coincidem.' : undefined);
  const describedBy = [error ? `${pwId}-message` : null, `${pwId}-requisitos`, `${pwId}-forca`].filter(Boolean).join(' ');

  return (
    <>
      <div className="pw-password">
        <Input
          id={pwId}
          label={label}
          type="password"
          name={name}
          autoComplete="new-password"
          required
          fullWidth
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          error={error}
          readOnly={readOnly}
          aria-describedby={describedBy}
          {...{ passwordrules: PASSWORD_RULES_ATTRIBUTE }}
        />
        <div id={`${pwId}-requisitos`} className="pw-password__panel">
          <p className="pw-password__title">A senha precisa ter:</p>
          <ul className="pw-password__reqs">
            {PASSWORD_REQUIREMENTS.map((r) => {
              const met = checks[r.id];
              return (
                <li key={r.id} className={`pw-password__req${met ? ' pw-password__req--met' : ''}`} data-requisito={r.id} data-atendido={met}>
                  <Icon name={met ? 'check-circle' : 'x-circle'} size={16} className="pw-password__icon" />
                  <span className="pw-password__label">{r.label}</span>
                  <span className="pw-password__state">{met ? 'atendido' : 'pendente'}</span>
                </li>
              );
            })}
          </ul>
          <p className={`pw-password__summary${allMet ? ' pw-password__summary--met' : ''}`}>
            {allMet ? (
              <>
                <Icon name="check" size={16} /> Senha atende aos requisitos.
              </>
            ) : value ? (
              missingCount === 1 ? 'Falta 1 requisito.' : `Faltam ${missingCount} requisitos.`
            ) : (
              'Nenhum requisito atendido ainda.'
            )}
          </p>
        </div>
        <div id={`${pwId}-forca`} className="pw-password__strength" data-nivel={strength?.level ?? ''}>
          <p className="pw-password__strength-text">
            Força estimada:{' '}
            <strong>{!value ? 'aparece ao digitar' : strength ? strength.label : checker === 'indisponivel' ? 'indisponível' : 'calculando…'}</strong>
          </p>
          <span className="pw-password__meter" aria-hidden="true">
            {[1, 2, 3, 4].map((i) => (
              <span key={i} className={`pw-password__bar${strength && strength.level >= i ? ' pw-password__bar--on' : ''}`} />
            ))}
          </span>
          {strength?.warning && <p className="pw-password__hint">{strength.warning}</p>}
          {allMet && strength && strength.level <= 2 && (
            <p className="pw-password__hint">Atende aos requisitos, mas é fácil de adivinhar. Evite nomes, datas e palavras conhecidas.</p>
          )}
          <p className="pw-password__note">A força é uma estimativa e não é exigida; os requisitos acima são.</p>
        </div>
        <span role="status" className="nk-visually-hidden">
          {announce}
        </span>
      </div>
      <Input
        label={confirmLabel}
        type="password"
        name="confirm-password"
        autoComplete="new-password"
        required
        fullWidth
        value={confirmation}
        onChange={(e) => onConfirmationChange(e.target.value)}
        error={confirmError}
        success={!confirmError && typedConfirmation && confirmation === value ? 'As senhas coincidem.' : undefined}
        readOnly={readOnly}
      />
    </>
  );
}
