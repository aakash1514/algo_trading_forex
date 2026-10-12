import { Metadata } from 'next';
import { ModelEvaluationClient } from '../../../components/ml/ModelEvaluationClient';

export const metadata: Metadata = { title: 'Model evaluation — ForexEdge' };

export default function ModelEvaluationPage() {
  return <ModelEvaluationClient />;
}
