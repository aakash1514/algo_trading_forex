/** @jest-environment ./test/jsdom-with-fetch.cjs */
import { render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { store } from '../../store';
import { baseApi } from '../../store/api/base.api';
import type { AuthConfig } from '../../types/api.types';
import LoginPage from '../../app/(auth)/login/page';
import { RegisterGate } from './RegisterGate';
import {
  DEMO_ACCESS_TEXT,
  DEMO_REQUEST_FALLBACK_TEXT,
  DEMO_REQUEST_LINK_TEXT,
  safeDemoRequestHref,
} from './DemoAccessCard';

// The login page and /register through the real RTK Query endpoint: fetch answers GET /api/auth/config
// with auth-service's exact shape ({ registrationEnabled, demoRequestUrl }, AuthController.getConfig).

const replace = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: jest.fn() }), usePathname: () => '/login' }));

const LINKEDIN = 'https://www.linkedin.com/in/someone/';

function serveConfig(config: AuthConfig | 'error') {
  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname !== '/api/auth/config') return new Response('{}', { status: 404 });
    if (config === 'error') return new Response('{"message":"Bad gateway"}', { status: 502 });
    return new Response(JSON.stringify(config), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

const renderIn = (ui: React.ReactElement) => render(<Provider store={store}>{ui}</Provider>);
const configLoaded = () => waitFor(() => expect(store.getState().api.queries['getAuthConfig(undefined)']?.status).not.toBe('pending'));
const card = () => screen.queryByTestId('demo-access-card');

beforeEach(() => {
  store.dispatch(baseApi.util.resetApiState());
  replace.mockReset();
});
afterEach(() => jest.restoreAllMocks());

describe('Login page: demo-access card', () => {
  it('registration closed: the card is under the form, with a real link to the request URL', async () => {
    serveConfig({ registrationEnabled: false, demoRequestUrl: LINKEDIN });
    renderIn(<LoginPage />);
    const c = await screen.findByTestId('demo-access-card');
    expect(within(c).getByRole('heading', { name: 'Demo access' })).toBeTruthy();
    expect(c.textContent).toBe(`Demo access${DEMO_ACCESS_TEXT} ${DEMO_REQUEST_LINK_TEXT} (opens in a new tab).`);

    const link = within(c).getByRole('link', { name: `${DEMO_REQUEST_LINK_TEXT} (opens in a new tab)` });
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe(LINKEDIN);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // Reachable by keyboard, with a visible focus outline (no outline-none anywhere on it)
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(link.className).toMatch(/focus-visible:outline-2/);
    expect(link.className).not.toMatch(/outline-none/);

    // After the form, and no "Create one" link on a closed deployment
    const form = screen.getByRole('button', { name: 'Sign in' });
    expect(form.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Create one' })).toBeNull();
  });

  it('registration open: no card at all (the "Create one" link instead)', async () => {
    serveConfig({ registrationEnabled: true, demoRequestUrl: LINKEDIN });
    renderIn(<LoginPage />);
    await screen.findByRole('link', { name: 'Create one' });
    expect(card()).toBeNull();
    expect(screen.queryByText(DEMO_ACCESS_TEXT, { exact: false })).toBeNull();
  });

  it('config unknown (loading or failed): no card', async () => {
    serveConfig('error');
    renderIn(<LoginPage />);
    expect(card()).toBeNull();
    await configLoaded();
    expect(card()).toBeNull();
  });

  it('no request URL: the same card without a link', async () => {
    serveConfig({ registrationEnabled: false, demoRequestUrl: null });
    renderIn(<LoginPage />);
    const c = await screen.findByTestId('demo-access-card');
    expect(c.textContent).toBe(`Demo access${DEMO_ACCESS_TEXT} ${DEMO_REQUEST_FALLBACK_TEXT}`);
    expect(within(c).queryByRole('link')).toBeNull();
  });

  it.each(['javascript:alert(document.cookie)', 'JAVASCRIPT:alert(1)//https://x', 'http://www.linkedin.com/in/someone/', '/register', 'https:evil.example'])(
    'a non-https URL from the server (%j) is never rendered', async (bad) => {
      serveConfig({ registrationEnabled: false, demoRequestUrl: bad });
      const { container } = renderIn(<LoginPage />);
      const c = await screen.findByTestId('demo-access-card');
      expect(within(c).queryByRole('link')).toBeNull();
      expect(c.textContent).toContain(DEMO_REQUEST_FALLBACK_TEXT);
      expect(container.innerHTML).not.toContain(bad);
      expect(container.innerHTML.toLowerCase()).not.toContain('javascript:');
    },
  );
});

describe('safeDemoRequestHref', () => {
  it('passes an absolute https URL only', () => {
    expect(safeDemoRequestHref(LINKEDIN)).toBe(LINKEDIN);
    for (const bad of [null, undefined, 42, '', 'javascript:alert(1)', 'data:text/html,x', 'http://example.com', '//example.com',
      'https://', 'https:example.com', 'https://exa mple.com', 'https://user:pass@example.com/']) {
      expect(safeDemoRequestHref(bad)).toBeNull();
    }
  });
});

describe('/register', () => {
  it('registration closed: redirects to /login (replace), shows no form', async () => {
    serveConfig({ registrationEnabled: false, demoRequestUrl: LINKEDIN });
    renderIn(<RegisterGate />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/login'));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /create account/i })).toBeNull();
  });

  it('registration open: the form, no redirect', async () => {
    serveConfig({ registrationEnabled: true, demoRequestUrl: null });
    renderIn(<RegisterGate />);
    await screen.findByRole('button', { name: /create account/i });
    expect(replace).not.toHaveBeenCalled();
  });

  it('config failed to load: no redirect (unknown is not closed), the closed text and a way back', async () => {
    serveConfig('error');
    renderIn(<RegisterGate />);
    await configLoaded();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeTruthy();
  });
});
