'use client';

import { useGetAuthConfigQuery } from '../../store/api/auth.api';

export const DEMO_ACCESS_TITLE = 'Demo access';
export const DEMO_ACCESS_TEXT = 'Sign-up is closed while ForexEdge is a portfolio demo.';
export const DEMO_REQUEST_LINK_TEXT = 'Request a demo login on LinkedIn';
export const DEMO_REQUEST_FALLBACK_TEXT = 'Ask the site owner for a demo login.';

// The href the card may use: an absolute https:// URL, or null. auth-service already drops anything else
// at startup; this is the second guard, so a javascript: (or http:, relative, malformed) value can never
// reach an <a href> even if a server sent one.
export function safeDemoRequestHref(raw: unknown): string | null {
  if (typeof raw !== 'string' || !/^https:\/\/\S+$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') return null;
    return url.href;
  } catch {
    return null;
  }
}

// Under the sign-in form on a deployment with sign-up closed: says why there is no "Create one" link
// and where to ask for a login. Shown only when auth-service says registration is closed (while the
// config is loading or failed to load, nothing is shown, like the "Create one" link).
export function DemoAccessCard() {
  const { data } = useGetAuthConfigQuery();
  if (data?.registrationEnabled !== false) return null;
  const href = safeDemoRequestHref(data.demoRequestUrl);

  return (
    <section
      aria-labelledby="demo-access-title"
      data-testid="demo-access-card"
      className="mt-4 bg-terminal-surface border border-terminal-border rounded-lg px-5 py-4"
    >
      <h2 id="demo-access-title" className="text-sm font-medium text-[#e2e4e9] mb-1">
        {DEMO_ACCESS_TITLE}
      </h2>
      <p className="text-[13px] leading-relaxed text-[#e2e4e9]/80">
        {DEMO_ACCESS_TEXT}{' '}
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-blue underline underline-offset-2 hover:text-accent-blue/80 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-blue"
          >
            {DEMO_REQUEST_LINK_TEXT}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : (
          DEMO_REQUEST_FALLBACK_TEXT
        )}
        {href && '.'}
      </p>
    </section>
  );
}
