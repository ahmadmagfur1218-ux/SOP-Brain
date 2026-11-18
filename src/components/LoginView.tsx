import React, { useState } from 'react';
import { BookOpenCheck, ShieldCheck, MessageSquareText, ArrowRight, FileStack } from 'lucide-react';
import { ThemeToggleButton } from '../lib/theme';

interface LoginViewProps {
  onSignIn: () => Promise<void>;
  loading: boolean;
  error: string | null;
}

export const LoginView: React.FC<LoginViewProps> = ({ onSignIn, loading, error }) => {
  const [imgFailed, setImgFailed] = useState(false);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            SOP Brain
          </span>
          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
            <a href="#kapabilitas" className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              Pusat SOP
            </a>
            <a href="#tanya-ai" className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              AI Tanya-Jawab
            </a>
            <a href="#tata-kelola" className="hover:text-slate-900 dark:hover:text-white transition-colors whitespace-nowrap shrink-0">
              Tata Kelola
            </a>
          </nav>
          <button
            type="button"
            onClick={onSignIn}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {loading ? 'Memproses...' : 'Masuk Akun'}
          </button>
        </div>
      </header>

      <main className="flex-1 flex items-center py-12 px-6">
        <div className="max-w-6xl mx-auto w-full grid grid-cols-1 lg:grid-cols-12 gap-10 items-stretch">
          <div className="lg:col-span-6 flex flex-col justify-center space-y-6">
            <p className="text-xs font-medium tracking-wide text-sky-700 dark:text-sky-400">
              Satu sumber kebenaran operasional perusahaan
            </p>
            <h1
              className="font-display text-3xl sm:text-4xl font-bold text-slate-900 dark:text-slate-100 tracking-tight leading-tight"
              style={{ textWrap: 'balance' }}
            >
              Seluruh SOP perusahaan di satu tempat, siap dijawab AI secara akurat.
            </h1>
            <p className="text-base text-slate-600 dark:text-slate-300 leading-relaxed max-w-xl">
              Karyawan tidak perlu lagi mencari file Word, PDF, atau bertanya berulang ke atasan.
              Ajukan pertanyaan dalam Bahasa Indonesia dan dapatkan langkah kerja resmi lengkap dengan sumber dokumen, nomor, dan versinya.
            </p>

            {error && (
              <div className="p-3.5 bg-rose-50 dark:bg-rose-950/50 border border-rose-200 dark:border-rose-800/70 rounded-lg text-sm text-rose-800 dark:text-rose-200">
                {error}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-4 pt-2">
              <button
                type="button"
                onClick={onSignIn}
                disabled={loading}
                className="inline-flex items-center gap-2.5 px-5 py-3 text-sm font-semibold text-white bg-sky-600 rounded-lg hover:bg-sky-700 disabled:opacity-60 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>{loading ? 'Menghubungkan ke Google...' : 'Masuk dengan Google'}</span>
                <ArrowRight className="w-4 h-4" />
              </button>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Akses berbasis peran · Hanya SOP berstatus Disetujui yang dijawab AI
              </span>
            </div>

            <div id="kapabilitas" className="grid grid-cols-1 sm:grid-cols-3 gap-6 pt-6 border-t border-slate-200 dark:border-slate-800">
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100 font-medium text-sm">
                  <MessageSquareText className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                  <span>Tanya-Jawab RAG</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Pencarian semantik dan kata kunci dengan sitasi bagian SOP dan deteksi konflik aturan.
                </p>
              </div>
              <div id="tanya-ai" className="space-y-1.5">
                <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100 font-medium text-sm">
                  <FileStack className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                  <span>Impor PDF, Word, Excel</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Rapikan dokumen lama atau catatan kasar menjadi struktur SOP standar siap review.
                </p>
              </div>
              <div id="tata-kelola" className="space-y-1.5">
                <div className="flex items-center gap-2 text-slate-900 dark:text-slate-100 font-medium text-sm">
                  <ShieldCheck className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                  <span>Sadar Hak Akses</span>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                  Filter level Umum, Per Divisi, dan Rahasia langsung di level kueri database.
                </p>
              </div>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="h-full min-h-[340px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden flex flex-col">
              {!imgFailed ? (
                <img
                  src="/src/assets/images/login_sop_workspace_1794881191359.jpg"
                  alt="Ruang kerja dokumentasi operasional perusahaan"
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="w-full h-72 lg:h-full object-cover"
                />
              ) : (
                <div className="flex-1 bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-900 flex flex-col items-center justify-center p-8 text-center">
                  <BookOpenCheck className="w-10 h-10 text-sky-700 dark:text-sky-400 mb-3" />
                  <p className="font-display font-semibold text-slate-900 dark:text-slate-100">Repositori SOP Terpusat</p>
                  <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Divisi · Departemen · Versioning · Audit Review</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 py-3 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 text-xs text-slate-500 dark:text-slate-400">
          <span>SOP Brain · Pusat Pengetahuan &amp; Prosedur Operasional</span>
          <ThemeToggleButton showLabelOnMobile />
        </div>
      </footer>
    </div>
  );
};
