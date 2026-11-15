/**
 * Marca de que há uma entrada no aplicativo desktop em andamento — para que o login e o segundo fator terminem na página
 * de confirmação, e não na lista de organizações. Fica SÓ em memória (nada em armazenamento do navegador) e não guarda
 * nada do pedido, que está no servidor: só o instante em que a marca deixa de valer, igual ao prazo do pedido na API
 * (5 min). Recarregar a página a apaga; a pessoa então recomeça pelo aplicativo.
 */
const VALIDITY_MS = 5 * 60 * 1000;

let until = 0;

export function markDesktopPending(now = Date.now()): void {
  until = now + VALIDITY_MS;
}

export function clearDesktopPending(): void {
  until = 0;
}

export function desktopPending(now = Date.now()): boolean {
  if (until <= now) {
    until = 0;
    return false;
  }
  return true;
}

/** Sai da Web para o retorno local do aplicativo. Separado para os testes não navegarem de verdade. */
export const leave = {
  to(url: string): void {
    window.location.assign(url);
  },
};
