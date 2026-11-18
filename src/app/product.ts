import product from '../../product.json';

/**
 * Versão OFICIAL do produto (PLATFORM-INICIO-001). Fonte única: `product.json`, na raiz do repositório. É a versão da
 * Nekkora Platform como um todo: não é a versão do pacote do frontend (`package.json`), nem a da Nekkora-lib, nem a da API,
 * nem um commit. Muda quando uma release é publicada, na mesma PR que a prepara.
 */
export const PRODUCT_NAME: string = product.name;
export const PRODUCT_VERSION: string = product.version;

/** "Nekkora Platform 2.1". */
export function productLine(): string {
  return `${PRODUCT_NAME} ${PRODUCT_VERSION}`;
}

/** "© 2026 Nekkora. Todos os direitos reservados." O ano é o do relógio de quem abre a tela. */
export function copyrightLine(now: Date = new Date()): string {
  return `© ${now.getFullYear()} Nekkora. Todos os direitos reservados.`;
}
