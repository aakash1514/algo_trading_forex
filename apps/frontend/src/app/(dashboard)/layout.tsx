import { AuthGuard } from '../../components/auth/AuthGuard';
import { Topbar } from '../../components/layout/Topbar';
import { Sidenav } from '../../components/layout/Sidenav';

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard>
      <div className="h-screen flex flex-col bg-terminal-bg overflow-hidden">
        <Topbar />
        <div className="flex-1 flex overflow-hidden">
          <Sidenav />
          <main className="flex-1 overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </AuthGuard>
  );
}