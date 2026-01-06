'use client';

import { supabase } from '@/lib/supabase';
import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, Wifi, AlertTriangle, Zap, CheckCircle2, XCircle, FileText, ShoppingCart, Eye, Clock, XOctagon } from 'lucide-react';

type StateStatus = {
  estado: string;
  modelo: 'NFe' | 'NFCe';
  autorizacao: string;
  retorno_autorizacao: string;
  inutilizacao: string;
  consulta: string;
  status_servico: string;
  created_at?: string;
};

type HistoryPoint = {
  time: string;
  fullDate: string;
  status: StateStatus;
};

const ESTADOS = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'
];

export default function Home() {
  const [selectedUF, setSelectedUF] = useState('PR');
  const [selectedModel, setSelectedModel] = useState<'NFe' | 'NFCe'>('NFe');

  const [currentData, setCurrentData] = useState<StateStatus | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [visitCount, setVisitCount] = useState<number>(0);

  // Controle de "Dados Velhos"
  const [isStale, setIsStale] = useState(false);
  const [minutesAgo, setMinutesAgo] = useState(0);

  // Busca visitas
  useEffect(() => {
    fetch('/api/visit', { cache: 'no-store' })
      .then(res => res.json())
      .then(json => json.count && setVisitCount(json.count))
      .catch(console.error);
  }, []);

  // Verifica se os dados estão velhos (mais de 5 min)
  useEffect(() => {
    if (!currentData?.created_at) return;

    const checkStale = () => {
      const lastDate = new Date(currentData.created_at!);
      const now = new Date();
      const diffMs = now.getTime() - lastDate.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      setMinutesAgo(diffMins);
      // Se faz mais de 5 minutos que não atualiza, considera obsoleto
      setIsStale(diffMins >= 5);
    };

    checkStale();
    const timer = setInterval(checkStale, 15000); // Re-checa a cada 15s para ser ágil
    return () => clearInterval(timer);
  }, [currentData]);

  // Busca Histórico
  const fetchHistory = async (uf: string, modelo: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/history?uf=${uf}&modelo=${modelo}`, { cache: 'no-store' });
      const json = await res.json();

      if (Array.isArray(json) && json.length > 0) {
        const latest = json[0];
        setCurrentData(latest);

        const formattedHistory = json.map((item: any) => ({
          time: new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          fullDate: new Date(item.created_at).toLocaleString('pt-BR'),
          status: item
        }));

        setHistory(formattedHistory);
      } else {
        // Se não tem histórico, tenta forçar update
        updateRemoteStatus();
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const updateRemoteStatus = async () => {
    try {
      console.log("Forçando atualização remota...");
      await fetch('/api/status', { cache: 'no-store' });
    } catch (err) {
      console.error("Erro ao atualizar status:", err);
    }
  };

  // Efeito Principal
  useEffect(() => {
    setHistory([]);
    fetchHistory(selectedUF, selectedModel);

    // Tenta atualizar a cada 15s (Frequência Alta)
    const interval = setInterval(() => { updateRemoteStatus(); }, 15000);

    // Realtime Listener
    const channel = supabase
      .channel('sefaz-realtime-model')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'sefaz_logs',
          filter: `estado=eq.${selectedUF}`
        },
        (payload) => {
          const newLog = payload.new as StateStatus;

          if (newLog.modelo === selectedModel) {
            console.log("⚡ Realtime Update recebido!");
            setCurrentData(newLog);

            // Reseta status de 'obsoleto' pois acabou de chegar dado novo
            setIsStale(false);
            setMinutesAgo(0);

            setHistory((prev) => {
              const newPoint = {
                time: new Date(newLog.created_at || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
                fullDate: new Date(newLog.created_at || Date.now()).toLocaleString('pt-BR'),
                status: newLog
              };
              return [newPoint, ...prev].slice(0, 60);
            });
          }
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [selectedUF, selectedModel]);

  // Lógica do Status Geral do Header
  const headerStatus = useMemo(() => {
    if (!currentData) return { color: 'text-slate-500', icon: <Wifi className="w-3 h-3" />, text: 'Carregando...' };

    // PRIORIDADE 1: SEFAZ OFFLINE (Vermelho)
    if (currentData.autorizacao === 'offline' || currentData.status_servico === 'offline') {
      return { color: 'text-rose-500 font-bold', icon: <XOctagon className="w-3 h-3" />, text: 'SEFAZ INDISPONÍVEL' };
    }
    // PRIORIDADE 2: DADOS ANTIGOS (Laranja)
    if (isStale) {
      return { color: 'text-amber-500 font-bold', icon: <AlertTriangle className="w-3 h-3" />, text: 'Conexão Instável / Dados Antigos' };
    }
    // PRIORIDADE 3: INSTÁVEL (Amarelo)
    if (currentData.autorizacao === 'instavel') {
      return { color: 'text-yellow-400 font-bold', icon: <AlertTriangle className="w-3 h-3" />, text: 'Lentidão Detectada' };
    }
    // PRIORIDADE 4: ONLINE (Verde)
    return { color: 'text-emerald-500', icon: <Wifi className="w-3 h-3" />, text: 'Sistema Online' };
  }, [currentData, isStale]);

  return (
    <main className="min-h-screen bg-[#0B0F19] text-slate-300 font-sans p-4 md:p-8 flex flex-col items-center">

      <header className="w-full max-w-5xl flex flex-col md:flex-row justify-between items-center mb-6 gap-6 border-b border-slate-800/60 pb-6">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-2">
            Monitor SEFAZ <span className="text-indigo-500">{selectedUF}</span>
          </h1>
          <div className="flex items-center gap-4 mt-2">
            <div className={`flex items-center gap-1 text-xs ${headerStatus.color}`}>
              {headerStatus.icon}
              {headerStatus.text}
            </div>
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <Zap className="w-3 h-3 text-amber-400 fill-amber-400" /> Tempo Real
            </p>
          </div>
        </div>

        <div className="flex gap-4">
          <div className="flex bg-[#111625] p-1 rounded-lg border border-slate-700">
            <button
              onClick={() => setSelectedModel('NFe')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-all ${selectedModel === 'NFe' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
            >
              <FileText className="w-4 h-4" /> NFe
            </button>
            <button
              onClick={() => setSelectedModel('NFCe')}
              className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-bold transition-all ${selectedModel === 'NFCe' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}
            >
              <ShoppingCart className="w-4 h-4" /> NFCe
            </button>
          </div>

          <div className="relative group w-32">
            <div className="absolute right-3 top-3 pointer-events-none text-slate-500">
              <ChevronDown className="w-4 h-4" />
            </div>
            <select
              value={selectedUF}
              onChange={(e) => setSelectedUF(e.target.value)}
              className="w-full appearance-none bg-[#111625] border border-slate-700 hover:border-indigo-500/50 text-slate-200 rounded-lg py-2.5 pl-4 pr-10 focus:outline-none focus:ring-1 focus:ring-indigo-500 cursor-pointer transition-all font-bold text-lg"
            >
              {ESTADOS.map(uf => <option key={uf} value={uf}>{uf}</option>)}
            </select>
          </div>
        </div>
      </header>

      {/* ALERTA DE DADOS DESATUALIZADOS (SÓ APARECE SE NÃO ESTIVER OFFLINE) */}
      {isStale && currentData?.autorizacao !== 'offline' && (
        <div className="w-full max-w-5xl mb-6 bg-amber-500/10 border border-amber-500/30 p-4 rounded-xl flex items-center gap-3 text-amber-200 animate-pulse">
          <AlertTriangle className="w-6 h-6 text-amber-500" />
          <div>
            <p className="font-bold text-sm">Atenção: Os dados exibidos podem estar desatualizados.</p>
            <p className="text-xs opacity-80">Última atualização recebida da SEFAZ foi há {minutesAgo} minutos. Possível instabilidade na coleta.</p>
          </div>
          <button
            onClick={() => updateRemoteStatus()}
            className="ml-auto bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 px-3 py-1 rounded text-xs font-bold transition-colors"
          >
            Forçar Atualização
          </button>
        </div>
      )}

      {/* ALERTA DE OFFLINE CRÍTICO */}
      {currentData?.autorizacao === 'offline' && (
        <div className="w-full max-w-5xl mb-6 bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl flex items-center gap-3 text-rose-200 animate-pulse">
          <XOctagon className="w-6 h-6 text-rose-500" />
          <div>
            <p className="font-bold text-sm">CRÍTICO: SERVIÇO INDISPONÍVEL</p>
            <p className="text-xs opacity-80">A SEFAZ {selectedUF} não está respondendo ou bloqueou a conexão.</p>
          </div>
        </div>
      )}

      <div className="w-full max-w-5xl space-y-8 flex-1">
        {loading && !currentData ? (
          <div className="h-64 rounded-2xl bg-slate-800/30 animate-pulse border border-slate-700/30"></div>
        ) : currentData && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
              <StatusBadge label="Autorização" status={currentData.autorizacao} isStale={isStale} />
              <StatusBadge label="Retorno" status={currentData.retorno_autorizacao} isStale={isStale} />
              <StatusBadge label="Inutilização" status={currentData.inutilizacao} isStale={isStale} />
              <StatusBadge label="Consulta" status={currentData.consulta} isStale={isStale} />
              <StatusBadge label="Serviço" status={currentData.status_servico} isStale={isStale} />
            </div>

            <div className="space-y-6">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-4">
                <h3 className="text-slate-400 font-bold text-sm uppercase tracking-wider flex items-center gap-2">
                  {selectedModel === 'NFe' ? <FileText className="w-4 h-4" /> : <ShoppingCart className="w-4 h-4" />}
                  Disponibilidade {selectedModel}
                </h3>
              </div>
              <UptimeRow label="Autorizadores" history={history} field="autorizacao" />
              <UptimeRow label="Retorno de Autorização" history={history} field="retorno_autorizacao" />
              <UptimeRow label="Inutilização" history={history} field="inutilizacao" />
              <UptimeRow label="Consulta Protocolo" history={history} field="consulta" />
              <UptimeRow label="Status do Serviço" history={history} field="status_servico" />
            </div>
          </>
        )}
      </div>

      <div className="fixed bottom-4 right-4 text-[10px] text-slate-600 font-mono bg-slate-900 px-3 py-1.5 rounded border border-slate-800 flex items-center gap-2">
        <Clock className="w-3 h-3" />
        Último Sync: {currentData?.created_at ? new Date(currentData.created_at).toLocaleTimeString() : '--:--'}
      </div>

      <footer className="w-full max-w-5xl mt-12 pt-8 pb-4 border-t border-slate-800/50 flex flex-col items-center gap-3">
        <div className="text-xs text-slate-500 font-mono tracking-widest uppercase">
          Desenvolvido por <span className="text-indigo-400 font-bold">Nordic-Tech COM MUITO CAFÉ ☕!!</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900/50 border border-slate-800 text-[10px] text-slate-600 font-mono">
          <Eye className="w-3 h-3 text-slate-500" />
          <span>Acessos: <span className="text-slate-300 font-bold">{visitCount}</span></span>
        </div>
      </footer>
    </main>
  );
}

// --- Componentes Visuais ---

function StatusBadge({ label, status, isStale }: { label: string, status: string, isStale: boolean }) {
  // PRIORIDADE 1: Se for OFFLINE, mostra vermelho IMEDIATAMENTE.
  // Ignora se está obsoleto ou não, pois erro de conexão é crítico.
  if (status === 'offline') {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-rose-500/10 border-rose-500/30 transition-all duration-500 shadow-[0_0_15px_-5px_rgba(244,63,94,0.3)]">
        <span className="text-xs font-bold text-rose-400">{label}</span>
        <XOctagon className="w-4 h-4 text-rose-500 animate-pulse" />
      </div>
    );
  }

  // PRIORIDADE 2: Se não for offline, mas for antigo (stale)
  if (isStale) {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-slate-800/20 border-slate-700/50 opacity-60 grayscale">
        <span className="text-xs font-medium text-slate-500">{label}</span>
        <AlertTriangle className="w-4 h-4 text-slate-500" />
      </div>
    );
  }

  const isOnline = status === 'online';
  const isUnstable = status === 'instavel';

  return (
    <div className={`
      flex items-center justify-between p-3 rounded-lg border transition-all duration-500
      ${isOnline ? 'bg-emerald-500/5 border-emerald-500/20' : isUnstable ? 'bg-amber-400/5 border-amber-400/20' : 'bg-rose-500/5 border-rose-500/20'}
    `}>
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {isOnline ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> :
        isUnstable ? <AlertTriangle className="w-4 h-4 text-amber-400" /> :
          <XCircle className="w-4 h-4 text-rose-500" />}
    </div>
  );
}

function UptimeRow({ label, history, field }: { label: string, history: HistoryPoint[], field: keyof StateStatus }) {
  const TOTAL_BARS = 60;
  const total = history.length;
  // Calcula uptime excluindo 'offline'
  const onlineCount = history.filter(h => h.status[field] === 'online').length;
  const uptimePercentage = total > 0 ? ((onlineCount / total) * 100).toFixed(1) : '0.0';

  const displayHistory = [...history].reverse();
  const paddedHistory = [...Array(Math.max(0, TOTAL_BARS - displayHistory.length)).fill(null), ...displayHistory].slice(-TOTAL_BARS);

  return (
    <div className="group">
      <div className="flex justify-between items-end mb-2">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          {label}
        </h3>
        <span className={`text-xs font-mono font-bold ${Number(uptimePercentage) > 95 ? 'text-emerald-400' : Number(uptimePercentage) > 70 ? 'text-amber-400' : 'text-rose-400'}`}>
          {total > 0 ? `${uptimePercentage}% Uptime` : '...'}
        </span>
      </div>
      <div className="flex h-8 gap-[3px] w-full">
        {paddedHistory.map((point, i) => {
          if (!point) return <div key={`empty-${i}`} className="flex-1 bg-slate-800/40 rounded-[2px]" />;
          const status = point.status[field];
          let colorClass = 'bg-emerald-500 shadow-[0_0_8px_-2px_rgba(16,185,129,0.5)]';

          if (status === 'instavel') colorClass = 'bg-amber-400 shadow-[0_0_8px_-2px_rgba(251,191,36,0.5)]';
          // Offline agora fica VERMELHO FORTE e pulsante se for o último
          if (status === 'offline') colorClass = 'bg-rose-600 shadow-[0_0_8px_-2px_rgba(244,63,94,0.8)]';

          return (
            <div key={i} className="relative flex-1 group/bar">
              <div className={`h-full w-full rounded-[2px] transition-all duration-300 hover:scale-y-110 ${colorClass}`}></div>
              <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 opacity-0 group-hover/bar:opacity-100 transition-opacity z-20 pointer-events-none">
                <div className="bg-slate-900 text-slate-200 text-[10px] px-2 py-1 rounded border border-slate-700 whitespace-nowrap shadow-xl">
                  <div className="font-bold mb-0.5 uppercase">{status}</div>
                  <div className="text-slate-500 font-mono">{point.time}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}