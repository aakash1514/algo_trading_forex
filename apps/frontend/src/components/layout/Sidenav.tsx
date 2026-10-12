'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../../lib/cn';

const links = [
  { href: '/dashboard',  label: 'Terminal',  icon: '▤' },
  { href: '/backtest',   label: 'Backtest',  icon: '◈' },
  { href: '/calendar',   label: 'Calendar',  icon: '◷' },
  { href: '/model-evaluation', label: 'Model evaluation', icon: '◬' },
  { href: '/research', label: 'Research', icon: '⌕' },
];

export function Sidenav() {
  const pathname = usePathname();

  return (
    <nav className="w-12 shrink-0 border-r border-terminal-border bg-terminal-surface flex flex-col items-center py-3 gap-1">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          title={link.label}
          className={cn(
            'w-8 h-8 rounded flex items-center justify-center text-base transition-colors',
            pathname === link.href
              ? 'bg-accent-blue/10 text-accent-blue'
              : 'text-terminal-muted hover:text-[#e2e4e9] hover:bg-terminal-elevated'
          )}
        >
          {link.icon}
        </Link>
      ))}
    </nav>
  );
}