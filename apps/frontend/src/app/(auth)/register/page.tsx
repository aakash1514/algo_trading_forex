import { Metadata } from 'next';
import { RegisterForm } from '../../../components/auth/RegisterForm';

export const metadata: Metadata = {
  title: 'Create account — ForexEdge',
};

export default function RegisterPage() {
  return <RegisterForm />;
}