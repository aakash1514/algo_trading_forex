import { Metadata } from 'next';
import { ResearchClient } from '../../../components/research/ResearchClient';

export const metadata: Metadata = { title: 'Research — ForexEdge' };

export default function ResearchPage() {
  return <ResearchClient />;
}
