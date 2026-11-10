import { Metadata } from 'next';
import { ReplayClient } from '../../../components/replay/ReplayClient';

export const metadata: Metadata = { title: 'Replay — ForexEdge' };

export default function ReplayPage() {
  return <ReplayClient />;
}
