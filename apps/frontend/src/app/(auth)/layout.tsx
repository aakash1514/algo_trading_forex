export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-terminal-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex items-center gap-2 mb-8 justify-center">
          <div className="w-2 h-2 rounded-full bg-accent-green shadow-[0_0_8px_#22c55e]" />
          <span className="text-sm font-medium tracking-[0.12em] uppercase text-[#e2e4e9]">
            ForexEdge
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}