import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  FolderTree,
  Lock,
  Plus,
  Search,
} from 'lucide-react';
import type { Department, Division, SopDocument, SopStatus, UserProfile } from '../types/sop';

interface SopRepositoryViewProps {
  user: UserProfile;
  divisions: Division[];
  departments: Department[];
  sops: SopDocument[];
  onSelectSop: (sop: SopDocument, mode: 'read' | 'edit') => void;
  onCreateNewSop: () => void;
}

export const SopRepositoryView: React.FC<SopRepositoryViewProps> = ({
  user,
  divisions,
  departments,
  sops,
  onSelectSop,
  onCreateNewSop,
}) => {
  const [selectedDivId, setSelectedDivId] = useState<string>('all');
  const [selectedDeptId, setSelectedDeptId] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<'Semua' | SopStatus>('Semua');
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const canCreate = user.role !== 'Karyawan';
  const today = new Date().toISOString().slice(0, 10);

  const filteredSops = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sops
      .filter((sop) => {
        if (selectedDivId !== 'all' && sop.divisionId !== selectedDivId) return false;
        if (selectedDeptId !== 'all' && sop.departmentId !== selectedDeptId) return false;
        if (statusFilter !== 'Semua' && sop.status !== statusFilter) return false;
        if (onlyAttention) {
          const missingOwner = !sop.ownerUid || !sop.ownerName;
          const pastReview =
            sop.status === 'Disetujui' && Boolean(sop.nextReviewDate) && sop.nextReviewDate < today;
          if (!missingOwner && !pastReview) return false;
        }
        if (q) {
          const haystack = [
            sop.docNumber,
            sop.title,
            sop.purpose,
            sop.scope,
            sop.ownerName,
            sop.divisionName,
            sop.departmentName,
            ...sop.sections.map((s) => `${s.title} ${s.content}`),
          ]
            .join(' ')
            .toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => a.docNumber.localeCompare(b.docNumber));
  }, [sops, selectedDivId, selectedDeptId, statusFilter, onlyAttention, searchQuery, today]);

  const hasActiveFilter =
    selectedDivId !== 'all' ||
    selectedDeptId !== 'all' ||
    statusFilter !== 'Semua' ||
    onlyAttention ||
    Boolean(searchQuery.trim());

  const resetFilters = () => {
    setSelectedDivId('all');
    setSelectedDeptId('all');
    setStatusFilter('Semua');
    setOnlyAttention(false);
    setSearchQuery('');
  };

  const statusIcon = (st: SopStatus) => {
    if (st === 'Disetujui') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />;
    if (st === 'Review') return <Clock className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />;
    return <FileText className="w-3.5 h-3.5 text-slate-400 dark:text-slate-500 shrink-0" />;
  };

  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex flex-col lg:flex-row bg-slate-50 dark:bg-slate-950">
      {/* Left Structure Tree: Divisi > Departemen */}
      <aside className="lg:w-72 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4 space-y-4 shrink-0">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <FolderTree className="w-4 h-4 text-sky-600 dark:text-sky-400" />
            <span>Struktur Organisasi</span>
          </h2>
          <span className="font-mono text-xs text-slate-500 dark:text-slate-400 tabular-nums">{sops.length} SOP</span>
        </div>

        <div className="space-y-1">
          <button
            type="button"
            onClick={() => {
              setSelectedDivId('all');
              setSelectedDeptId('all');
            }}
            className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors cursor-pointer ${
              selectedDivId === 'all'
                ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 font-semibold'
                : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-900'
            }`}
          >
            <span>Semua Divisi</span>
            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">{sops.length}</span>
          </button>

          {divisions.map((div) => {
            const divDepts = departments.filter((d) => d.divisionId === div.id);
            const divCount = sops.filter((s) => s.divisionId === div.id).length;
            const isDivActive = selectedDivId === div.id;

            return (
              <div key={div.id} className="space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedDivId(div.id);
                    setSelectedDeptId('all');
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-xs rounded-lg transition-colors cursor-pointer ${
                    isDivActive && selectedDeptId === 'all'
                      ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-900 dark:text-sky-200 font-semibold'
                      : 'text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-900'
                  }`}
                >
                  <span className="truncate text-left">{div.name}</span>
                  <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400 shrink-0 ml-2">
                    {divCount}
                  </span>
                </button>

                {divDepts.map((dept) => {
                  const deptCount = sops.filter((s) => s.departmentId === dept.id).length;
                  const isDeptActive = selectedDeptId === dept.id;
                  return (
                    <button
                      key={dept.id}
                      type="button"
                      onClick={() => {
                        setSelectedDivId(div.id);
                        setSelectedDeptId(dept.id);
                      }}
                      className={`w-full flex items-center justify-between pl-6 pr-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer ${
                        isDeptActive
                          ? 'bg-sky-50 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300 font-medium'
                          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-900'
                      }`}
                    >
                      <span className="truncate text-left flex items-center gap-1.5">
                        <ChevronRight className="w-3 h-3 text-slate-400 dark:text-slate-500 shrink-0" />
                        <span className="truncate">{dept.name}</span>
                      </span>
                      <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500 shrink-0 ml-2">
                        {deptCount}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </aside>

      {/* Main Repository List */}
      <section className="flex-1 p-4 sm:p-6 lg:p-8 space-y-5 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl font-bold text-slate-900 dark:text-slate-100">
              Pusat Repositori SOP
            </h1>
            <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">
              Hanya dokumen berstatus <strong>Disetujui</strong> yang diindeks dan dijawab oleh AI.
            </p>
          </div>
          {canCreate && (
            <button
              type="button"
              onClick={onCreateNewSop}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-sky-600 rounded-lg hover:bg-sky-700 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Buat SOP Baru</span>
            </button>
          )}
        </div>

        {/* Search & Status Filter Bar */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 dark:text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Cari nomor SOP, judul, langkah, atau pemilik proses..."
              className="w-full pl-9 pr-4 py-2 text-sm bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 border border-slate-200 dark:border-slate-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-sky-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg overflow-x-auto">
              {(['Semua', 'Disetujui', 'Review', 'Draft', 'Arsip'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    statusFilter === st
                      ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-slate-100 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setOnlyAttention((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                onlyAttention
                  ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                  : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              Perlu Review / Tanpa Owner
            </button>
          </div>
        </div>

        {/* High-Density SOP Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          {filteredSops.length === 0 ? (
            <div className="p-10 text-center space-y-3">
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                Tidak ada dokumen SOP yang cocok dengan filter Anda.
              </p>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Ubah kata kunci pencarian atau pilih divisi lain di sebelah kiri.
              </p>
              {hasActiveFilter && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="inline-flex items-center px-3.5 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/60 hover:bg-sky-100 dark:hover:bg-sky-900/60 rounded-md transition-colors cursor-pointer"
                >
                  Reset Filter
                </button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {filteredSops.map((sop) => {
                const isOverdue =
                  sop.status === 'Disetujui' &&
                  sop.nextReviewDate &&
                  sop.nextReviewDate < new Date().toISOString().slice(0, 10);

                return (
                  <div
                    key={sop.id}
                    onClick={() => onSelectSop(sop, 'read')}
                    className="p-4 hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 cursor-pointer"
                  >
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-mono font-semibold text-sky-700 dark:text-sky-400">
                          {sop.docNumber}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">v{sop.version}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {sop.divisionName} / {sop.departmentName}
                        </span>
                        {sop.accessLevel !== 'Umum' && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="inline-flex items-center gap-1 text-slate-700 dark:text-slate-300 font-medium">
                              <Lock className="w-3 h-3" />
                              {sop.accessLevel}
                            </span>
                          </>
                        )}
                      </div>
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                        {sop.title}
                      </h3>
                      <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-1">{sop.purpose}</p>
                    </div>

                    <div className="flex sm:flex-col items-center sm:items-end justify-between gap-1.5 shrink-0 text-xs">
                      <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
                        {statusIcon(sop.status)}
                        <span>{sop.status}</span>
                      </div>
                      <div className="text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                        {sop.ownerName ? sop.ownerName : 'Tanpa Owner'}
                        {isOverdue && (
                          <span className="ml-2 text-rose-700 dark:text-rose-400 font-sans font-medium">
                            · Lewat Review
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
