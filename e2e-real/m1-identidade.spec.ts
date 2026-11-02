import { expect, test } from '@playwright/test';
import { confirmStepUp, identitySignIn, messages, PASSWORD, signInWithTotp, signUpAndEnroll, syntheticEmail, waitToken } from './support/lab';

/**
 * M1 contra a API REAL (laboratório descartável). Nenhuma semeadura: a pessoa nasce pelo cadastro do navegador e a
 * confirmação usa a mensagem que a própria Platform gravou na caixa de homologação.
 */

test('J01 + J06: cadastro → confirmação pela caixa → entrada → primeiro MFA → criar organização (step-up) → aguardando ativação → entrar → sair', async ({ page }) => {
  const person = await signUpAndEnroll(page, 'j01');

  // identidade recém-confirmada: lista vazia é legítima
  await expect(page.getByText('Você ainda não participa de nenhuma organização.')).toBeVisible();

  // criação com step-up
  await page.getByRole('button', { name: 'Criar organização' }).first().click();
  await expect(page).toHaveURL(/\/organizacoes\/nova$/);
  const orgName = `Ensaio J01 ${Date.now().toString(36)}`;
  await page.getByLabel('Nome da organização').fill(orgName);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('alertdialog')).toContainText(`Criar a organização "${orgName}"?`);
  await confirmStepUp(page, person, 'Criar organização');

  await expect(page).toHaveURL(/\/organizacoes$/);
  const card = page.getByRole('listitem').filter({ hasText: orgName });
  await expect(card.getByText('Aguardando ativação')).toBeVisible();
  await expect(card.getByText('Criada agora')).toBeVisible();
  await expect(card.getByText('Administração da organização')).toBeVisible();

  // troca: sessão de organização
  await card.getByRole('button', { name: `Entrar em ${orgName}` }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}$/);
  await expect(page.getByText(person.name).first()).toBeVisible();

  // sair encerra a organização e a identidade
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(page.getByText('Você saiu da sua conta.')).toBeVisible();
  await page.goto('/organizacoes');
  await expect(page).toHaveURL(/\/entrar$/);
});

