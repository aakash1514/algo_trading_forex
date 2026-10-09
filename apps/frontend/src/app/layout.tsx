import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '../components/providers';

export const metadata: Metadata = {
  title: 'ForexEdge — Algorithmic Trading Terminal',
  description: 'Professional algorithmic forex trading platform',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="h-full bg-terminal-bg text-[#e2e4e9] antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}