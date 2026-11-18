import React, { useCallback, useEffect, useState } from 'react';
import { onIdTokenChanged, signInWithPopup, signOut } from 'firebase/auth';
import {
  BookOpen,
  Database,
  LayoutDashboard,
  Loader2,
  LogOut,
  Menu,
  MessageSquareText,
  Sparkles,
  X,
} from 'lucide-react';
import { AdminDashboardView } from './components/AdminDashboardView';
import { AiStudioView } from './components/AiStudioView';
import { ChatQaView } from './components/ChatQaView';
import { ErrorBoundary } from './components/ErrorBoundary';
import { LoginView } from './components/LoginView';
import { SopDetailModal } from './components/SopDetailModal';
import { SopRepositoryView } from './components/SopRepositoryView';
import { auth, googleAuthProvider } from './lib/firebase';
import { ThemeProvider, ThemeToggleButton } from './lib/theme';
import {
  fetchAccessibleSops,
  fetchDepartments,
  fetchDirectoryMembers,
  fetchDivisions,
  fetchSopById,
  seedInitialEnterpriseData,
  syncUserProfileAndDirectory,
} from './lib/sopService';
import type {
  Department,
  DirectoryMember,
  Division,
  QueryLog,
  SopDocument,
  UserProfile,
} from './types/sop';

type ActiveView = 'chat' | 'repository' | 'ai-studio' | 'admin';

