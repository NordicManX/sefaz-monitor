'use client';

import { supabase } from '@/lib/supabase';
import { useState, useEffect, useMemo } from 'react';
import {
  Wifi, AlertTriangle, CheckCircle2, XOctagon,
  FileText, ShoppingCart, Clock, Activity, ArrowDown
} from 'lucide-react';

// --- TIPAGEM ---
type StateStatus = {
  estado: string;
  modelo: 'NFe' | 'NFCe';
  autorizacao: string;
  retorno_autorizacao: string;
  inutilizacao: string;
  consulta: string;
  status_servico: string;
  created_at?: string;
  details?: string;
  latency?: number;
};

type HistoryPoint = {
  time: string;
  fullDate: string;
  status: StateStatus;
};

const ESTADOS = ['PR', 'SP', 'SC', 'RS', 'RJ', 'MG']; // Reduzi para exemplo, pode manter todos

export default function MonitorClean() {
  const [selectedUF, setSelectedUF] = useState('PR');
  const [selectedModel, setSelectedModel] = useState<'NFe' | 'NFCe'>('NFCe');

  const [currentData, setCurrentData] = useState<StateStatus | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastCheck, setLastCheck] = useState<Date>(new Date());
  const [isStale, setIsStale] = useState(false);

  // --- LÓGICA (Mantida idêntica, apenas compactada para leitura) ---
  useEffect(() => {
    if (!currentData?.created_at) return;
    const checkStale = () => {
      const diffMins = Math.floor((new Date().getTime() - new Date(currentData.created_at!).getTime()) / 60000);
      setIsStale(diffMins >= 5 && currentData.autorizacao !== 'offline');
    };
    checkStale();
    const timer = setInterval(checkStale, 10000);
    return () => clearInterval(timer);
  }, [currentData]);

  const runLiveCheck = async () => {
    try {
      setLastCheck(new Date());
      const res = await fetch(`/api/status?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('Falha');
      const data: StateStatus[] = await res.json();
      const myStatus = data.find(d => d.estado === selectedUF && d.modelo === selectedModel);
      if (myStatus) handleNewData(myStatus);
    } catch (err) { console.error(err); }
  };

  const handleNewData = (newData: StateStatus) => {
    if (!newData.created_at) newData.created_at = new Date().toISOString();
    setCurrentData(newData);
    setIsStale(false);
    setHistory((prev) => {
      const last = prev[0];
      const newTime = new Date(newData.created_at!).getTime();
      const lastTime = last ? new Date(last.status.created_at!).getTime() : 0;
      if (Math.abs(newTime - lastTime) < 2000) return prev;
      const newPoint: HistoryPoint = {
        time: new Date(newData.created_at!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        fullDate: new Date(newData.created_at!).toLocaleString('pt-BR'),
        status: newData
      };
      return [newPoint, ...prev].slice(0, 60);
    });
    setLoading(false);
  };

  useEffect(() => {
    const loadInitialHistory = async () => {
      setLoading(true);
      const { data } = await supabase.from('sefaz_logs').select('*').eq('estado', selectedUF).eq('modelo', selectedModel).order('created_at', { ascending: false }).limit(60);
      if (data && data.length > 0) {
        setHistory(data.map((item: any) => ({
          time: new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          fullDate: new Date(item.created_at).toLocaleString('pt-BR'),
          status: item
        })));
        setCurrentData(data[0]);
        setLoading(false);
      } else { runLiveCheck(); }
    };
    loadInitialHistory();
    const interval = setInterval(runLiveCheck, 15000);
    const channel = supabase.channel('sefaz-realtime').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'sefaz_logs', filter: `estado=eq.${selectedUF}` }, (payload) => {
      const newLog = payload.new as StateStatus;
      if (newLog.modelo === selectedModel) handleNewData(newLog);
    }).subscribe();
    return () => { clearInterval(interval); supabase.removeChannel(channel); };
  }, [selectedUF, selectedModel]);

  // --- UI HELPERS ---
  const statusConfig = useMemo(() => {
    if (!currentData) return { color: 'bg-zinc-500', text: 'Conectando...' };
    if (currentData.autorizacao === 'offline') return { color: 'bg-rose-500', text: 'Indisponível' };
    if (isStale || currentData.autorizacao === 'instavel') return { color: 'bg-amber-500', text: 'Instabilidade' };
    return { color: 'bg-emerald-500', text: 'Operacional' };
  }, [currentData, isStale]);

  const errorLogs = useMemo(() => history.filter(h => h.status.autorizacao === 'offline' || h.status.autorizacao === 'instavel'), [history]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-400 font-sans selection:bg-indigo-500/30">

      {/* HEADER SIMPLIFICADO */}
      <div className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-2.5 h-2.5 rounded-full ${statusConfig.color} animate-pulse`} />
            <h1 className="text-zinc-100 font-semibold tracking-tight">
              Sefaz Monitor <span className="text-zinc-500 mx-2">/</span> {selectedUF}
            </h1>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex bg-zinc-900 p-1 rounded-lg border border-zinc-800">
              {(['NFe', 'NFCe'] as const).map((model) => (
                <button
                  key={model}
                  onClick={() => setSelectedModel(model)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all ${selectedModel === model
                      ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                      : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                >
                  {model}
                </button>
              ))}
            </div>

            <select
              value={selectedUF}
              onChange={(e) => setSelectedUF(e.target.value)}
              className="bg-transparent text-sm font-medium text-zinc-300 focus:outline-none cursor-pointer hover:text-white transition-colors"
            >
              {ESTADOS.map(uf => <option key={uf} value={uf} className="bg-zinc-900">{uf}</option>)}
            </select>
          </div>
        </div>
      </div>

      <main className="max-w-6xl mx-auto p-6 space-y-8">

        {/* ALERTA DE ERRO (Minimalista) */}
        {currentData?.autorizacao === 'offline' && (
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-lg p-4 flex items-start gap-4">
            <XOctagon className="w-5 h-5 text-rose-500 mt-0.5" />
            <div>
              <h3 className="text-rose-400 font-medium text-sm">Serviço Indisponível</h3>
              <p className="text-rose-500/60 text-xs mt-1">
                A comunicação com a SEFAZ {selectedUF} falhou. {currentData.details}
              </p>
            </div>
          </div>
        )}

        {/* STATUS GRID - CARDS LIMPOS */}
        {loading && !currentData ? (
          <div className="h-40 flex items-center justify-center text-zinc-600 text-sm animate-pulse">Carregando telemetria...</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <CleanCard label="Autorização" status={currentData?.autorizacao} icon={<CheckCircle2 />} />
            <CleanCard label="Retorno" status={currentData?.retorno_autorizacao} icon={<Activity />} />
            <CleanCard label="Inutilização" status={currentData?.inutilizacao} icon={<XOctagon />} />
            <CleanCard label="Consulta" status={currentData?.consulta} icon={<FileText />} />
            <CleanCard label="Serviço" status={currentData?.status_servico} icon={<Wifi />} />
          </div>
        )}

        {/* GRÁFICOS DE BARRAS (Barcode Style) */}
        <div className="bg-zinc-900/40 border border-zinc-800/60 rounded-xl p-6">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
              <Activity className="w-4 h-4 text-zinc-500" />
              Latência e Disponibilidade
            </h2>
            <span className="text-xs text-zinc-600 font-mono">Últimos 15 min</span>
          </div>

          <div className="space-y-6">
            <CleanUptimeRow label="Autorizadores" history={history} field="autorizacao" />
            <CleanUptimeRow label="Consulta Protocolo" history={history} field="consulta" />
            <CleanUptimeRow label="Status Serviço" history={history} field="status_servico" />
          </div>
        </div>

        {/* TABELA DE INCIDENTES (Estilo Data Table) */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-zinc-400">Log de Incidentes</h3>
          <div className="border border-zinc-800 rounded-lg overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-900 text-zinc-500">
                <tr>
                  <th className="px-4 py-3 font-medium border-b border-zinc-800 w-32">Horário</th>
                  <th className="px-4 py-3 font-medium border-b border-zinc-800 w-24">Status</th>
                  <th className="px-4 py-3 font-medium border-b border-zinc-800">Detalhe Técnico</th>
                </tr>
              </thead>
              <tbody className="bg-zinc-950/50 divide-y divide-zinc-800/50">
                {errorLogs.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-zinc-600 italic">
                      Nenhuma falha registrada recentemente.
                    </td>
                  </tr>
                ) : (
                  errorLogs.slice(0, 10).map((log, i) => (
                    <tr key={i} className="hover:bg-zinc-900/50 transition-colors">
                      <td className="px-4 py-3 text-zinc-400 font-mono">{log.time}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${log.status.autorizacao === 'offline'
                            ? 'bg-rose-500/10 text-rose-400'
                            : 'bg-amber-500/10 text-amber-400'
                          }`}>
                          {log.status.autorizacao === 'offline' ? 'FALHA' : 'LENTO'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 truncate max-w-md">
                        {log.status.details || 'Timeout na conexão'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

      </main>

      {/* FOOTER DISCRETO */}
      <footer className="max-w-6xl mx-auto px-6 py-8 border-t border-zinc-900 mt-8 flex justify-between items-center text-xs text-zinc-600">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
          Sistema Operacional
        </div>
        <div className="flex items-center gap-2 font-mono">
          <Clock className="w-3 h-3" />
          Check: {lastCheck.toLocaleTimeString()}
        </div>
      </footer>
    </div>
  );
}

// --- COMPONENTES VISUAIS CLEAN ---

function CleanCard({ label, status, icon }: { label: string, status?: string, icon: any }) {
  let color = 'text-zinc-600';
  let bg = 'bg-zinc-900/50';
  let border = 'border-zinc-800';
  let statusText = '---';

  if (status === 'online') {
    color = 'text-emerald-500';
    statusText = 'Ativo';
  } else if (status === 'instavel') {
    color = 'text-amber-500';
    statusText = 'Lento';
  } else if (status === 'offline') {
    color = 'text-rose-500';
    bg = 'bg-rose-950/10';
    border = 'border-rose-900/30';
    statusText = 'Erro';
  }

  return (
    <div className={`flex flex-col items-center justify-center p-4 rounded-xl border ${border} ${bg} transition-all`}>
      <div className={`mb-2 ${color} opacity-80 scale-110`}>
        {/* Clone element to force size */}
        <div className="w-5 h-5">{icon}</div>
      </div>
      <span className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-1">{label}</span>
      <span className={`text-sm font-bold ${color === 'text-zinc-600' ? 'text-zinc-400' : 'text-zinc-200'}`}>
        {statusText}
      </span>
    </div>
  );
}

function CleanUptimeRow({ label, history, field }: { label: string, history: HistoryPoint[], field: keyof StateStatus }) {
  const TOTAL_BARS = 40; // Menos barras, mas mais largas
  const displayHistory = [...history].reverse();
  const paddedHistory = [...Array(Math.max(0, TOTAL_BARS - displayHistory.length)).fill(null), ...displayHistory].slice(-TOTAL_BARS);

  // Calcula %
  const onlineCount = history.filter(h => h.status[field] === 'online').length;
  const percentage = history.length > 0 ? Math.round((onlineCount / history.length) * 100) : 100;

  return (
    <div className="flex items-center gap-4">
      <div className="w-32 shrink-0">
        <div className="text-xs font-medium text-zinc-300">{label}</div>
        <div className="text-[10px] text-zinc-600">{percentage}% uptime</div>
      </div>

      <div className="flex-1 flex items-center h-6 gap-1">
        {paddedHistory.map((point, i) => {
          if (!point) return <div key={i} className="flex-1 h-full bg-zinc-800/30 rounded-sm" />;

          let color = 'bg-emerald-500/80 hover:bg-emerald-400';
          if (point.status[field] === 'instavel') color = 'bg-amber-500/80 hover:bg-amber-400';
          if (point.status[field] === 'offline') color = 'bg-rose-500/80 hover:bg-rose-400';

          return (
            <div
              key={i}
              className={`flex-1 min-w-[4px] rounded-sm transition-all duration-300 ${color}`}
              style={{
                height: point.status[field] === 'online' ? '60%' : '100%',
                opacity: point.status[field] === 'online' ? 0.6 : 1
              }}
              title={`${point.time} - ${point.status[field]}`}
            />
          );
        })}
      </div>
    </div>
  );
}