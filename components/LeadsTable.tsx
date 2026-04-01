import React from 'react';
import { Lead } from '../lib/types';
import { User, Mail, ExternalLink, Sparkles, Linkedin, MessageSquare } from 'lucide-react';

interface LeadsTableProps {
  leads: Lead[];
  onViewMessage: (lead: Lead) => void;
  onMarkContacted?: (lead: Lead) => void;
  onMarkDiscarded?: (lead: Lead) => void;
}

const exportToCSV = (leads: Lead[]) => {
  const headers = ['Nombre', 'Apellido', 'Email', 'Cargo', 'Perfil LinkedIn', 'CUELLO DE BOTELLA', '🧠 PERFIL PSICOLÓGICO', '🏢 MOMENTO EMPRESARIAL', '💡 ÁNGULO DE VENTA', 'MENSAJE PERSONALIZADO'];
  const escapeCSV = (value: string | undefined) => {
    if (!value) return '';
    const escaped = value.replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '');
    return escaped.includes(',') || escaped.includes('"')
      ? `"${escaped}"`
      : escaped;
  };

  const rows = leads.map(l => {
    const fullName = l.decisionMaker?.name || '';
    const nameParts = fullName.trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    return [
      escapeCSV(firstName),
      escapeCSV(lastName),
      escapeCSV(l.decisionMaker?.email),
      escapeCSV(l.decisionMaker?.role),
      escapeCSV(l.decisionMaker?.linkedin || ''),
      escapeCSV(l.aiAnalysis?.generatedIcebreaker || 'Pendiente de detección'),
      escapeCSV(l.aiAnalysis?.psychologicalProfile || 'Pendiente'),
      escapeCSV(l.aiAnalysis?.businessMoment || 'Pendiente'),
      escapeCSV(l.aiAnalysis?.salesAngle || 'Pendiente'),
      escapeCSV(l.aiAnalysis?.fullMessage || 'Pendiente de generación')
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `leads_ultra_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export function LeadsTable({ leads, onViewMessage, onMarkContacted, onMarkDiscarded }: LeadsTableProps) {
  if (leads.length === 0) return null;

  return (
    <div className="mt-8 bg-card border border-border rounded-xl overflow-hidden shadow-sm animate-[fadeIn_0.5s_ease-out]">
      <div className="p-4 border-b border-border flex items-center justify-between">
        <h3 className="font-semibold text-lg flex items-center gap-2">
          Contactos Encontrados
          <span className="bg-primary/10 text-primary text-xs px-2 py-0.5 rounded-full">{leads.length}</span>
        </h3>
        <div className="flex gap-2">
          <button
            onClick={() => exportToCSV(leads)}
            className="px-3 py-1.5 text-xs font-medium border border-border rounded-md hover:bg-secondary transition-colors"
          >
            Exportar CSV
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-secondary/30 text-xs text-muted-foreground uppercase tracking-wider border-b border-border">
              <th className="px-6 py-4 font-medium w-[15%]">Empresa</th>
              <th className="px-6 py-4 font-medium w-[15%]">Decisor</th>
              <th className="px-6 py-4 font-medium w-[15%]">Contacto</th>
              <th className="px-6 py-4 font-medium w-[35%]">Análisis IA</th>
              <th className="px-6 py-4 font-medium text-right w-[20%]">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {leads.map((lead) => (
              <tr key={lead.id} className="group hover:bg-secondary/20 transition-colors">
                <td className="px-6 py-4 align-top">
                  <div className="flex flex-col max-w-[150px]">
                    <span className="font-medium text-foreground truncate" title={lead.companyName}>{lead.companyName}</span>
                    <div className="flex items-center gap-2 mt-1">
                      {lead.website && (
                        <a href={`https://${lead.website}`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                          <ExternalLink className="w-3 h-3" /> Web
                        </a>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-6 py-4 align-top">
                  {lead.decisionMaker ? (
                    <div className="flex flex-col">
                      <div className="flex items-center gap-1.5">
                        <User className="w-3 h-3 text-primary" />
                        <span className="text-sm font-medium">{lead.decisionMaker.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground pl-4.5">{lead.decisionMaker.role}</span>
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground italic">Pendiente...</span>
                  )}
                </td>
                <td className="px-6 py-4 align-top">
                  <div className="space-y-1">
                    {lead.decisionMaker?.email && (
                      <div className="flex items-center gap-1.5 text-xs">
                        <Mail className="w-3 h-3 text-muted-foreground" />
                        <span className="text-foreground">{lead.decisionMaker.email}</span>
                      </div>
                    )}
                    {lead.decisionMaker?.phone && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="w-3 h-3 flex items-center justify-center font-bold">#</span>
                        <span>{lead.decisionMaker.phone}</span>
                      </div>
                    )}
                    {lead.decisionMaker?.linkedin && (
                      <a
                        href={lead.decisionMaker.linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
                      >
                        <Linkedin className="w-3 h-3" />
                        <span>Ver Perfil</span>
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-6 py-4 align-top">
                  <div className="bg-secondary/40 p-3 rounded-lg border border-border/50 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1 h-full bg-primary/20" />
                    <div className="flex items-start gap-2 mb-2">
                      <Sparkles className="w-3.5 h-3.5 text-primary mt-0.5 flex-shrink-0" />
                      <span className="text-xs font-bold text-foreground uppercase tracking-wide">Insight</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                      {lead.aiAnalysis.summary}
                    </p>
                  </div>
                </td>
                <td className="px-6 py-4 align-top text-right">
                  <button
                    onClick={() => onViewMessage(lead)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground border border-primary/20 rounded-md text-xs font-bold transition-all"
                    title="Ver y editar mensaje"
                  >
                    <MessageSquare className="w-3 h-3" />
                    <span className="hidden sm:inline">Draft</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
