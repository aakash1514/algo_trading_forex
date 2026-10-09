import { Metadata } from 'next';
import { DashboardClient } from '../../../components/trading/DashboardClient';

export const metadata: Metadata = {
  title: 'Dashboard — ForexEdge',
};

export default function DashboardPage() {
  return <DashboardClient />;
}