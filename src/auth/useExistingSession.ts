import { useEffect, useRef, type RefObject } from 'react';
import { useNavigate } from 'react-router';
import { csrfStore } from '../api/csrf';
import type { AuthFlow } from './flow';

/**
 * Tela de entrada que observa a sessão: se este navegador JÁ tem sessão válida (a página foi recarregada depois da
 * entrada, ou outra aba entrou), leva direto ao destino da sessão em vez de pedir e-mail e senha de novo.
 *
 * A API é a autoridade (`flow.currentSession()`); nada local decide. Confere:
 * - ao abrir a tela (inclui recarregar);
 * - quando outra aba avisa que a sessão mudou (entrada ou saída; canal `nekkora-sessao`, sem token nem identidade);
 * - quando a aba volta a ficar visível ou recebe foco (navegador sem BroadcastChannel, ou aviso perdido).
 * Não confere enquanto esta aba envia a própria entrada (`busy`): o resultado do envio decide o próximo passo.
 *
 * `enabled = false` — nada é conferido (nem ao abrir, nem no foco, nem por aviso de outra aba):
 * - a pessoa chegou com aviso (saiu, a sessão expirou ou foi TROCADA em outra aba, F6a-2-R2): entra de novo
 *   explicitamente; a saída e a expiração nunca são desfeitas sozinhas, o contexto de uma pessoa não vira o da conta
 *   aberta em outra aba, e um 401 de uma rota com a sessão ainda válida não vira vaivém entre a área e a entrada;
 * - entrada por organização: não reentra sozinha (cookie de organização é um por origem; abas disputariam a sessão).
 *
 * O formulário aparece desde o início (a conferência roda em segundo plano); sem sessão, ou com falha que não é "sem
 * sessão", ele simplesmente continua (a entrada segue possível).
 */
export function useExistingSession(flow: AuthFlow, busy: RefObject<boolean>, enabled = true): void {
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  useEffect(() => {
    if (!enabled) return;
    // trava POR efeito: no StrictMode o efeito descartado não pode bloquear a conferência do efeito que vale
    let alive = true;
    let running = false;
    const check = async () => {
      if (running || busy.current) return;
      running = true;
      try {
        const session = await flow.currentSession();
        if (!alive || busy.current) return;
        if (session) navigateRef.current(flow.home(session.restricted), { replace: true });
      } catch {
        // sem conclusão: o formulário continua
      } finally {
        running = false;
      }
    };
    void check();
    const offBoundary = csrfStore.onSessionBoundary((remote, scope) => {
      if (remote && scope === 'all') void check();
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      offBoundary();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flow, busy, enabled]);
}
