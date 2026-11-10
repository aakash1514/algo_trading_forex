import { Metadata } from 'next';
import { RegisterGate } from '../../../components/auth/RegisterGate';

export const metadata: Metadata = {
  title: 'Create account — ForexEdge',
};

export default function RegisterPage() {
  return <RegisterGate />;
}