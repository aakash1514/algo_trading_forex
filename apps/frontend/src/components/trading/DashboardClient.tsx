'use client';

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../../store';
import { setAccountSummary } from '../../store/slices/account.slice';
import { setPositions } from '../../store/slices/positions.slice';
import {
  useGetAccountSummaryQuery,
  useGetPositionsQuery,
} from '../../store/api/order.api';
import { useForexSocket } from '../../hooks/useForexSocket';
import { TradingChart } from '../charts/TradingChart';
import { OrderForm } from './OrderForm';
import { PositionsTable } from './PositionsTable';
import { AccountPanel } from './AccountPanel';
import { PairTabs } from './PairTabs';
import { FeedBanner } from './FeedBanner';
import { API_BASE } from '../../lib/constants';

export function DashboardClient() {
  const dispatch = useAppDispatch();
  const activePair = useAppSelector((s) => s.market.activePair);
  const accessToken = useAppSelector((s) => s.auth.accessToken);

  useForexSocket();

  const {
    data: accountData,
    error: accountError,
    isUninitialized: accountUninitialized,
    refetch: refetchAccount,
  } = useGetAccountSummaryQuery(undefined, { skip: !accessToken });

  const { data: positionsData } = useGetPositionsQuery(undefined, {
    skip: !accessToken,
  });

  // Auto-initialize account if it doesn't exist yet
  useEffect(() => {
    if (!accountError || !accessToken || accountUninitialized) return;
    const status = (accountError as any)?.status;
    if (status === 500 || status === 404) {
      fetch(`${API_BASE.ORDER}/account/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }).then(() => {
        if (!accountUninitialized) refetchAccount();
      });
    }
  }, [accountError, accessToken, accountUninitialized, refetchAccount]);

  useEffect(() => {
    if (accountData) dispatch(setAccountSummary(accountData));
  }, [accountData, dispatch]);

  useEffect(() => {
    if (positionsData) dispatch(setPositions(positionsData));
  }, [positionsData, dispatch]);

  return (
    <div className="h-full flex flex-col">
      <FeedBanner />
      <PairTabs />
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 border-r border-terminal-border">
          <TradingChart pair={activePair} />
        </div>
        <div className="w-60 shrink-0 flex flex-col bg-terminal-surface overflow-y-auto">
          <OrderForm />
          <AccountPanel />
        </div>
      </div>
      <div className="h-44 shrink-0 border-t border-terminal-border overflow-hidden">
        <PositionsTable />
      </div>
    </div>
  );
}