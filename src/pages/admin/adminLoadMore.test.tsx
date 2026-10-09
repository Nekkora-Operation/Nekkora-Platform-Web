/**
 * F6a-3-R1: `count` opcional do AdminLoadMore. Sem ele, "Exibindo N" conta os itens carregados (padrão de Membros e
 * Clientes); com ele, conta o que a tela exibe (Concessões esconde as revogadas que saíram do filtro).
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CursorList } from '../../hooks/useCursorList';
import { AdminLoadMore } from './shared';

const list = (n: number, hasMore: boolean): CursorList<number> => ({
  items: Array.from({ length: n }, (_, i) => i),
  status: 'ready',
  hasMore,
  cursorRejected: false,
  loadMore: vi.fn(),
  reload: vi.fn(),
});

describe('AdminLoadMore: contagem exibida', () => {
  it('sem count: conta os itens carregados, com plural e singular pelo mesmo número', () => {
    const { rerender } = render(<AdminLoadMore list={list(25, true)} one="membro" many="membros" />);
    expect(screen.getByText('Exibindo 25 membros')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeInTheDocument();
    rerender(<AdminLoadMore list={list(1, false)} one="membro" many="membros" />);
    expect(screen.getByText('Exibindo 1 membro · lista completa')).toBeInTheDocument();
  });

  it('com count: conta o informado (não os carregados); o rótulo segue o informado; a continuação não depende dele', () => {
    const { rerender } = render(<AdminLoadMore list={list(25, true)} count={0} one="concessão" many="concessões" />);
    expect(screen.getByText('Exibindo 0 concessões')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Carregar mais' })).toBeInTheDocument();
    rerender(<AdminLoadMore list={list(3, false)} count={1} one="concessão" many="concessões" />);
    expect(screen.getByText('Exibindo 1 concessão · lista completa')).toBeInTheDocument();
  });
});
