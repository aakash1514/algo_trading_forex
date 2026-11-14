import { Metadata } from 'next';
import { LoginForm } from '../../../components/auth/LoginForm';
import { DemoAccessCard } from '../../../components/auth/DemoAccessCard';

export const metadata: Metadata = {
  title: 'Sign in — ForexEdge',
};

export default function LoginPage() {
  return (
    <>
      <LoginForm />
      <DemoAccessCard />
    </>
  );
}