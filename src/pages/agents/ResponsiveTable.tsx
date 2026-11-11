import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Table, type TableColumn } from 'nekkora-lib';

/**
 * PLATFORM-AGENT-V2-002 T08 (R1) — a mesma lista em tabela (quando cabe) ou em cartões (quando não cabe).
 *
 * - Um formato por vez: só um conjunto de controles existe no DOM, sem nada escondido que o teclado alcance.
 * - As MESMAS colunas (cabeçalho + render) alimentam os dois formatos: dados, permissões e ações são uma lógica só, e
 *   a consulta fica na página (trocar de formato não pede nada à API).
 * - O ponto de troca vem do espaço: a tabela vira cartões quando precisa de mais largura do que a região tem (rolagem
 *   horizontal) OU quando a região fica abaixo de `minTableWidth` (referência de ~900 px: janela estreita, zoom de 200%),
 *   e volta quando a região comporta as duas coisas. Sem medida (ResizeObserver ausente), fica a tabela.
 */
export function ResponsiveTable<T extends object>({
  columns,
  data,
  rowKey,
  caption,
  label,
  className,
  title,
  minTableWidth = 900,
}: {
  columns: TableColumn<T>[];
  data: T[];
  rowKey: keyof T & string;
  caption: string;
  /** Nome acessível da região. */
  label: string;
  className?: string;
  /** Coluna que vira o título de cada cartão (as demais viram pares rótulo/valor). */
  title: string;
  /** Abaixo desta largura da região, cartões mesmo que a tabela caiba (referência da revisão: ~900 px). */
  minTableWidth?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<'table' | 'cards'>('table');
  // largura de que a tabela precisou da última vez que não coube (volta à tabela quando a região comportar)
  const needed = useRef(0);
  const ids = useId();

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => {
      if (mode === 'table') {
        const overflow = el.scrollWidth > el.clientWidth + 1;
        if (overflow || el.clientWidth < minTableWidth) {
          if (overflow) needed.current = el.scrollWidth;
          setMode('cards');
        }
      } else if (el.clientWidth >= Math.max(needed.current, minTableWidth)) {
        setMode('table');
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode, data, columns, minTableWidth]);

  const head = columns.find((c) => c.key === title);
  const rest = columns.filter((c) => c.key !== title);
  const cell = (c: TableColumn<T>, row: T, i: number): ReactNode => (c.render ? c.render(row, i) : (row[c.key as keyof T] as ReactNode));

  return (
    <div
      ref={box}
      className={`${className ?? ''} pw-rtable pw-rtable--${mode}`}
      role="region"
      aria-label={label}
      // só a tabela rola na horizontal e precisa do foco para rolar pelo teclado
      tabIndex={mode === 'table' ? 0 : undefined}
      data-format={mode === 'table' ? 'tabela' : 'cartoes'}
    >
      {mode === 'table' ? (
        <Table columns={columns} data={data} rowKey={rowKey} size="sm" caption={caption} />
      ) : (
        <ul className="pw-rtable__cards" aria-label={caption}>
          {data.map((row, i) => {
            const id = `${ids}-${i}`;
            return (
              <li key={String(row[rowKey])} className="pw-rtable__card">
                <article aria-labelledby={id}>
                  <h2 id={id} className="pw-rtable__title">
                    {head ? cell(head, row, i) : null}
                  </h2>
                  <dl className="pw-rtable__fields">
                    {rest.map((c) => (
                      <div key={c.key} className={`pw-rtable__field pw-rtable__field--${c.key}`}>
                        <dt>{c.header}</dt>
                        <dd>{cell(c, row, i)}</dd>
                      </div>
                    ))}
                  </dl>
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
