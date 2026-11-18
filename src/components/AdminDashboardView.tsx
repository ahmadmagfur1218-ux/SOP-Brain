import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  Check,
  Database,
  Edit3,
  FileWarning,
  GitCompareArrows,
  HelpCircle,
  History,
  Loader2,
  PenTool,
  Plus,
  RefreshCw,
  ShieldCheck,
  ThumbsDown,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { fetchApiJson } from '../lib/apiClient';
import { getFreshIdToken } from '../lib/firebase';
import {
  createDepartment,
  createOrUpdateDivision,
  deleteDepartment,
  deleteDivision,
  fetchAdminUsersList,
  fetchAuditLogs,
  fetchQueryLogsForAdmin,
  makeSafeId,
  markQueryGapResolved,
  recordAuditLog,
  stripSopMediaForAi,
  updateUserRoleAndDivision,
} from '../lib/sopService';
import type {
  AuditLog,
  Department,
  DirectoryMember,
  Division,
  QueryLog,
  SopConflictItem,
  SopDocument,
  UserProfile,
  UserRole,
} from '../types/sop';

interface AdminDashboardViewProps {
  user: UserProfile;
  idToken: string;
  divisions: Division[];
  departments: Department[];
  directory: DirectoryMember[];
  sops: SopDocument[];
  seedingLabel?: string | null;
  onSeedDemo?: () => Promise<void>;
  onOpenSop: (sop: SopDocument) => void;
  onDraftFromQuestion: (notes: string, titleHint: string, logIds: string[]) => void;
  onReviseSopFromFeedback: (sop: SopDocument, feedbackLogs: QueryLog[]) => void;
  onOrgUpdated: () => Promise<void>;
  refreshTick?: number;
}

