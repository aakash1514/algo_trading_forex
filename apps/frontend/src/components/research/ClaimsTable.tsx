import type { ResearchClaim } from '../../types/api.types';

const th = 'text-left px-3 py-2 text-[10px] text-terminal-muted uppercase tracking-wider font-medium';
const td = 'px-3 py-2';

// Values are shown exactly as returned: the verifier checked these strings, so no rounding or formatting.
export function ClaimsTable({ claims }: { claims: ResearchClaim[] }) {
  if (claims.length === 0) return null;
  return (
    <table className="w-full text-[11px] border-t border-terminal-border" data-testid="claims-table">
      <thead>
        <tr className="border-b border-terminal-border">
          {['Claim', 'Value', 'Unit', 'Tool call'].map((h) => (
            <th key={h} className={th}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {claims.map((c, i) => (
          <tr key={i} className="border-b border-terminal-border last:border-0" data-testid="claim-row">
            <td className={td}>{c.text}</td>
            <td className={`${td} tabular-nums font-mono`}>{c.value}</td>
            <td className={`${td} text-terminal-muted`}>{c.unit}</td>
            <td className={`${td} text-terminal-muted font-mono`}>{c.tool_call_id}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
