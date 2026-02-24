import GourmetFinanceiro from "../../models/GourmetFinanceiro";
import { Op } from "sequelize";

export interface LanchonetesStats {
  totalVendasDia: number;
  totalVendasMes: number;
  evolucaoVendas: Array<{ data: string; total: number; quantidade: number }>;
  entregasPorEntregador: Array<{ nome: string; quantidade: number }>;
}

const LanchonetesStatsService = async (companyId: number): Promise<LanchonetesStats> => {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const startOfMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
  const daysEvolution = 30;
  const startEvolution = new Date(now);
  startEvolution.setDate(startEvolution.getDate() - daysEvolution);
  const startEvolutionStr = startEvolution.toISOString().slice(0, 10);

  const baseWhere = { companyId };

  const [registrosHoje, registrosMes, registrosEvolution, registrosDelivery] = await Promise.all([
    GourmetFinanceiro.findAll({
      where: { ...baseWhere, dataVenda: todayStr },
      attributes: ["id", "valor"],
    }),
    GourmetFinanceiro.findAll({
      where: {
        ...baseWhere,
        dataVenda: { [Op.gte]: startOfMonth, [Op.lte]: todayStr },
      },
      attributes: ["id", "valor"],
    }),
    GourmetFinanceiro.findAll({
      where: {
        ...baseWhere,
        dataVenda: { [Op.gte]: startEvolutionStr, [Op.lte]: todayStr },
      },
      attributes: ["id", "valor", "dataVenda"],
    }),
    GourmetFinanceiro.findAll({
      where: { ...baseWhere, tipo: "delivery" },
      attributes: ["id", "entregadorNome", "entregadorUserId"],
    }),
  ]);

  const totalVendasDia = registrosHoje.reduce((s, r) => s + Number((r as any).valor || 0), 0);
  const totalVendasMes = registrosMes.reduce((s, r) => s + Number((r as any).valor || 0), 0);

  const byDate: Record<string, { total: number; quantidade: number }> = {};
  for (let d = 0; d < daysEvolution; d++) {
    const date = new Date(startEvolution);
    date.setDate(date.getDate() + d);
    const key = date.toISOString().slice(0, 10);
    byDate[key] = { total: 0, quantidade: 0 };
  }
  registrosEvolution.forEach((r) => {
    const key = (r as any).dataVenda;
    const val = Number((r as any).valor || 0);
    if (byDate[key]) {
      byDate[key].total += val;
      byDate[key].quantidade += 1;
    }
  });
  const evolucaoVendas = Object.entries(byDate)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([data, v]) => ({ data, total: Math.round(v.total * 100) / 100, quantidade: v.quantidade }));

  const entregadorCount: Record<string, number> = {};
  registrosDelivery.forEach((r) => {
    const nome = (r as any).entregadorNome?.trim() || String((r as any).entregadorUserId || "Sem nome");
    entregadorCount[nome] = (entregadorCount[nome] || 0) + 1;
  });
  const entregasPorEntregador = Object.entries(entregadorCount)
    .map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return {
    totalVendasDia: Math.round(totalVendasDia * 100) / 100,
    totalVendasMes: Math.round(totalVendasMes * 100) / 100,
    evolucaoVendas,
    entregasPorEntregador,
  };
};

export default LanchonetesStatsService;