test('J02: respostas uniformes do cadastro, reenvio invalida o link anterior, replay recusado', async ({ page }) => {
  const email = syntheticEmail('j02');
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const first = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', email);

  // reenvio: nova mensagem; a anterior deixa de valer
  await page.getByRole('button', { name: 'Reenviar mensagem' }).click();
  await expect(page.getByText('Pedido de reenvio recebido.')).toBeVisible();
  const second = await waitToken('IDENTITY_SIGNUP_CONFIRMATION', email, { after: 1 });
  expect(second).not.toBe(first);

  // link substituído: recusado sem efeito
  await page.goto('about:blank'); // link aberto do e-mail: carga nova da página
  await page.goto(`/cadastro/confirmar#token=${first}`);
  await page.getByLabel(/^Nome\*?$/).fill('Pessoa J02');
  await page.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Este link não é mais válido' })).toBeVisible();

  // link vigente: conclui; replay do mesmo link: recusado
  await page.goto('about:blank'); // link aberto do e-mail: carga nova da página
  await page.goto(`/cadastro/confirmar#token=${second}`);
  await page.getByLabel(/^Nome\*?$/).fill('Pessoa J02');
  await page.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Cadastro concluído' })).toBeVisible();
  await page.goto('about:blank'); // link aberto do e-mail: carga nova da página
  await page.goto(`/cadastro/confirmar#token=${second}`);
  await page.getByLabel(/^Nome\*?$/).fill('Outra Pessoa');
  await page.getByLabel(/^Senha\*?$/).fill(PASSWORD);
  await page.getByLabel(/^Confirmar senha\*?$/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Concluir cadastro' }).click();
  await expect(page.getByRole('heading', { name: 'Este link não é mais válido' })).toBeVisible();

  // e-mail já cadastrado: a MESMA tela; a caixa recebe só o aviso de conta existente (sem token)
  const before = messages('IDENTITY_SIGNUP_ALREADY_REGISTERED', email);
  await page.goto('/cadastro');
  await page.getByRole('textbox', { name: /E-mail/ }).fill(email);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  await expect.poll(() => messages('IDENTITY_SIGNUP_ALREADY_REGISTERED', email), { timeout: 20_000 }).toBe(before + 1);

  // abrir o link não consome nada: só o envio do formulário (já provado acima: o link "second" só caiu depois do envio)
});

test('J03: senha errada genérica, código errado, entrada válida, sessão encerrada fora da aba', async ({ page, context }) => {
  const person = await signUpAndEnroll(page, 'j03');
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);

  // senha errada e e-mail inexistente: a MESMA mensagem
  await identitySignIn(page, person.email, 'senha-errada-com-tamanho');
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(syntheticEmail('inexistente'));
  await page.getByLabel(/^Senha/).fill(PASSWORD);
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();

  // código errado: recusado, desafio continua
  await page.getByRole('textbox', { name: /E-mail/ }).fill(person.email);
  await page.getByLabel(/^Senha/).fill(PASSWORD);
  await page.getByLabel(/^Senha/).press('Enter');
  await expect(page).toHaveURL(/\/entrar\/verificacao$/);
  await page.getByLabel('Código de autenticação').fill(person.auth.wrong());
  await expect(page.getByText('Código inválido ou expirado.')).toBeVisible();
  await page.getByLabel('Código de autenticação').fill(await person.auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);

  // recarregar mantém a sessão (o CSRF volta de /me/session)
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Suas organizações' })).toBeVisible();

  // sessão encerrada por outra aba: esta aba é reconciliada sem mostrar dados anteriores
  const other = await context.newPage();
  await other.goto('/organizacoes');
  await expect(other.getByRole('heading', { name: 'Suas organizações' })).toBeVisible();
  await other.getByRole('button', { name: 'Sair' }).click();
  await expect(other).toHaveURL(/\/entrar$/);
  await expect(page).toHaveURL(/\/entrar$/);
  await signInWithTotp(page, person);
});

test('J04: código de recuperação → sessão restrita visível → troca do fator libera → código usado não volta a valer', async ({ page }) => {
  const person = await signUpAndEnroll(page, 'j04');
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page).toHaveURL(/\/entrar$/);

  const used = person.recoveryCodes[0];
  await identitySignIn(page, person.email);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await page.getByLabel(/^Código de recuperação/).fill(used);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();

  // restrita: só a troca do fator; organizações recusadas pela API e fora do menu
  await expect(page).toHaveURL(/\/conta\/fator$/);
  await expect(page.getByText('Você entrou com um código de recuperação.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Organizações' })).toHaveCount(0);
  await page.goto('/organizacoes');
  await expect(page).toHaveURL(/\/conta\/fator$/);

  // troca do fator (a marca da recuperação autoriza; sem step-up)
  await page.getByRole('button', { name: 'Começar' }).click();
  const { readAuthenticator, readRecoveryCodes } = await import('./support/lab');
  const auth = await readAuthenticator(page);
  await page.getByRole('button', { name: 'Já adicionei a conta' }).click();
  await page.getByLabel(/Código do autenticador NOVO/).fill(await auth.next());
  const fresh = await readRecoveryCodes(page);
  expect(fresh).not.toContain(used);
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Concluir' }).click();
  await expect(page.getByText('Autenticador trocado.')).toBeVisible();
  await expect(page.getByText('Você entrou com um código de recuperação.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continuar' }).click();
  await expect(page.getByRole('heading', { name: 'Suas organizações' })).toBeVisible();

  // o código usado não vale mais; o fator antigo também não
  await page.getByRole('button', { name: 'Sair' }).click();
  await identitySignIn(page, person.email);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await page.getByLabel(/^Código de recuperação/).fill(used);
  await page.getByRole('button', { name: 'Usar código de recuperação' }).click();
  await expect(page.getByText('Código inválido ou expirado.')).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para código do autenticador' }).click();
  await page.getByLabel('Código de autenticação').fill(await person.auth.next());
  await expect(page.getByText('Código inválido ou expirado.')).toBeVisible();
  await page.getByLabel('Código de autenticação').fill(await auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);
});

