import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, RadioGroup, Stack, Text, Textarea } from 'nekkora-lib';
import {
  approveClientGrant,
  createClientGrant,
  requestClientGrantRenewal,
  reviewClientGrant,
} from '../../api/access';
import type { ClientGrant } from '../../api/v1';
import { StepUpDialog } from '../../components/StepUpDialog';
import { DateTimeText } from '../product/shared';
import { accessRefusal, orgStepUp } from './shared';

export type GrantDecision = 'approve' | 'renew' | 'review' | 'request-again';

/**
 * Ações de decisão por situação (além de revogar, que já existia). A API decide; a tela só oferece o que cabe.
 * Aprovar a RENOVAÇÃO não é oferecido (FRONT-V1-002, D-API-02): nenhuma leitura do contrato mostra o pedido pendente
 * (valores e solicitante) a quem aprova, e aprovar valores digitados de memória não é uma decisão conferida.
 */
export function decisionsFor(g: ClientGrant): GrantDecision[] {
  switch (g.status) {
    case 'pending':
      return ['approve'];
    case 'active':
      return ['review', 'renew'];
    case 'suspended':
      return ['renew'];
    case 'revoked':
      return ['request-again'];
  }
}

export const DECISION_LABEL: Record<GrantDecision, string> = {
  approve: 'Aprovar',
  renew: 'Pedir renovação',
  review: 'Revisar',
  'request-again': 'Pedir de novo',
};

/** Data (yyyy-mm-dd, fuso local) → fim do dia local em ISO-8601 com fuso (a API recusa data sem fuso). */
const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();
/** ISO → yyyy-mm-dd local (para pré-preencher o campo com o valor pedido). */
const toDay = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Diálogos de decisão das concessões (024). Regras do contrato que a tela torna visíveis:
 * - quem PEDIU não aprova (403); a aprovação envia EXATAMENTE os valores pedidos, conferidos pela pessoa (diferentes: 409);
 * - KEEP sem data preserva o prazo atual (nunca vira "sem prazo"); data mais tarde estenderia o acesso: 409 (renovação);
 * - renovação é pedido (sem step-up, sem mudar o acesso) + aprovação de OUTRA pessoa (step-up). A aprovação da
 *   renovação fica INDISPONÍVEL nesta tela até a leitura do pedido existir (D-API-02).
 * Recusa por conflito (estado mudou, pedido substituído ou já decidido): a lista é recarregada e nada é reenviado.
 */
