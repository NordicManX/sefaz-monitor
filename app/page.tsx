'use client';

import { supabase } from '@/lib/supabase';
import { useState, useEffect, useMemo } from 'react';
import { ChevronDown, Wifi, AlertTriangle, CheckCircle2, XOctagon, FileText, ShoppingCart, Eye, Clock, Terminal } from 'lucide-react';

// Tipagem alinhada com o retorno do Backend
type StateStatus = {
  estado: string;
  modelo: 'NFe' | 'NFCe';
  autorizacao: string;
  retorno_autorizacao: string;
  inutilizacao: string;
  consulta: string;
  status_servico: string;
  created_at?: string;
  details?: string; // Mensagem de erro vinda do backend
  latency?: number; // Latência vinda do backend
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
  const [selectedModel, setSelectedModel] = useState<'NFe' | 'NFCe'>('NFCe'); // Padrão NFCe (Varejo)

  const [currentData, setCurrentData] = useState<StateStatus | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [visitCount, setVisitCount] = useState<number>(0);
  const [lastCheck, setLastCheck] = useState<Date>(new Date());

  const [isStale, setIsStale] = useState(false);

  // Stats de visita (Opcional)
  useEffect(() => {
    // Se não tiver rota de visit, pode comentar
    // fetch('/api/visit').then(r => r.json()).then(d => setVisitCount(d.count)).catch(() => {});
  }, []);

  // Verifica se os dados estão "velhos" (Stale) > 5 min
  useEffect(() => {
    if (!currentData?.created_at) return;
    const checkStale = () => {
      const lastDate = new Date(currentData.created_at!);
      const diffMins = Math.floor((new Date().getTime() - lastDate.getTime()) / 60000);
      setIsStale(diffMins >= 5 && currentData.autorizacao !== 'offline');
    };
    checkStale();
    const timer = setInterval(checkStale, 10000);
    return () => clearInterval(timer);
  }, [currentData]);

  // Função Principal: Chama o Backend e Atualiza a Tela
  const runLiveCheck = async () => {
    try {
      setLastCheck(new Date());
      // Chama sua rota API (Backend Next.js)
      const res = await fetch(`/api/status?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (!res.ok) throw new Error('Falha no fetch');

      const data: StateStatus[] = await res.json();

      // Filtra o Estado e Modelo que o usuário está vendo agora
      const myStatus = data.find(d => d.estado === selectedUF && d.modelo === selectedModel);

      if (myStatus) {
        handleNewData(myStatus);
      }
    } catch (err) {
      console.error("Erro no check:", err);
    }
  };

  // Centraliza a atualização de estado para usar tanto no Fetch quanto no Realtime
  const handleNewData = (newData: StateStatus) => {
    // Adiciona timestamp se não vier do banco
    if (!newData.created_at) newData.created_at = new Date().toISOString();

    setCurrentData(newData);
    setIsStale(false);

    setHistory((prev) => {
      // Evita duplicatas se o realtime e o fetch chegarem juntos (checagem simples por minuto/segundo)
      const last = prev[0];
      const newTime = new Date(newData.created_at!).getTime();
      const lastTime = last ? new Date(last.status.created_at!).getTime() : 0;

      // Se a diferença for menor que 2 segundos, ignora (já atualizou)
      if (Math.abs(newTime - lastTime) < 2000) return prev;

      const newPoint: HistoryPoint = {
        time: new Date(newData.created_at!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        fullDate: new Date(newData.created_at!).toLocaleString('pt-BR'),
        status: newData
      };
      // Mantém apenas os últimos 60 pontos
      return [newPoint, ...prev].slice(0, 60);
    });
    setLoading(false);
  };

  // 1. Carregar Histórico Inicial (Do Banco)
  const loadInitialHistory = async () => {
    setLoading(true);
    setHistory([]);
    try {
      // Supabase direto aqui para pegar histórico rápido
      const { data } = await supabase
        .from('sefaz_logs')
        .select('*')
        .eq('estado', selectedUF)
        .eq('modelo', selectedModel)
        .order('created_at', { ascending: false })
        .limit(60);

      if (data && data.length > 0) {
        const formatted = data.map((item: any) => ({
          time: new Date(item.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
          fullDate: new Date(item.created_at).toLocaleString('pt-BR'),
          status: item
        }));
        setHistory(formatted);
        setCurrentData(data[0]);
        setLoading(false);
      } else {
        // Se não tem histórico, roda um check agora
        runLiveCheck();
      }
    } catch (e) {
      console.error(e);
      runLiveCheck();
    }
  };

  useEffect(() => {
    loadInitialHistory();

    // 2. Polling (Intervalo de 15 segundos)
    const interval = setInterval(() => { runLiveCheck(); }, 15000);

    // 3. Realtime (Para ver se outro usuário atualizou)
    const channel = supabase
      .channel('sefaz-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'sefaz_logs', filter: `estado=eq.${selectedUF}` },
        (payload) => {
          const newLog = payload.new as StateStatus;
          if (newLog.modelo === selectedModel) {
            console.log("⚡ Realtime Update recebido");
            handleNewData(newLog);
          }
        }
      )
      .subscribe();

    return () => {
      clearInterval(interval);
      supabase.removeChannel(channel);
    };
  }, [selectedUF, selectedModel]);

  // UI Helpers
  const headerStatus = useMemo(() => {
    if (!currentData) return { color: 'text-slate-500', icon: <Wifi className="w-3 h-3" />, text: 'Carregando...' };

    if (currentData.autorizacao === 'offline' || currentData.status_servico === 'offline') {
      return { color: 'text-rose-500 font-bold', icon: <XOctagon className="w-3 h-3" />, text: 'SEFAZ INDISPONÍVEL' };
    }
    if (isStale || currentData.autorizacao === 'instavel') {
      return { color: 'text-orange-500 font-bold', icon: <AlertTriangle className="w-3 h-3" />, text: 'Instabilidade / Lento' };
    }
    return { color: 'text-emerald-500 font-bold', icon: <Wifi className="w-3 h-3" />, text: 'Sistema Online' };
  }, [currentData, isStale]);

  // Filtro de Logs de Erro
  const errorLogs = useMemo(() => {
    return history.filter(h =>
      h.status.autorizacao === 'offline' ||
      h.status.autorizacao === 'instavel' ||
      h.status.status_servico === 'offline'
    );
  }, [history]);

  return (
    <main className="min-h-screen bg-[#0B0F19] text-slate-300 font-sans p-4 md:p-8 flex flex-col items-center">

      {/* --- HEADER --- */}
      <header className="w-full max-w-5xl flex flex-col md:flex-row justify-between items-center mb-6 gap-6 border-b border-slate-800/60 pb-6">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-2">
            Monitor SEFAZ <span className="text-indigo-500">{selectedUF}</span>
          </h1>
          <div className="flex items-center gap-4 mt-2">
            <div className={`flex items-center gap-1 text-xs transition-colors duration-500 ${headerStatus.color}`}>
              {headerStatus.icon}
              {headerStatus.text}
            </div>
            <div className="flex items-center gap-1">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${loading ? 'bg-indigo-400' : 'bg-emerald-400'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${loading ? 'bg-indigo-500' : 'bg-emerald-500'}`}></span>
              </span>
              <span className="text-[10px] text-slate-600 font-mono">
                {loading ? 'Atualizando...' : 'Live Monitoring'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex gap-4">
          {/* Botões NFe / NFCe */}
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

          {/* Select Estado */}
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

      {/* --- ALERTA DE ERRO CRÍTICO --- */}
      {currentData?.autorizacao === 'offline' && (
        <div className="w-full max-w-5xl mb-6 bg-rose-500/10 border border-rose-500/30 p-4 rounded-xl flex items-center gap-3 text-rose-200 animate-pulse shadow-[0_0_20px_-5px_rgba(244,63,94,0.2)]">
          <XOctagon className="w-6 h-6 text-rose-500" />
          <div>
            <p className="font-bold text-sm">CRÍTICO: SERVIÇO INDISPONÍVEL</p>
            <p className="text-xs opacity-80">
              A SEFAZ {selectedUF} não está respondendo.
              {currentData.details && ` Detalhe: ${currentData.details}`}
            </p>
          </div>
        </div>
      )}

      {/* --- DASHBOARD PRINCIPAL --- */}
      <div className="w-full max-w-5xl space-y-8 flex-1">
        {loading && !currentData ? (
          <div className="h-64 rounded-2xl bg-slate-800/30 animate-pulse border border-slate-700/30 flex items-center justify-center text-slate-600">
            Carregando dados da SEFAZ...
          </div>
        ) : currentData && (
          <>
            {/* Badges de Status Atual */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-8">
              <StatusBadge label="Autorização" status={currentData.autorizacao} isStale={isStale} />
              <StatusBadge label="Retorno" status={currentData.retorno_autorizacao} isStale={isStale} />
              <StatusBadge label="Inutilização" status={currentData.inutilizacao} isStale={isStale} />
              <StatusBadge label="Consulta" status={currentData.consulta} isStale={isStale} />
              <StatusBadge label="Serviço" status={currentData.status_servico} isStale={isStale} />
            </div>

            {/* Gráficos de Barras (Uptime) */}
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

      {/* --- LOG DE INCIDENTES --- */}
      <div className="w-full max-w-5xl mt-10">
        <div className="flex items-center gap-2 mb-3 text-slate-400 border-b border-slate-800 pb-2">
          <Terminal className="w-4 h-4" />
          <h3 className="font-bold text-sm uppercase tracking-wider">Log de Incidentes Recentes</h3>
        </div>

        <div className="bg-[#0f1219] rounded-lg border border-slate-800 overflow-hidden font-mono text-xs shadow-inner min-h-[150px] max-h-[300px] overflow-y-auto custom-scrollbar">
          {errorLogs.length === 0 ? (
            <div className="p-8 text-center text-slate-600 italic">
              Nenhum incidente registrado nas últimas horas. Sistema estável.
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-slate-900 text-slate-500 sticky top-0">
                <tr>
                  <th className="p-3 font-medium">Data/Hora</th>
                  <th className="p-3 font-medium">Status</th>
                  <th className="p-3 font-medium">Detalhes do Erro</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {errorLogs.slice(0, 50).map((log, idx) => (
                  <tr key={idx} className="hover:bg-slate-800/30 transition-colors">
                    <td className="p-3 text-slate-400 whitespace-nowrap">{log.fullDate}</td>
                    <td className="p-3">
                      {log.status.autorizacao === 'offline' ? (
                        <span className="text-rose-500 font-bold">OFFLINE</span>
                      ) : (
                        <span className="text-orange-400 font-bold">LENTO</span>
                      )}
                    </td>
                    <td className="p-3 text-slate-300 break-all">
                      {log.status.details ? (
                        <span className="text-rose-300">{log.status.details}</span>
                      ) : (
                        <span className="opacity-50 italic">
                          {log.status.autorizacao === 'offline'
                            ? "Timeout / Bloqueio na conexão com a SEFAZ"
                            : "Latência elevada detectada"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="fixed bottom-4 right-4 text-[10px] text-slate-600 font-mono bg-slate-900 px-3 py-1.5 rounded border border-slate-800 flex items-center gap-2 z-50">
        <Clock className="w-3 h-3" />
        Último Check: {lastCheck.toLocaleTimeString()}
      </div>

      <footer className="w-full max-w-5xl mt-12 pt-8 pb-4 border-t border-slate-800/50 flex flex-col items-center gap-3">
        <div className="text-xs text-slate-500 font-mono tracking-widest uppercase">
          Desenvolvido por <span className="text-indigo-400 font-bold">Nordic-Tech</span>
        </div>
      </footer>
    </main>
  );
}

// --- Componentes Visuais (Mantive iguais, só ajustei cores) ---
function StatusBadge({ label, status, isStale }: { label: string, status: string, isStale: boolean }) {
  if (status === 'offline') {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-rose-500/10 border-rose-500/30 transition-all duration-500 shadow-[0_0_15px_-5px_rgba(244,63,94,0.3)]">
        <span className="text-xs font-bold text-rose-400">{label}</span>
        <XOctagon className="w-4 h-4 text-rose-500 animate-pulse" />
      </div>
    );
  }
  if (isStale || status === 'instavel') {
    return (
      <div className="flex items-center justify-between p-3 rounded-lg border bg-orange-500/10 border-orange-500/30 transition-all duration-500">
        <span className="text-xs font-bold text-orange-400">{label}</span>
        <AlertTriangle className="w-4 h-4 text-orange-500 animate-pulse" />
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between p-3 rounded-lg border bg-emerald-500/5 border-emerald-500/20 transition-all duration-500">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      <CheckCircle2 className="w-4 h-4 text-emerald-500" />
    </div>
  );
}

function UptimeRow({ label, history, field }: { label: string, history: HistoryPoint[], field: keyof StateStatus }) {
  const TOTAL_BARS = 60;
  // Conta uptime baseado no histórico carregado
  const onlineCount = history.filter(h => h.status[field] === 'online').length;
  const total = history.length;
  const uptimePercentage = total > 0 ? ((onlineCount / total) * 100).toFixed(1) : '100.0';

  // Inverte para mostrar o mais recente na direita
  const displayHistory = [...history].reverse();
  const paddedHistory = [...Array(Math.max(0, TOTAL_BARS - displayHistory.length)).fill(null), ...displayHistory].slice(-TOTAL_BARS);

  return (
    <div className="group">
      <div className="flex justify-between items-end mb-2">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          {label}
        </h3>
        <span className={`text-xs font-mono font-bold ${Number(uptimePercentage) > 95 ? 'text-emerald-400' : Number(uptimePercentage) > 80 ? 'text-orange-400' : 'text-rose-400'}`}>
          {total > 0 ? `${uptimePercentage}% Online` : '...'}
        </span>
      </div>
      <div className="flex h-8 gap-[3px] w-full bg-slate-800/20 rounded p-1">
        {paddedHistory.map((point, i) => {
          if (!point) return <div key={`empty-${i}`} className="flex-1 bg-slate-800/40 rounded-[1px]" />;

          const status = point.status[field];
          let colorClass = 'bg-emerald-500 shadow-[0_0_8px_-2px_rgba(16,185,129,0.5)]';

          if (status === 'instavel') colorClass = 'bg-orange-500 shadow-[0_0_8px_-2px_rgba(249,115,22,0.5)]';
          if (status === 'offline') colorClass = 'bg-rose-600 shadow-[0_0_8px_-2px_rgba(244,63,94,0.8)]';
          if (status === 'unknown') colorClass = 'bg-slate-600';

          return (
            <div key={i} className="relative flex-1 group/bar h-full">
              <div className={`h-full w-full rounded-[1px] transition-all duration-300 hover:brightness-125 ${colorClass}`}></div>
              {/* Tooltip */}
              <div className="absolute bottom-full mb-2 right-0 opacity-0 group-hover/bar:opacity-100 transition-opacity z-20 pointer-events-none">
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