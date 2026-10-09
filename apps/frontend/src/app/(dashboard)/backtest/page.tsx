import { Metadata } from 'next';
import { BacktestClient } from '../../../components/backtest/BacktestClient';

export const metadata: Metadata = { title: 'Backtests — ForexEdge' };

export default function BacktestPage() {
  return <BacktestClient />;
}