export function GrantDecisionDialog({
  org,
  grant,
  decision,
  onClose,
  onDone,
  onUncertain,
  onUnauthenticated,
  onRefused,
}: {
  org: string;
  grant: ClientGrant | null;
  decision: GrantDecision | null;
  onClose: () => void;
  onDone: (text: string) => void;
  onUncertain: () => void;
  onUnauthenticated: () => void;
  /** A API recusou (ex.: 409 porque a concessão mudou): a tela relê a lista do servidor; a decisão não é reenviada. */
  onRefused?: () => void;
}) {
  const [nextReview, setNextReview] = useState('');
  const [expires, setExpires] = useState('');
  const [noExpiry, setNoExpiry] = useState(false);
  const [justification, setJustification] = useState('');
  const [checked, setChecked] = useState(false);
  const [reviewDecision, setReviewDecision] = useState<'KEEP' | 'SUSPEND' | 'REVOKE'>('KEEP');
  const [notes, setNotes] = useState('');

  const key = `${grant?.grantId}:${decision}`;
  useEffect(() => {
    setNextReview(decision === 'approve' ? toDay(grant?.nextReviewAt ?? null) : '');
    setExpires(decision === 'approve' ? toDay(grant?.expiresAt ?? null) : '');
    setNoExpiry(decision === 'approve' ? !grant?.expiresAt : false);
    setJustification('');
    setChecked(false);
    setReviewDecision('KEEP');
    setNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!grant || !decision) return null;
  const who = `${grant.externalAccount.displayName} em ${grant.workspace.name}`;
  const future = (day: string) => !!day && new Date(`${day}T23:59:59`).getTime() > Date.now();
  const expiryOk = noExpiry || !expires || future(expires);
  const common = {
    open: true,
    onClose,
    onUnauthenticated,
    onOutcome: (k: string) => {
      if (k === 'uncertain') onUncertain();
      if (k === 'refused') onRefused?.();
    },
    uncertainText: 'Não foi possível confirmar o resultado. Feche e atualize a lista antes de decidir de novo.',
  };
  const refusal = (e: unknown) =>
    accessRefusal(e, {
      conflict:
        'A concessão mudou desde a leitura (outro pedido, outra decisão ou mudança de estado), ou a revisão estenderia o prazo. A lista foi atualizada com o estado atual; confira antes de decidir de novo.',
      forbidden: 'O ato não foi permitido: quem pediu não pode aprovar, e as permissões ou a confirmação podem não valer mais.',
    });

  if (decision === 'approve') {
    return (
      <StepUpDialog
        {...common}
        title={`Aprovar o acesso de ${who}?`}
        confirmLabel="Aprovar"
        ready={checked}
        stepUp={orgStepUp(org)}
        action={() => approveClientGrant(org, grant.grantId, { nextReviewAt: grant.nextReviewAt!, ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}) })}
        onDone={() => onDone('Concessão aprovada com os valores pedidos.')}
        refusalText={refusal}
      >
        <Text>Confira os valores pedidos. A aprovação aplica exatamente estes valores; para mudar, recuse e peça de novo.</Text>
        <dl className="pw-admin__grant-id">
          <div>
            <dt>Início</dt>
            <dd>
              <DateTimeText iso={grant.startsAt} />
            </dd>
          </div>
          <div>
            <dt>Próxima revisão</dt>
            <dd>
              <DateTimeText iso={grant.nextReviewAt} />
            </dd>
          </div>
          <div>
            <dt>Prazo</dt>
            <dd>{grant.expiresAt ? <DateTimeText iso={grant.expiresAt} /> : 'Sem prazo'}</dd>
          </div>
        </dl>
        <Checkbox label="Conferi os valores pedidos." checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <Text variant="body-sm" color="secondary">
          Quem pediu a concessão não pode aprová-la: a API recusa.
        </Text>
      </StepUpDialog>
    );
  }

  if (decision === 'renew' || decision === 'request-again') {
    const again = decision === 'request-again';
    const ready = future(nextReview) && expiryOk && (again || justification.trim().length > 0);
    // calculado só no envio: com a data ainda vazia, endOfDay daria data inválida (e toISOString lançaria na renderização)
    const values = () => ({ nextReviewAt: endOfDay(nextReview), ...(noExpiry || !expires ? {} : { expiresAt: endOfDay(expires) }) });
    return (
      <StepUpDialog
        {...common}
        title={again ? `Pedir de novo o acesso de ${who}?` : `Pedir a renovação de ${who}?`}
        confirmLabel="Enviar pedido"
        ready={ready}
        action={() =>
          again
            ? createClientGrant(org, { clientMembershipId: grant.externalAccount.clientMembershipId, workspaceId: grant.workspace.workspaceId, ...values() })
            : requestClientGrantRenewal(org, grant.grantId, { ...values(), justification: justification.trim() })
        }
        onDone={() =>
          onDone(
            again
              ? 'Pedido de concessão criado. Ele precisa da aprovação de outra pessoa.'
              : 'Pedido de renovação registrado. O acesso não muda até outra pessoa aprovar. A aprovação da renovação ainda não está disponível nesta tela.',
          )
        }
        refusalText={refusal}
      >
        <Text>{again ? 'Cria um pedido novo para a mesma conta e workspace.' : 'O acesso atual não muda até a aprovação de outra pessoa.'}</Text>
        {!again && (
          <Alert tone="info" live="off">
            Aprovar a renovação ainda não está disponível nesta tela: a Platform não mostra o pedido pendente a quem
            aprova. O pedido fica registrado.
          </Alert>
        )}
        <Input label="Próxima revisão" type="date" required fullWidth value={nextReview} onChange={(e) => setNextReview(e.target.value)} hint="Data futura." />
        <Checkbox label="Sem prazo de término" checked={noExpiry} onChange={(e) => setNoExpiry(e.target.checked)} />
        {!noExpiry && <Input label="Prazo de término (opcional)" type="date" fullWidth value={expires} onChange={(e) => setExpires(e.target.value)} />}
        {decision === 'renew' && (
          <Textarea label="Justificativa" required fullWidth maxLength={2000} value={justification} onChange={(e) => setJustification(e.target.value)} />
        )}
      </StepUpDialog>
    );
  }

  // revisão periódica
  const earlier = nextReview && grant.nextReviewAt ? new Date(endOfDay(nextReview)) < new Date(grant.nextReviewAt) : true;
  return (
    <StepUpDialog
      {...common}
      title={`Revisar o acesso de ${who}`}
      confirmLabel={reviewDecision === 'KEEP' ? 'Manter' : reviewDecision === 'SUSPEND' ? 'Suspender' : 'Revogar'}
      tone={reviewDecision === 'KEEP' ? 'primary' : 'danger'}
      ready={reviewDecision !== 'KEEP' || !nextReview || (future(nextReview) && earlier)}
      stepUp={orgStepUp(org)}
      action={() =>
        reviewClientGrant(org, grant.grantId, {
          decision: reviewDecision,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          ...(reviewDecision === 'KEEP' && nextReview ? { nextReviewAt: endOfDay(nextReview) } : {}),
        })
      }
      onDone={() =>
        onDone(
          reviewDecision === 'KEEP'
            ? nextReview
              ? 'Revisão registrada; a próxima revisão foi antecipada.'
              : 'Revisão registrada; o prazo e a próxima revisão continuam os mesmos.'
            : reviewDecision === 'SUSPEND'
              ? 'Concessão suspensa.'
              : 'Concessão revogada.',
        )
      }
      refusalText={refusal}
    >
      <RadioGroup
        legend="Decisão"
        value={reviewDecision}
        onChange={(v) => setReviewDecision(v as 'KEEP' | 'SUSPEND' | 'REVOKE')}
        options={[
          { value: 'KEEP', label: 'Manter (registra a revisão)' },
          { value: 'SUSPEND', label: 'Suspender' },
          { value: 'REVOKE', label: 'Revogar' },
        ]}
      />
      {reviewDecision === 'KEEP' && (
        <Stack gap={2}>
          <Input
            label="Antecipar a próxima revisão (opcional)"
            type="date"
            fullWidth
            value={nextReview}
            onChange={(e) => setNextReview(e.target.value)}
            hint="Em branco: o prazo e a próxima revisão continuam os mesmos (nunca vira sem prazo). Só datas mais cedo; para estender, use a renovação."
            error={nextReview && !(future(nextReview) && earlier) ? 'Escolha uma data futura e anterior à próxima revisão atual.' : undefined}
          />
        </Stack>
      )}
      <Textarea label="Observações (opcional)" fullWidth maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
    </StepUpDialog>
  );
}

/** Botões de decisão de uma linha (o diálogo é único, na página). */
export function GrantDecisionButtons({ grant, onPick }: { grant: ClientGrant; onPick: (d: GrantDecision) => void }) {
  return (
    <>
      {decisionsFor(grant).map((d) => (
        <Button key={d} size="sm" variant="ghost" onClick={() => onPick(d)} aria-label={`${DECISION_LABEL[d]}: ${grant.externalAccount.displayName} em ${grant.workspace.name}`}>
          {DECISION_LABEL[d]}
        </Button>
      ))}
    </>
  );
}