test('J05: troca de senha e novos códigos com step-up; recuperação de senha pela caixa; MFA continua exigido', async ({ page }) => {
  const person = await signUpAndEnroll(page, 'j05');
  await page.goto('/conta');

  // troca de senha (step-up)
  const newPassword = 'Ensaio-Front-V1-001-nova-senha';
  await page.getByLabel(/^Senha atual/).fill(person.password);
  await page.getByLabel(/^Senha nova/).fill(newPassword);
  await page.getByLabel(/^Confirmar senha nova/).fill(newPassword);
  await page.getByRole('button', { name: 'Trocar senha' }).click();
  await confirmStepUp(page, person, 'Trocar senha');
  await expect(page.getByText(/Senha alterada\. As outras sessões foram encerradas/)).toBeVisible();

  // novos códigos (step-up): o conjunto anterior deixa de valer
  await page.getByRole('button', { name: 'Gerar novos códigos' }).click();
  await confirmStepUp(page, person, 'Gerar códigos');
  const { readRecoveryCodes } = await import('./support/lab');
  const regenerated = await readRecoveryCodes(page);
  expect(regenerated).not.toContain(person.recoveryCodes[1]);
  await page.getByLabel('Guardei meus códigos de recuperação em um local seguro.').check();
  await page.getByRole('button', { name: 'Concluir' }).click();
  await page.getByRole('button', { name: 'Sair' }).click();

  // senha antiga recusada (mensagem genérica); recuperação por e-mail
  await identitySignIn(page, person.email, person.password);
  await expect(page.getByText('E-mail ou senha incorretos.')).toBeVisible();
  await page.getByRole('link', { name: 'Esqueci minha senha' }).click();
  await expect(page).toHaveURL(/\/recuperar-senha$/);
  await expect(page.getByRole('heading', { name: 'Esqueceu sua senha?' })).toBeVisible();
  await page.getByRole('textbox', { name: /E-mail/ }).fill(person.email);
  await expect(page.getByRole('textbox', { name: /E-mail/ })).toHaveValue(person.email);
  await page.getByRole('button', { name: 'Enviar instruções' }).click();
  await expect(page.getByRole('heading', { name: 'Confira seu e-mail' })).toBeVisible();
  const token = await waitToken('PASSWORD_RECOVERY', person.email);
  await page.goto('about:blank');
  await page.goto(`/recuperar-senha#token=${token}`);
  await expect(page.getByRole('heading', { name: 'Crie uma nova senha' })).toBeVisible();
  expect(page.url()).not.toContain(token);
  const recovered = 'Ensaio-Front-V1-001-recuperada';
  await page.getByLabel(/^Nova senha/).fill(recovered);
  await page.getByLabel(/^Confirmar nova senha/).fill(recovered);
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByText(/O código do autenticador continua sendo pedido/)).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para o login' }).click();

  // MFA continua exigido depois da recuperação
  await identitySignIn(page, person.email, recovered);
  await expect(page).toHaveURL(/\/entrar\/verificacao$/);
  await page.getByLabel('Código de autenticação').fill(await person.auth.next());
  await expect(page).toHaveURL(/\/organizacoes$/);

  // o link de recuperação já usado não vale de novo
  await page.goto('about:blank');
  await page.goto(`/recuperar-senha#token=${token}`);
  await page.getByLabel(/^Nova senha/).fill('Ensaio-Front-V1-001-de-novo');
  await page.getByLabel(/^Confirmar nova senha/).fill('Ensaio-Front-V1-001-de-novo');
  await page.getByRole('button', { name: 'Salvar nova senha' }).click();
  await expect(page.getByRole('heading', { name: 'Este link não é mais válido' })).toBeVisible();
});
