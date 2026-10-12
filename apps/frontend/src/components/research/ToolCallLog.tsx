import type { ResearchToolCall } from '../../types/api.types';

// The tools the agent called, with their (possibly truncated) results, as plain text.
export function ToolCallLog({ calls }: { calls: ResearchToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <details className="border-t border-terminal-border" data-testid="tool-call-log">
      <summary className="px-4 py-2.5 cursor-pointer text-[10px] font-medium text-terminal-muted uppercase tracking-wider">
        Tool calls ({calls.length})
      </summary>
      <ol className="px-4 pb-3 space-y-3">
        {calls.map((c) => (
          <li key={c.id} className="text-[11px]" data-testid="tool-call">
            <p className="font-mono text-[#e2e4e9]">
              <span className="text-terminal-muted">{c.id}</span> {c.name}{' '}
              <span className={c.ok ? 'text-accent-green' : 'text-accent-red'}>{c.ok ? 'ok' : 'error'}</span>
            </p>
            <pre className="mt-1 font-mono text-terminal-muted whitespace-pre-wrap break-all">{JSON.stringify(c.args)}</pre>
            <pre className="mt-1 max-h-48 overflow-y-auto rounded bg-terminal-elevated p-2 font-mono text-[10px] text-[#e2e4e9] whitespace-pre-wrap break-all">
              {c.result_truncated}
            </pre>
          </li>
        ))}
      </ol>
    </details>
  );
}