function SopBrainApp() {
  const [authLoading, setAuthLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  const [user, setUser] = useState<UserProfile | null>(null);
  const [idToken, setIdToken] = useState<string>('');
  const [activeView, setActiveView] = useState<ActiveView>('chat');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [divisions, setDivisions] = useState<Division[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [directory, setDirectory] = useState<DirectoryMember[]>([]);
  const [sops, setSops] = useState<SopDocument[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [seedingLabel, setSeedingLabel] = useState<string | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  // SOP Modal State
  const [modalSop, setModalSop] = useState<SopDocument | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<'read' | 'edit'>('read');
  const [modalHighlightSection, setModalHighlightSection] = useState<string | undefined>(undefined);
  const [modalRevisionContext, setModalRevisionContext] = useState<{
    feedbackLogs: QueryLog[];
  } | null>(null);
  const [adminRefreshTick, setAdminRefreshTick] = useState(0);

  // Prefill from Admin Unanswered Question -> AI Writer
  const [aiPrefill, setAiPrefill] = useState<{
    notes: string;
    titleHint: string;
    logIds?: string[];
  } | null>(null);

  const loadWorkspaceData = useCallback(async (profile: UserProfile) => {
    setDataLoading(true);
    try {
      const [divs, depts, dir, sopList] = await Promise.all([
        fetchDivisions(),
        fetchDepartments(),
        fetchDirectoryMembers(),
        fetchAccessibleSops(profile),
      ]);
      setDivisions(divs);
      setDepartments(depts);
      setDirectory(dir);
      setSops(sopList);
      setSeedError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal memuat data workspace.';
      setSeedError(msg);
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    let lastUid: string | null = null;
    const unsub = onIdTokenChanged(auth, async (fbUser) => {
      if (!fbUser) {
        lastUid = null;
        setUser(null);
        setIdToken('');
        setAuthLoading(false);
        return;
      }

      try {
        const token = await fbUser.getIdToken();
        setIdToken(token);
        if (lastUid !== fbUser.uid) {
          lastUid = fbUser.uid;
          const profile = await syncUserProfileAndDirectory(fbUser);
          setUser(profile);
          await loadWorkspaceData(profile);
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
        setLoginError(err instanceof Error ? err.message : 'Gagal memuat profil pengguna.');
      } finally {
        setAuthLoading(false);
      }
    });

    return () => unsub();
  }, [loadWorkspaceData]);

  const handleSignIn = async () => {
    setSigningIn(true);
    setLoginError(null);
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Gagal masuk dengan Google.');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    await signOut(auth);
  };

  const handleSeedDemo = async () => {
    if (!user || !idToken || seedingLabel) return;
    setSeedError(null);
    setSeedingLabel('Menyiapkan data SOP perusahaan...');
    try {
      const freshToken = (await auth.currentUser?.getIdToken()) || idToken;
      setIdToken(freshToken);
      await seedInitialEnterpriseData({
        actor: user,
        directory,
        idToken: freshToken,
        onProgress: (label) => setSeedingLabel(label),
      });
      await loadWorkspaceData(user);
    } catch (err) {
      console.error('Seeding failed:', err);
      setSeedError(err instanceof Error ? err.message : 'Gagal memuat data SOP awal.');
    } finally {
      setSeedingLabel(null);
    }
  };

  const handleOpenSopCitation = async (sopId: string, sectionTitle?: string) => {
    let found: SopDocument | null | undefined = sops.find((s) => s.id === sopId);
    if (!found) {
      try {
        found = await fetchSopById(sopId);
        if (found) {
          setSops((prev) => [found!, ...prev.filter((s) => s.id !== found!.id)]);
        }
      } catch (err) {
        setSeedError(err instanceof Error ? err.message : 'Gagal membuka dokumen SOP sumber.');
        return;
      }
    }
    if (!found) return;
    setModalSop(found);
    setModalMode('read');
    setModalHighlightSection(sectionTitle);
    setModalRevisionContext(null);
    setModalOpen(true);
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center">
        <div className="flex items-center gap-2.5 text-sm text-slate-600 dark:text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin text-sky-600 dark:text-sky-400" />
          <span>Memuat SOP Brain...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginView onSignIn={handleSignIn} loading={signingIn} error={loginError} />;
  }

  const canWrite = user.role !== 'Karyawan';
  const isAdmin = user.role === 'Super Admin' || user.role === 'Admin Divisi';

  const navItems: { id: ActiveView; label: string; icon: React.ReactNode; visible: boolean }[] = [
    {
      id: 'chat',
      label: 'Tanya AI',
      icon: <MessageSquareText className="w-4 h-4" />,
      visible: true,
    },
    {
      id: 'repository',
      label: 'Pusat SOP',
      icon: <BookOpen className="w-4 h-4" />,
      visible: true,
    },
    {
      id: 'ai-studio',
      label: 'Impor & Buat AI',
      icon: <Sparkles className="w-4 h-4" />,
      visible: canWrite,
    },
    {
      id: 'admin',
      label: 'Dashboard Admin',
      icon: <LayoutDashboard className="w-4 h-4" />,
      visible: isAdmin,
    },
  ];

  const activeTitle = navItems.find((n) => n.id === activeView)?.label || 'SOP Brain';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      {/* Top Bar */}
      <header className="h-14 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 sm:px-6 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen((v) => !v)}
            className="lg:hidden p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-900 rounded-md cursor-pointer"
            aria-label="Menu navigasi"
          >
            {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <span className="font-display text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            SOP Brain
          </span>
          <span className="hidden sm:inline text-slate-300 dark:text-slate-600">/</span>
          <span className="hidden sm:inline text-sm font-medium text-slate-600 dark:text-slate-400 truncate">
            {activeTitle}
          </span>
        </div>

        <nav className="hidden lg:flex items-center gap-1">
          {navItems
            .filter((n) => n.visible)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveView(item.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  activeView === item.id
                    ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
        </nav>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="hidden md:block text-right">
            <p className="text-xs font-medium text-slate-900 dark:text-slate-100 leading-tight">{user.displayName}</p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-tight">
              {user.role} · {user.divisionName || 'Umum'}
            </p>
          </div>
          <ThemeToggleButton />
          <button
            type="button"
            onClick={handleSignOut}
            title="Keluar akun"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-900 hover:bg-slate-200 dark:hover:bg-slate-800 border border-transparent dark:border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Keluar</span>
          </button>
        </div>
      </header>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="lg:hidden border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 px-4 py-3 space-y-1 z-20">
          {navItems
            .filter((n) => n.visible)
            .map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveView(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                  activeView === item.id
                    ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
        </div>
      )}

      {/* Initial Empty Workspace Bootstrap Banner for Super Admin */}
      {!dataLoading && divisions.length === 0 && user.role === 'Super Admin' && (
        <div className="bg-sky-50 dark:bg-sky-950/40 border-b border-sky-200 dark:border-sky-800/70 px-4 sm:px-6 py-3">
          <div className="max-w-6xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="text-xs text-sky-950 dark:text-sky-100">
              <strong>Workspace baru terdeteksi:</strong> Muat contoh struktur Divisi, Departemen, dan 8 SOP standar perusahaan (Reimbursement, Stok Minimum, Batas Tender, Cuti, WFH, Pembelian Darurat Cabang, dll.) lengkap dengan indeks vektor AI.
            </div>
            <button
              type="button"
              disabled={Boolean(seedingLabel)}
              onClick={handleSeedDemo}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {seedingLabel ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Database className="w-3.5 h-3.5" />
              )}
              <span>{seedingLabel || 'Muat Data SOP Awal'}</span>
            </button>
          </div>
        </div>
      )}

      {seedError && (
        <div className="bg-rose-50 dark:bg-rose-950/50 border-b border-rose-200 dark:border-rose-800/70 px-4 sm:px-6 py-2.5 text-xs text-rose-900 dark:text-rose-200 flex items-center justify-between gap-3">
          <span>Terjadi kendala data: {seedError}</span>
          <button
            type="button"
            onClick={() => setSeedError(null)}
            className="text-rose-700 dark:text-rose-300 font-medium hover:underline cursor-pointer shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 min-w-0">
        {activeView === 'chat' && (
          <ChatQaView
            user={user}
            idToken={idToken}
            divisions={divisions}
            directory={directory}
            sops={sops}
            onOpenSopCitation={handleOpenSopCitation}
          />
        )}

        {activeView === 'repository' && (
          <SopRepositoryView
            user={user}
            divisions={divisions}
            departments={departments}
            sops={sops}
            onSelectSop={(sop, mode) => {
              setModalSop(sop);
              setModalMode(mode);
              setModalHighlightSection(undefined);
              setModalRevisionContext(null);
              setModalOpen(true);
            }}
            onCreateNewSop={() => {
              setModalSop(null);
              setModalMode('edit');
              setModalHighlightSection(undefined);
              setModalRevisionContext(null);
              setModalOpen(true);
            }}
          />
        )}

        {activeView === 'ai-studio' && canWrite && (
          <AiStudioView
            user={user}
            idToken={idToken}
            divisions={divisions}
            departments={departments}
            directory={directory}
            sops={sops}
            prefillNotes={aiPrefill}
            onClearPrefill={() => setAiPrefill(null)}
            onSopCreated={(saved) => {
              setSops((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
            }}
            onOrgUpdated={() => loadWorkspaceData(user)}
          />
        )}

        {activeView === 'admin' && isAdmin && (
          <AdminDashboardView
            user={user}
            idToken={idToken}
            divisions={divisions}
            departments={departments}
            directory={directory}
            sops={sops}
            seedingLabel={seedingLabel}
            onSeedDemo={handleSeedDemo}
            onOpenSop={(sop) => {
              setModalSop(sop);
              setModalMode('read');
              setModalHighlightSection(undefined);
              setModalRevisionContext(null);
              setModalOpen(true);
            }}
            onDraftFromQuestion={(notes, titleHint, logIds) => {
              setAiPrefill({ notes, titleHint, logIds });
              setActiveView('ai-studio');
            }}
            onReviseSopFromFeedback={(sopDoc, feedbackLogs) => {
              setModalSop(sopDoc);
              setModalMode('edit');
              setModalHighlightSection(undefined);
              setModalRevisionContext({ feedbackLogs });
              setModalOpen(true);
            }}
            onOrgUpdated={() => loadWorkspaceData(user)}
            refreshTick={adminRefreshTick}
          />
        )}
      </main>

      {modalOpen && (
        <SopDetailModal
          sop={modalSop}
          initialMode={modalMode}
          highlightSection={modalHighlightSection}
          user={user}
          idToken={idToken}
          divisions={divisions}
          departments={departments}
          directory={directory}
          allSops={sops}
          revisionContext={modalRevisionContext}
          onFeedbackLogsResolved={() => {
            setModalRevisionContext(null);
            setAdminRefreshTick((n) => n + 1);
          }}
          onClose={() => {
            setModalOpen(false);
            setModalRevisionContext(null);
          }}
          onSaved={(saved) => {
            setSops((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
            setAdminRefreshTick((n) => n + 1);
          }}
          onDeleted={(sopId) => {
            setSops((prev) => prev.filter((s) => s.id !== sopId));
          }}
          onOrgUpdated={() => loadWorkspaceData(user)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ErrorBoundary>
        <SopBrainApp />
      </ErrorBoundary>
    </ThemeProvider>
  );
}