export const AdminDashboardView: React.FC<AdminDashboardViewProps> = ({
  user,
  idToken,
  divisions,
  departments,
  directory,
  sops,
  seedingLabel,
  onSeedDemo,
  onOpenSop,
  onDraftFromQuestion,
  onReviseSopFromFeedback,
  onOrgUpdated,
  refreshTick = 0,
}) => {
  const [subTab, setSubTab] = useState<'analytics' | 'audit' | 'org' | 'users'>('analytics');
  const [logs, setLogs] = useState<QueryLog[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [usersList, setUsersList] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [orgSaving, setOrgSaving] = useState(false);
  const [updatingUserUid, setUpdatingUserUid] = useState<string | null>(null);

  // Fase 2: Proactive Conflict Scan state
  const [scanningConflicts, setScanningConflicts] = useState(false);
  const [conflictSummary, setConflictSummary] = useState<string | null>(null);
  const [conflictItems, setConflictItems] = useState<SopConflictItem[]>([]);
  const [resolvingLogId, setResolvingLogId] = useState<string | null>(null);

  // New Division / Department form
  const [newDivName, setNewDivName] = useState('');
  const [newDivCode, setNewDivCode] = useState('');
  const [newDivDesc, setNewDivDesc] = useState('');
  const [newDeptName, setNewDeptName] = useState('');
  const [newDeptCode, setNewDeptCode] = useState('');
  const [newDeptDivId, setNewDeptDivId] = useState(divisions[0]?.id || '');

  // Edit Division state
  const [editingDivId, setEditingDivId] = useState<string | null>(null);
  const [editDivName, setEditDivName] = useState('');
  const [editDivDesc, setEditDivDesc] = useState('');
  const [editDivLeadUid, setEditDivLeadUid] = useState('');
  const [editDivQuestions, setEditDivQuestions] = useState('');

  useEffect(() => {
    if (divisions.length > 0 && !divisions.some((d) => d.id === newDeptDivId)) {
      setNewDeptDivId(divisions[0].id);
    }
  }, [divisions, newDeptDivId]);

  const loadAdminData = useCallback(async () => {
    setLoading(true);
    try {
      const [logData, auditData, userData] = await Promise.all([
        fetchQueryLogsForAdmin(user),
        fetchAuditLogs(user),
        user.role === 'Super Admin' ? fetchAdminUsersList(user) : Promise.resolve([]),
      ]);
      setLogs(logData);
      setAuditLogs(auditData);
      setUsersList(userData);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memuat data dashboard admin.');
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadAdminData();
  }, [loadAdminData, sops.length, divisions.length, refreshTick]);

  const today = new Date().toISOString().slice(0, 10);

  const unansweredLogs = useMemo(
    () => logs.filter((l) => !l.answered && !l.resolvedAsSopId),
    [logs]
  );

  const resolvedGapCount = useMemo(
    () => logs.filter((l) => !l.answered && Boolean(l.resolvedAsSopId)).length,
    [logs]
  );

  const negativeFeedbackLogs = useMemo(
    () =>
      logs.filter(
        (l) => !l.resolvedAsSopId && (l.feedback === 'inaccurate' || l.feedback === 'outdated')
      ),
    [logs]
  );

  const resolvedFeedbackCount = useMemo(
    () =>
      logs.filter(
        (l) =>
          Boolean(l.resolvedAsSopId) &&
          (l.feedback === 'inaccurate' || l.feedback === 'outdated')
      ).length,
    [logs]
  );

  const healthIssues = useMemo(
    () =>
      sops.filter((s) => {
        const missingOwner = !s.ownerUid || !s.ownerName;
        const pastReview = s.status === 'Disetujui' && s.nextReviewDate && s.nextReviewDate < today;
        return missingOwner || pastReview;
      }),
    [sops, today]
  );

  const activeAskUsersCount = useMemo(
    () => new Set(logs.map((l) => l.userId)).size,
    [logs]
  );

  const popularByDivision = useMemo(() => {
    const map = new Map<string, { divisionName: string; question: string; count: number }>();
    for (const l of logs) {
      const key = `${l.divisionName}::${l.question.trim().toLowerCase()}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, {
          divisionName: l.divisionName || 'Umum',
          question: l.question,
          count: 1,
        });
      }
    }
    return Array.from(map.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [logs]);

  const formatTimestamp = (ts: unknown): string => {
    const seconds = (ts as { seconds?: number })?.seconds;
    if (!seconds) return 'Baru saja';
    return new Date(seconds * 1000).toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const feedbackLabel = (fb: QueryLog['feedback']): { text: string; tone: string } => {
    if (fb === 'helpful') return { text: 'Berguna', tone: 'text-emerald-700 dark:text-emerald-400 font-medium' };
    if (fb === 'inaccurate') return { text: 'Tidak Akurat', tone: 'text-rose-700 dark:text-rose-400 font-medium' };
    if (fb === 'outdated') return { text: 'SOP Sudah Usang', tone: 'text-amber-700 dark:text-amber-400 font-medium' };
    return { text: 'Belum dinilai', tone: 'text-neutral-400 dark:text-[#7a7a7a]' };
  };

  const handleCreateDivision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDivName.trim() || !newDivCode.trim()) {
      setErrorMsg('Nama divisi dan kode divisi wajib diisi.');
      return;
    }
    setOrgSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const divId = makeSafeId('div');
      const divName = newDivName.trim();
      const divCode = newDivCode.trim().toUpperCase();
      await createOrUpdateDivision({
        isNew: true,
        division: {
          id: divId,
          name: divName,
          code: divCode,
          description: newDivDesc.trim(),
          leadUid: user.uid,
          leadName: user.displayName,
          suggestedQuestions: [],
        },
      });
      await recordAuditLog({
        actor: user,
        action: 'Tambah Divisi',
        targetType: 'DIVISION',
        targetId: divId,
        targetLabel: `${divCode} — ${divName}`,
        divisionId: divId,
        detail: 'Menambahkan divisi baru ke struktur organisasi',
        directory,
      });
      setNewDivName('');
      setNewDivCode('');
      setNewDivDesc('');
      setStatusMsg(`Divisi "${divName}" berhasil ditambahkan.`);
      await onOrgUpdated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menambahkan divisi.');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    const parentDiv = divisions.find((d) => d.id === newDeptDivId) || divisions[0];
    if (!parentDiv) {
      setErrorMsg('Buat divisi induk terlebih dahulu sebelum menambah departemen.');
      return;
    }
    if (!newDeptName.trim() || !newDeptCode.trim()) {
      setErrorMsg('Nama departemen dan kode departemen wajib diisi.');
      return;
    }
    setOrgSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const deptId = makeSafeId('dept');
      const deptName = newDeptName.trim();
      const deptCode = newDeptCode.trim().toUpperCase();
      await createDepartment({
        id: deptId,
        divisionId: parentDiv.id,
        divisionName: parentDiv.name,
        name: deptName,
        code: deptCode,
        description: '',
      });
      await recordAuditLog({
        actor: user,
        action: 'Tambah Departemen',
        targetType: 'DEPARTMENT',
        targetId: deptId,
        targetLabel: `${deptCode} — ${deptName}`,
        divisionId: parentDiv.id,
        detail: `Ditambahkan di bawah divisi ${parentDiv.name}`,
        directory,
      });
      setNewDeptName('');
      setNewDeptCode('');
      setStatusMsg(`Departemen "${deptName}" berhasil ditambahkan.`);
      await onOrgUpdated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menambahkan departemen.');
    } finally {
      setOrgSaving(false);
    }
  };

  const startEditDivision = (div: Division) => {
    setEditingDivId(div.id);
    setEditDivName(div.name);
    setEditDivDesc(div.description || '');
    setEditDivLeadUid(div.leadUid || '');
    setEditDivQuestions((div.suggestedQuestions || []).join('\n'));
    setErrorMsg(null);
  };

  const handleSaveDivisionEdit = async (div: Division) => {
    if (!editDivName.trim()) {
      setErrorMsg('Nama divisi wajib diisi.');
      return;
    }
    setOrgSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const leadObj = directory.find((m) => m.uid === editDivLeadUid);
      const parsedQuestions = editDivQuestions
        .split('\n')
        .map((q) => q.trim())
        .filter(Boolean)
        .slice(0, 10);

      await createOrUpdateDivision({
        isNew: false,
        division: {
          id: div.id,
          name: editDivName.trim().slice(0, 120),
          code: div.code,
          description: editDivDesc.trim().slice(0, 500),
          leadUid: editDivLeadUid || '',
          leadName: leadObj?.displayName || '',
          suggestedQuestions: parsedQuestions,
        },
      });
      await recordAuditLog({
        actor: user,
        action: 'Ubah Divisi',
        targetType: 'DIVISION',
        targetId: div.id,
        targetLabel: `${div.code} — ${editDivName.trim()}`,
        divisionId: div.id,
        detail: `Memperbarui profil divisi & ${parsedQuestions.length} saran pertanyaan populer`,
        directory,
      });
      setEditingDivId(null);
      setStatusMsg(`Divisi "${editDivName.trim()}" berhasil diperbarui.`);
      await onOrgUpdated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memperbarui divisi.');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleDeleteDepartment = async (dept: Department) => {
    const usedBySops = sops.some((s) => s.departmentId === dept.id);
    if (usedBySops) {
      setErrorMsg(`Departemen "${dept.name}" masih digunakan oleh dokumen SOP dan tidak dapat dihapus.`);
      return;
    }
    setOrgSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await deleteDepartment(dept.id);
      await recordAuditLog({
        actor: user,
        action: 'Hapus Departemen',
        targetType: 'DEPARTMENT',
        targetId: dept.id,
        targetLabel: `${dept.code} — ${dept.name}`,
        divisionId: dept.divisionId,
        detail: `Menghapus departemen kosong dari divisi ${dept.divisionName}`,
        directory,
      });
      setStatusMsg(`Departemen "${dept.name}" berhasil dihapus.`);
      await onOrgUpdated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menghapus departemen.');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleDeleteDivision = async (div: Division) => {
    const hasDepts = departments.some((d) => d.divisionId === div.id);
    const hasSops = sops.some((s) => s.divisionId === div.id);
    if (hasDepts || hasSops) {
      setErrorMsg(`Divisi "${div.name}" masih memiliki departemen atau SOP dan tidak dapat dihapus.`);
      return;
    }
    setOrgSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      await deleteDivision(div.id);
      await recordAuditLog({
        actor: user,
        action: 'Hapus Divisi',
        targetType: 'DIVISION',
        targetId: div.id,
        targetLabel: `${div.code} — ${div.name}`,
        divisionId: div.id,
        detail: 'Menghapus divisi kosong',
        directory,
      });
      setStatusMsg(`Divisi "${div.name}" berhasil dihapus.`);
      await onOrgUpdated();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal menghapus divisi.');
    } finally {
      setOrgSaving(false);
    }
  };

  const handleUserUpdate = async (
    targetUser: UserProfile,
    newRole: UserRole,
    newDivisionId: string
  ) => {
    setUpdatingUserUid(targetUser.uid);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const divObj = divisions.find((d) => d.id === newDivisionId);
      const nextDivName = divObj?.name || 'Belum Ditetapkan';
      await updateUserRoleAndDivision({
        targetUid: targetUser.uid,
        role: newRole,
        divisionId: newDivisionId,
        divisionName: nextDivName,
        allSops: sops,
        directory,
        actor: user,
      });
      await recordAuditLog({
        actor: user,
        action: 'Ubah Hak Akses RBAC',
        targetType: 'USER',
        targetId: targetUser.uid,
        targetLabel: targetUser.displayName,
        divisionId: newDivisionId || 'general',
        detail: `Peran: ${newRole} · Divisi: ${nextDivName}`,
        directory,
      });
      setUsersList((prev) =>
        prev.map((u) =>
          u.uid === targetUser.uid
            ? {
                ...u,
                role: newRole,
                divisionId: newDivisionId,
                divisionName: nextDivName,
              }
            : u
        )
      );
      await onOrgUpdated();
      await loadAdminData();
      setStatusMsg(`Hak akses ${targetUser.displayName} berhasil diperbarui.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Gagal memperbarui hak akses pengguna.');
    } finally {
      setUpdatingUserUid(null);
    }
  };

  const canResolveLog = (log: QueryLog): boolean =>
    user.role === 'Super Admin' ||
    (user.role === 'Admin Divisi' && user.divisionId === log.divisionId);

  const handleMarkLogResolved = async (log: QueryLog) => {
    setResolvingLogId(log.id);
    setErrorMsg(null);
    try {
      const marker = log.primarySopId || 'resolved_manually';
      await markQueryGapResolved(log.id, marker);
      setLogs((prev) =>
        prev.map((item) => (item.id === log.id ? { ...item, resolvedAsSopId: marker } : item))
      );
      setStatusMsg('Laporan telah ditandai selesai ditindaklanjuti.');
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Gagal menandai laporan sebagai selesai.'
      );
    } finally {
      setResolvingLogId(null);
    }
  };

  const handleScanConflicts = async () => {
    setScanningConflicts(true);
    setConflictSummary(null);
    try {
      const freshToken = await getFreshIdToken(idToken);
      const lightweightSops = sops.map(stripSopMediaForAi);
      const data = await fetchApiJson<{
        summary: string;
        conflicts: SopConflictItem[];
      }>(
        '/api/ai/detect-conflicts',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${freshToken}`,
          },
          body: JSON.stringify({ sops: lightweightSops }),
        },
        'Gagal memindai konflik SOP.'
      );
      setConflictSummary(data.summary);
      setConflictItems(data.conflicts || []);
    } catch (err) {
      setConflictSummary(
        err instanceof Error ? err.message : 'Gagal menjalankan pemindaian konflik.'
      );
      setConflictItems([]);
    } finally {
      setScanningConflicts(false);
    }
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl font-semibold text-neutral-900 dark:text-[#ececec]">
            Dashboard Tata Kelola & Kualitas SOP
          </h1>
          <p className="text-xs text-neutral-600 dark:text-[#a0a0a0] mt-0.5">
            Pantau kesenjangan SOP dari pertanyaan yang tidak terjawab, evaluasi jawaban AI, audit log, dan kedaluwarsa dokumen.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start">
          <div className="flex flex-wrap items-center gap-1 p-1 bg-neutral-100 dark:bg-[#171717] border border-neutral-200 dark:border-white/[0.08] rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('analytics')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                subTab === 'analytics'
                  ? 'bg-white dark:bg-[#2f2f2f] text-neutral-900 dark:text-[#ececec] shadow-sm'
                  : 'text-neutral-600 dark:text-[#a0a0a0] hover:text-neutral-900 dark:hover:text-[#ececec]'
              }`}
            >
              Analitik SOP
            </button>
            <button
              type="button"
              onClick={() => setSubTab('audit')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                subTab === 'audit'
                  ? 'bg-white dark:bg-[#2f2f2f] text-neutral-900 dark:text-[#ececec] shadow-sm'
                  : 'text-neutral-600 dark:text-[#a0a0a0] hover:text-neutral-900 dark:hover:text-[#ececec]'
              }`}
            >
              Audit & Evaluasi AI
            </button>
            {user.role === 'Super Admin' && (
              <>
                <button
                  type="button"
                  onClick={() => setSubTab('org')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    subTab === 'org'
                      ? 'bg-white dark:bg-[#2f2f2f] text-neutral-900 dark:text-[#ececec] shadow-sm'
                      : 'text-neutral-600 dark:text-[#a0a0a0] hover:text-neutral-900 dark:hover:text-[#ececec]'
                  }`}
                >
                  Divisi & Departemen
                </button>
                <button
                  type="button"
                  onClick={() => setSubTab('users')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    subTab === 'users'
                      ? 'bg-white dark:bg-[#2f2f2f] text-neutral-900 dark:text-[#ececec] shadow-sm'
                      : 'text-neutral-600 dark:text-[#a0a0a0] hover:text-neutral-900 dark:hover:text-[#ececec]'
                  }`}
                >
                  Pengguna & Peran
                </button>
              </>
            )}
          </div>
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadAdminData()}
            title="Muat ulang data analitik & audit"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-neutral-800 dark:text-[#ececec] bg-white dark:bg-[#2f2f2f] border border-neutral-200 dark:border-white/[0.1] rounded-lg hover:bg-neutral-100 dark:hover:bg-[#3a3a3a] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Segarkan</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3 bg-rose-50 dark:bg-rose-950/45 border border-rose-200 dark:border-rose-800/70 rounded-lg text-xs text-rose-800 dark:text-rose-200 flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="text-rose-700 dark:text-rose-300 hover:underline cursor-pointer shrink-0"
          >
            Tutup
          </button>
        </div>
      )}

      {statusMsg && (
        <div className="p-3 bg-emerald-50 dark:bg-emerald-950/45 border border-emerald-200 dark:border-emerald-800/70 rounded-lg text-xs text-emerald-900 dark:text-emerald-200">
          {statusMsg}
        </div>
      )}

      {subTab === 'analytics' && (
        <div className="space-y-6">
          {/* 4 KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-4 space-y-1">
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Total SOP Terdaftar</span>
              <p className="font-display text-2xl font-bold text-neutral-900 dark:text-[#ececec] tabular-nums">
                {sops.length}
              </p>
              <span className="text-xs text-emerald-700 dark:text-emerald-400 font-medium tabular-nums">
                {sops.filter((s) => s.status === 'Disetujui').length} Disetujui AI
              </span>
            </div>
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-4 space-y-1">
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Penanya Aktif</span>
              <p className="font-display text-2xl font-bold text-neutral-900 dark:text-[#ececec] tabular-nums">
                {activeAskUsersCount}
              </p>
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                {logs.length} total pertanyaan
              </span>
            </div>
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-4 space-y-1">
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Tidak Terjawab AI</span>
              <p className="font-display text-2xl font-bold text-amber-700 dark:text-amber-400 tabular-nums">
                {unansweredLogs.length}
              </p>
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Indikator SOP belum ada</span>
            </div>
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-4 space-y-1">
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Perlu Perhatian SOP</span>
              <p className="font-display text-2xl font-bold text-rose-700 dark:text-rose-400 tabular-nums">
                {healthIssues.length + negativeFeedbackLogs.length}
              </p>
              <span className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Review lewat / feedback negatif</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Unanswered Questions */}
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
                  <HelpCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                  <span>Pertanyaan Tidak Terjawab AI</span>
                </h2>
                <div className="flex items-center gap-2">
                  {resolvedGapCount > 0 && (
                    <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                      {resolvedGapCount} ditindaklanjuti
                    </span>
                  )}
                  <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                    {unansweredLogs.length}
                  </span>
                  {unansweredLogs.length >= 2 && (
                    <button
                      type="button"
                      onClick={() => {
                        const groupedNotes = unansweredLogs
                          .slice(0, 6)
                          .map((l, i) => `${i + 1}. "${l.question}" (${l.divisionName})`)
                          .join('\n');
                        onDraftFromQuestion(
                          `Kumpulan pertanyaan karyawan yang belum memiliki SOP resmi:\n${groupedNotes}\n\nBuat draft SOP resmi terpadu yang menjawab seluruh poin di atas beserta alur, penanggung jawab, dan ketentuan yang berlaku.`,
                          unansweredLogs[0].question,
                          unansweredLogs.slice(0, 6).map((l) => l.id)
                        );
                      }}
                      className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-neutral-800 dark:text-[#ececec] bg-neutral-100 dark:bg-[#2f2f2f] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] border border-neutral-200 dark:border-white/[0.08] rounded-md cursor-pointer"
                    >
                      <PenTool className="w-3 h-3" />
                      <span>Gabungkan ({Math.min(unansweredLogs.length, 6)})</span>
                    </button>
                  )}
                </div>
              </div>

              {loading ? (
                <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">Memuat log pertanyaan...</p>
              ) : unansweredLogs.length === 0 ? (
                <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">
                  Belum ada pertanyaan aktif yang gagal dijawab oleh AI.
                </p>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                  {unansweredLogs.map((log) => (
                    <div key={log.id} className="py-3 flex flex-col sm:flex-row sm:items-start justify-between gap-2.5">
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-neutral-900 dark:text-[#ececec]">{log.question}</p>
                        <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">
                          {log.userName} · {log.divisionName}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() =>
                            onDraftFromQuestion(
                              `Pertanyaan karyawan yang belum terjawab:\n"${log.question}"\n\nBuat draft SOP resmi yang menjelaskan alur, penanggung jawab, dan ketentuan yang berlaku.`,
                              log.question,
                              [log.id]
                            )
                          }
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-neutral-900 dark:text-[#ececec] bg-neutral-100 dark:bg-[#2f2f2f] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] border border-neutral-200 dark:border-white/[0.08] rounded-md whitespace-nowrap cursor-pointer"
                        >
                          <PenTool className="w-3 h-3" />
                          <span>Buat Draft SOP</span>
                        </button>
                        {canResolveLog(log) && (
                          <button
                            type="button"
                            disabled={resolvingLogId === log.id}
                            onClick={() => handleMarkLogResolved(log)}
                            title="Tandai sudah tertangani oleh SOP yang ada"
                            className="inline-flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] bg-neutral-100 dark:bg-[#2a2a2a] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] rounded-md whitespace-nowrap cursor-pointer disabled:opacity-50"
                          >
                            {resolvingLogId === log.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Check className="w-3 h-3" />
                            )}
                            <span>Selesai</span>
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* SOP Health Issues: Overdue Review or Ownerless */}
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
                  <FileWarning className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                  <span>SOP Lewat Review / Tanpa Owner</span>
                </h2>
                <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                  {healthIssues.length}
                </span>
              </div>

              {healthIssues.length === 0 ? (
                <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">
                  Semua SOP memiliki pemilik proses aktif dan jadwal review masih berlaku.
                </p>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                  {healthIssues.map((sop) => {
                    const missingOwner = !sop.ownerUid || !sop.ownerName;
                    const pastReview =
                      sop.status === 'Disetujui' && sop.nextReviewDate < today;
                    return (
                      <div
                        key={sop.id}
                        onClick={() => onOpenSop(sop)}
                        className="py-3 flex items-center justify-between gap-3 hover:bg-neutral-50 dark:hover:bg-[#2f2f2f] rounded-md px-2 cursor-pointer transition-colors"
                      >
                        <div className="min-w-0 space-y-0.5">
                          <div className="text-xs text-neutral-500 dark:text-[#8e8e8e] flex items-center gap-2">
                            <span className="font-mono font-semibold text-neutral-700 dark:text-[#d4d4d4]">
                              {sop.docNumber}
                            </span>
                            <span>·</span>
                            <span>{sop.divisionName}</span>
                          </div>
                          <p className="text-sm font-medium text-neutral-900 dark:text-[#ececec] truncate">{sop.title}</p>
                        </div>
                        <div className="text-right text-xs shrink-0 space-y-0.5">
                          {pastReview && (
                            <span className="block text-rose-700 dark:text-rose-400 font-medium">
                              Lewat Review ({sop.nextReviewDate})
                            </span>
                          )}
                          {missingOwner && (
                            <span className="block text-amber-700 dark:text-amber-400 font-medium">
                              Belum Ada Owner
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Negative Feedback */}
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
                  <ThumbsDown className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                  <span>Umpan Balik Negatif Karyawan</span>
                </h2>
                <div className="flex items-center gap-2">
                  {resolvedFeedbackCount > 0 && (
                    <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">
                      {resolvedFeedbackCount} diperbaiki
                    </span>
                  )}
                  <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                    {negativeFeedbackLogs.length}
                  </span>
                </div>
              </div>

              {negativeFeedbackLogs.length === 0 ? (
                <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">
                  Belum ada jawaban aktif yang ditandai tidak akurat atau usang.
                </p>
              ) : (
                <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                  {negativeFeedbackLogs.map((log) => {
                    const matchedSop = sops.find((s) => s.id === log.primarySopId);
                    const relatedForSop = matchedSop
                      ? negativeFeedbackLogs.filter((item) => item.primarySopId === matchedSop.id)
                      : [log];
                    return (
                      <div key={log.id} className="py-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-medium text-rose-700 dark:text-rose-400 flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {log.feedback === 'outdated' ? 'SOP Sudah Usang' : 'Tidak Akurat'}
                          </span>
                          <span className="text-neutral-500 dark:text-[#8e8e8e]">{log.userName}</span>
                        </div>
                        <p className="text-sm font-medium text-neutral-900 dark:text-[#ececec]">{log.question}</p>
                        {log.feedbackNote && (
                          <p className="text-xs text-neutral-700 dark:text-rose-200 bg-rose-50/60 dark:bg-rose-950/40 border border-rose-100 dark:border-rose-900/60 rounded px-2.5 py-1.5">
                            Catatan pelapor: {log.feedbackNote}
                          </p>
                        )}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
                          {matchedSop ? (
                            <button
                              type="button"
                              onClick={() => onOpenSop(matchedSop)}
                              className="text-xs text-neutral-800 dark:text-[#d4d4d4] hover:text-neutral-950 dark:hover:text-white underline underline-offset-2 cursor-pointer text-left truncate max-w-full"
                            >
                              Buka SOP: {matchedSop.docNumber} — {matchedSop.title}
                            </button>
                          ) : (
                            <span className="text-[11px] text-neutral-400 dark:text-[#7a7a7a]">
                              Sumber SOP tidak tertaut
                            </span>
                          )}

                          <div className="flex items-center gap-1.5 shrink-0">
                            {matchedSop && (
                              <button
                                type="button"
                                onClick={() => onReviseSopFromFeedback(matchedSop, relatedForSop)}
                                className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-neutral-900 dark:text-[#ececec] bg-neutral-100 dark:bg-[#2f2f2f] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] border border-neutral-200 dark:border-white/[0.08] rounded-md cursor-pointer"
                              >
                                <PenTool className="w-3 h-3" />
                                <span>
                                  Revisi dengan AI
                                  {relatedForSop.length > 1 ? ` (${relatedForSop.length})` : ''}
                                </span>
                              </button>
                            )}
                            {canResolveLog(log) && (
                              <button
                                type="button"
                                disabled={resolvingLogId === log.id}
                                onClick={() => handleMarkLogResolved(log)}
                                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] bg-neutral-100 dark:bg-[#2a2a2a] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] rounded-md cursor-pointer disabled:opacity-50"
                              >
                                <Check className="w-3 h-3" />
                                <span>Selesai</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* SOPs per Division + Popular Questions */}
            <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-5">
              <div className="space-y-3">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                  Jumlah SOP per Divisi
                </h2>
                <div className="space-y-2.5">
                  {divisions.map((div) => {
                    const total = sops.filter((s) => s.divisionId === div.id).length;
                    const approved = sops.filter(
                      (s) => s.divisionId === div.id && s.status === 'Disetujui'
                    ).length;
                    const pct = sops.length > 0 ? Math.round((total / sops.length) * 100) : 0;

                    return (
                      <div key={div.id} className="space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-neutral-800 dark:text-[#d4d4d4]">{div.name}</span>
                          <span className="font-mono text-neutral-600 dark:text-[#a0a0a0] tabular-nums">
                            {approved} Disetujui / {total} Total
                          </span>
                        </div>
                        <div className="h-2 bg-neutral-100 dark:bg-[#171717] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-neutral-900 dark:bg-white rounded-full"
                            style={{ width: `${Math.max(pct, total > 0 ? 8 : 0)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 border-t border-neutral-200 dark:border-white/[0.08] space-y-2.5">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                  Pertanyaan Sering Diajukan per Divisi
                </h2>
                {popularByDivision.length === 0 ? (
                  <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">
                    Statistik pertanyaan akan muncul setelah karyawan bertanya di menu Tanya AI.
                  </p>
                ) : (
                  <div className="divide-y divide-neutral-200 dark:divide-white/[0.08] text-xs">
                    {popularByDivision.map((item, idx) => (
                      <div key={idx} className="py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-medium text-neutral-900 dark:text-[#ececec] truncate">{item.question}</p>
                          <span className="text-neutral-500 dark:text-[#8e8e8e]">{item.divisionName}</span>
                        </div>
                        <span className="font-mono font-semibold text-neutral-700 dark:text-[#c4c4c4] tabular-nums shrink-0">
                          {item.count}x
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Fase 2: Proactive AI Conflict Detection across Approved SOPs */}
          <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
                  <GitCompareArrows className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
                  <span>Pemindaian Konflik & Duplikasi Antar SOP (AI)</span>
                </h2>
                <p className="text-xs text-neutral-500 dark:text-[#8e8e8e] mt-0.5">
                  Periksa seluruh SOP berstatus Disetujui secara proaktif untuk mendeteksi perbedaan plafon biaya, SLA, atau kewenangan persetujuan.
                </p>
              </div>
              <button
                type="button"
                disabled={scanningConflicts}
                onClick={handleScanConflicts}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-lg disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {scanningConflicts ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <GitCompareArrows className="w-3.5 h-3.5" />
                )}
                <span>{scanningConflicts ? 'Memindai SOP...' : 'Pindai Konflik Antar SOP'}</span>
              </button>
            </div>

            {conflictSummary && (
              <div className="p-3.5 bg-neutral-50 dark:bg-[#2a2a2a] border border-neutral-200 dark:border-white/[0.08] rounded-lg text-xs text-neutral-800 dark:text-[#e0e0e0] space-y-3">
                <p className="font-medium">{conflictSummary}</p>
                {conflictItems.length > 0 && (
                  <div className="divide-y divide-neutral-200 dark:divide-white/[0.08] border-t border-neutral-200 dark:border-white/[0.08] pt-2">
                    {conflictItems.map((c, idx) => {
                      const sopA = sops.find((s) => s.id === c.sopAId);
                      const sopB = sops.find((s) => s.id === c.sopBId);
                      return (
                        <div key={idx} className="py-3 space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            {c.conflictType && (
                              <span className="px-2 py-0.5 text-[11px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-800 dark:text-rose-300 border border-rose-200 dark:border-rose-800/70 rounded">
                                {c.conflictType}
                              </span>
                            )}
                            <span className="font-semibold text-amber-800 dark:text-amber-300">
                              Tingkat: {c.severity}
                            </span>
                            <span className="text-neutral-400 dark:text-[#7a7a7a]">·</span>
                            {sopA ? (
                              <button
                                type="button"
                                onClick={() => onOpenSop(sopA)}
                                className="font-mono text-neutral-900 dark:text-[#ececec] underline underline-offset-2 cursor-pointer"
                              >
                                {c.sopADocNumber}
                              </button>
                            ) : (
                              <span className="font-mono">{c.sopADocNumber}</span>
                            )}
                            <span className="text-neutral-400 dark:text-[#7a7a7a]">vs</span>
                            {sopB ? (
                              <button
                                type="button"
                                onClick={() => onOpenSop(sopB)}
                                className="font-mono text-neutral-900 dark:text-[#ececec] underline underline-offset-2 cursor-pointer"
                              >
                                {c.sopBDocNumber}
                              </button>
                            ) : (
                              <span className="font-mono">{c.sopBDocNumber}</span>
                            )}
                          </div>
                          <p className="text-neutral-800 dark:text-[#e0e0e0]">{c.description}</p>
                          <p className="text-neutral-600 dark:text-[#a0a0a0]">
                            <strong>Rekomendasi:</strong> {c.recommendation}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Audit Log & Evaluasi Jawaban AI */}
      {subTab === 'audit' && (
        <div className="space-y-6">
          {/* Log Evaluasi Jawaban AI */}
          <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200 dark:border-white/[0.08] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                  Log Evaluasi Jawaban AI (Pertanyaan, Sumber & Umpan Balik)
                </h2>
              </div>
              <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                {logs.length} entri
              </span>
            </div>

            {loading ? (
              <p className="p-5 text-xs text-neutral-500 dark:text-[#8e8e8e]">Memuat riwayat evaluasi AI...</p>
            ) : logs.length === 0 ? (
              <p className="p-5 text-xs text-neutral-500 dark:text-[#8e8e8e]">
                Belum ada riwayat tanya-jawab AI yang tercatat.
              </p>
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                {logs.map((log) => {
                  const fb = feedbackLabel(log.feedback);
                  const matchedSop = sops.find((s) => s.id === log.primarySopId);
                  return (
                    <div
                      key={log.id}
                      className="px-5 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-2.5 text-xs"
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="text-sm font-medium text-neutral-900 dark:text-[#ececec]">{log.question}</p>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-neutral-500 dark:text-[#8e8e8e]">
                          <span>{formatTimestamp(log.createdAt)}</span>
                          <span>·</span>
                          <span>{log.userName}</span>
                          <span>·</span>
                          <span>{log.divisionName}</span>
                          <span>·</span>
                          {log.primarySopDocNumber ? (
                            matchedSop ? (
                              <button
                                type="button"
                                onClick={() => onOpenSop(matchedSop)}
                                className="text-neutral-800 dark:text-[#d4d4d4] hover:text-neutral-950 dark:hover:text-white underline underline-offset-2 font-medium cursor-pointer"
                              >
                                Sumber: {log.primarySopDocNumber} — {log.primarySopTitle}
                              </button>
                            ) : (
                              <span className="text-neutral-700 dark:text-[#c4c4c4]">
                                Sumber: {log.primarySopDocNumber} — {log.primarySopTitle}
                              </span>
                            )
                          ) : (
                            <span className="text-amber-700 dark:text-amber-400">Tidak ada SOP yang cocok</span>
                          )}
                        </div>
                        {log.feedbackNote && (
                          <p className="text-xs text-neutral-600 dark:text-[#a0a0a0]">Catatan: {log.feedbackNote}</p>
                        )}
                      </div>
                      <div className="shrink-0 flex items-center gap-3 md:text-right">
                        <span className={fb.tone}>{fb.text}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Audit Log Aktivitas Sistem */}
          <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200 dark:border-white/[0.08] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                  Audit Log Aktivitas Dokumen & Hak Akses
                </h2>
              </div>
              <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                {auditLogs.length} catatan
              </span>
            </div>

            {loading ? (
              <p className="p-5 text-xs text-neutral-500 dark:text-[#8e8e8e]">Memuat catatan audit...</p>
            ) : auditLogs.length === 0 ? (
              <p className="p-5 text-xs text-neutral-500 dark:text-[#8e8e8e]">
                Belum ada aktivitas perubahan SOP, organisasi, atau hak akses yang tercatat.
              </p>
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                {auditLogs.map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-semibold text-neutral-900 dark:text-[#ececec]">{item.action}</span>
                        <span className="text-neutral-400 dark:text-[#7a7a7a]">·</span>
                        <span className="font-mono text-neutral-700 dark:text-[#c4c4c4]">{item.targetType}</span>
                        <span className="text-neutral-800 dark:text-[#e0e0e0] truncate">{item.targetLabel}</span>
                      </div>
                      <p className="text-neutral-500 dark:text-[#8e8e8e]">
                        Oleh {item.actorName}
                        {item.detail ? ` — ${item.detail}` : ''}
                      </p>
                    </div>
                    <span className="font-mono text-neutral-500 dark:text-[#8e8e8e] tabular-nums shrink-0">
                      {formatTimestamp(item.createdAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Super Admin: Organization Management */}
      {subTab === 'org' && user.role === 'Super Admin' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <form
            onSubmit={handleCreateDivision}
            className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4"
          >
            <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
              <Building2 className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
              <span>Tambah Divisi Baru</span>
            </h2>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                  Nama Divisi
                </label>
                <input
                  type="text"
                  value={newDivName}
                  onChange={(e) => setNewDivName(e.target.value)}
                  placeholder="Contoh: Pemasaran & Penjualan"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] border border-neutral-200 dark:border-white/[0.12] rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                  Kode
                </label>
                <input
                  type="text"
                  value={newDivCode}
                  onChange={(e) => setNewDivCode(e.target.value)}
                  placeholder="MKT"
                  className="w-full px-3 py-2 text-sm font-mono uppercase bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] border border-neutral-200 dark:border-white/[0.12] rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                Deskripsi
              </label>
              <input
                type="text"
                value={newDivDesc}
                onChange={(e) => setNewDivDesc(e.target.value)}
                placeholder="Cakupan operasional divisi"
                className="w-full px-3 py-2 text-sm bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] border border-neutral-200 dark:border-white/[0.12] rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
              />
            </div>
            <button
              type="submit"
              disabled={orgSaving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-lg disabled:opacity-60 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{orgSaving ? 'Menyimpan...' : 'Simpan Divisi'}</span>
            </button>
          </form>

          <form
            onSubmit={handleCreateDepartment}
            className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 space-y-4"
          >
            <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
              <Building2 className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
              <span>Tambah Departemen</span>
            </h2>
            <div>
              <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                Divisi Induk
              </label>
              <select
                value={newDeptDivId}
                onChange={(e) => setNewDeptDivId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-white/[0.12] rounded-lg bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
              >
                {divisions.length === 0 ? (
                  <option value="">Belum ada divisi</option>
                ) : (
                  divisions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                  Nama Departemen
                </label>
                <input
                  type="text"
                  value={newDeptName}
                  onChange={(e) => setNewDeptName(e.target.value)}
                  placeholder="Contoh: Digital Marketing"
                  className="w-full px-3 py-2 text-sm bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] border border-neutral-200 dark:border-white/[0.12] rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                  Kode
                </label>
                <input
                  type="text"
                  value={newDeptCode}
                  onChange={(e) => setNewDeptCode(e.target.value)}
                  placeholder="MKT-DIG"
                  className="w-full px-3 py-2 text-sm font-mono uppercase bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] border border-neutral-200 dark:border-white/[0.12] rounded-lg focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={orgSaving || divisions.length === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-lg disabled:opacity-60 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{orgSaving ? 'Menyimpan...' : 'Simpan Departemen'}</span>
            </button>
          </form>

          {/* Existing Divisions & Departments List */}
          <div className="lg:col-span-2 bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-200 dark:border-white/[0.08] flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                Daftar Divisi, Departemen & Saran Pertanyaan Chat
              </h2>
              <span className="font-mono text-xs text-neutral-500 dark:text-[#8e8e8e] tabular-nums">
                {divisions.length} divisi · {departments.length} departemen
              </span>
            </div>

            {divisions.length === 0 ? (
              <p className="p-5 text-xs text-neutral-500 dark:text-[#8e8e8e]">
                Belum ada divisi terdaftar. Tambahkan divisi di atas atau muat data SOP contoh.
              </p>
            ) : (
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
                {divisions.map((div) => {
                  const divDepts = departments.filter((dp) => dp.divisionId === div.id);
                  const divSopCount = sops.filter((s) => s.divisionId === div.id).length;
                  const isEditing = editingDivId === div.id;

                  return (
                    <div key={div.id} className="p-5 space-y-3">
                      {isEditing ? (
                        <div className="space-y-3 bg-neutral-50 dark:bg-[#2a2a2a] border border-neutral-200 dark:border-white/[0.08] rounded-lg p-4">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div>
                              <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                                Nama Divisi ({div.code})
                              </label>
                              <input
                                type="text"
                                value={editDivName}
                                onChange={(e) => setEditDivName(e.target.value)}
                                className="w-full px-3 py-1.5 text-sm border border-neutral-200 dark:border-white/[0.12] rounded-md bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                                Kepala / PIC Divisi
                              </label>
                              <select
                                value={editDivLeadUid}
                                onChange={(e) => setEditDivLeadUid(e.target.value)}
                                className="w-full px-3 py-1.5 text-sm border border-neutral-200 dark:border-white/[0.12] rounded-md bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                              >
                                <option value="">-- Belum ditetapkan --</option>
                                {directory.map((m) => (
                                  <option key={m.uid} value={m.uid}>
                                    {m.displayName} ({m.role})
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                              Deskripsi Divisi
                            </label>
                            <input
                              type="text"
                              value={editDivDesc}
                              onChange={(e) => setEditDivDesc(e.target.value)}
                              className="w-full px-3 py-1.5 text-sm border border-neutral-200 dark:border-white/[0.12] rounded-md bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-neutral-700 dark:text-[#c4c4c4] mb-1">
                              Saran Pertanyaan Populer (1 baris per pertanyaan, maks. 10)
                            </label>
                            <textarea
                              rows={3}
                              value={editDivQuestions}
                              onChange={(e) => setEditDivQuestions(e.target.value)}
                              placeholder="Berapa plafon hotel perjalanan dinas luar kota?&#10;Kapan batas waktu pengajuan reimbursement?"
                              className="w-full px-3 py-1.5 text-xs border border-neutral-200 dark:border-white/[0.12] rounded-md bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] placeholder:text-neutral-400 dark:placeholder:text-[#7a7a7a] focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                            />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingDivId(null)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs text-neutral-700 dark:text-[#c4c4c4] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] rounded-md cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                              <span>Batal</span>
                            </button>
                            <button
                              type="button"
                              disabled={orgSaving}
                              onClick={() => handleSaveDivisionEdit(div)}
                              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-md cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              <span>Simpan Perubahan</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2 text-xs">
                              <span className="font-mono font-semibold text-neutral-700 dark:text-[#d4d4d4]">
                                {div.code}
                              </span>
                              <span className="text-neutral-300 dark:text-[#525252]">·</span>
                              <span className="text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                                {div.name}
                              </span>
                              <span className="text-neutral-300 dark:text-[#525252]">·</span>
                              <span className="text-neutral-500 dark:text-[#8e8e8e] font-mono tabular-nums">
                                {divSopCount} SOP
                              </span>
                            </div>
                            <p className="text-xs text-neutral-600 dark:text-[#a0a0a0]">
                              {div.description || 'Belum ada deskripsi'} · PIC:{' '}
                              <strong className="text-neutral-900 dark:text-[#ececec]">
                                {div.leadName || 'Belum ditetapkan'}
                              </strong>
                            </p>
                            {(div.suggestedQuestions || []).length > 0 && (
                              <p className="text-[11px] text-neutral-500 dark:text-[#8e8e8e]">
                                Saran pertanyaan chat ({div.suggestedQuestions.length}):{' '}
                                {div.suggestedQuestions.join(' · ')}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => startEditDivision(div)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-neutral-800 dark:text-[#ececec] bg-neutral-100 dark:bg-[#2f2f2f] hover:bg-neutral-200 dark:hover:bg-[#3a3a3a] border border-neutral-200 dark:border-white/[0.08] rounded-md cursor-pointer"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>
                            <button
                              type="button"
                              disabled={orgSaving || divDepts.length > 0 || divSopCount > 0}
                              onClick={() => handleDeleteDivision(div)}
                              title={
                                divDepts.length > 0 || divSopCount > 0
                                  ? 'Hapus semua departemen & SOP di divisi ini terlebih dahulu'
                                  : 'Hapus divisi kosong'
                              }
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-950/50 hover:bg-rose-100 dark:hover:bg-rose-900/60 disabled:opacity-40 disabled:cursor-not-allowed rounded-md cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Hapus</span>
                            </button>
                          </div>
                        </div>
                      )}

                      {divDepts.length > 0 && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          {divDepts.map((dept) => {
                            const deptSops = sops.filter((s) => s.departmentId === dept.id).length;
                            return (
                              <div
                                key={dept.id}
                                className="inline-flex items-center gap-2 px-2.5 py-1 bg-neutral-50 dark:bg-[#2a2a2a] border border-neutral-200 dark:border-white/[0.08] rounded-md text-xs text-neutral-700 dark:text-[#c4c4c4]"
                              >
                                <span className="font-mono text-neutral-500 dark:text-[#8e8e8e]">
                                  {dept.code}
                                </span>
                                <span className="font-medium text-neutral-900 dark:text-[#ececec]">
                                  {dept.name}
                                </span>
                                <span className="font-mono text-[11px] text-neutral-400 dark:text-[#7a7a7a]">
                                  ({deptSops})
                                </span>
                                {deptSops === 0 && (
                                  <button
                                    type="button"
                                    disabled={orgSaving}
                                    onClick={() => handleDeleteDepartment(dept)}
                                    title="Hapus departemen kosong"
                                    className="text-neutral-400 dark:text-[#7a7a7a] hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer"
                                  >
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {onSeedDemo && (
            <div className="lg:col-span-2 bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec] flex items-center gap-2">
                  <Database className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
                  <span>Data Uji Coba Standar Perusahaan (UAT)</span>
                </h2>
                <p className="text-xs text-neutral-600 dark:text-[#a0a0a0]">
                  Muat atau sinkronkan ulang 4 divisi, 5 departemen, dan 8 contoh SOP (Keuangan, Pengadaan, HR, IT — termasuk kasus uji status Review dan deteksi konflik) beserta indeks vektor AI-nya.
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(seedingLabel)}
                onClick={onSeedDemo}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-neutral-900 hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200 rounded-lg disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {seedingLabel ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Database className="w-3.5 h-3.5" />
                )}
                <span>{seedingLabel || 'Muat / Sinkronkan 8 SOP Contoh'}</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Super Admin: User & Role Management */}
      {subTab === 'users' && user.role === 'Super Admin' && (
        <div className="bg-white dark:bg-[#262626] border border-neutral-200 dark:border-white/[0.08] rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-200 dark:border-white/[0.08] flex items-center gap-2">
            <Users className="w-4 h-4 text-neutral-600 dark:text-[#a0a0a0]" />
            <h2 className="font-display text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
              Manajemen Pengguna & Hak Akses RBAC
            </h2>
          </div>
          <div className="divide-y divide-neutral-200 dark:divide-white/[0.08]">
            {usersList.map((u) => (
              <div
                key={u.uid}
                className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
              >
                <div>
                  <p className="text-sm font-semibold text-neutral-900 dark:text-[#ececec]">
                    {u.displayName}
                  </p>
                  <p className="text-xs text-neutral-500 dark:text-[#8e8e8e]">{u.email}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={u.role}
                    disabled={updatingUserUid === u.uid}
                    onChange={(e) =>
                      handleUserUpdate(u, e.target.value as UserRole, u.divisionId)
                    }
                    className="px-3 py-1.5 text-xs border border-neutral-200 dark:border-white/[0.12] rounded-lg bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                  >
                    <option value="Super Admin">Super Admin</option>
                    <option value="Admin Divisi">Admin Divisi</option>
                    <option value="Penulis">Penulis</option>
                    <option value="Karyawan">Karyawan</option>
                  </select>
                  <select
                    value={u.divisionId}
                    disabled={updatingUserUid === u.uid}
                    onChange={(e) => handleUserUpdate(u, u.role, e.target.value)}
                    className="px-3 py-1.5 text-xs border border-neutral-200 dark:border-white/[0.12] rounded-lg bg-white dark:bg-[#1e1e1e] text-neutral-900 dark:text-[#ececec] disabled:opacity-60 focus:outline-none focus:ring-2 focus:ring-neutral-900/15 dark:focus:ring-white/20"
                  >
                    <option value="">Belum Ditetapkan</option>
                    {divisions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
