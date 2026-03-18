import GourmetFinanceiro from "../../models/GourmetFinanceiro";
import GourmetDespesa from "../../models/GourmetDespesa";
import { Op } from "sequelize";
import { getBrazilISODateString, getBrazilMonthStartString } from "../../helpers/BrazilTimezone";
import FormResponse from "../../models/FormResponse";
import ResponseAnswer from "../../models/ResponseAnswer";
import FormField from "../../models/FormField";

export interface LanchonetesStats {
  totalVendasDia: number;
  totalVendasMes: number;
  totalDespesas: number;
  saldoGeral: number;
  evolucaoVendas: Array<{ data: string; total: number; quantidade: number }>;
  evolucaoDespesas: Array<{ data: string; total: number; quantidade: number }>;
  entregasPorEntregador: Array<{ nome: string; quantidade: number }>;
  faturamentoPorMeioPagamento: Array<{ metodo: string; total: number; quantidade: number }>;
}

type Params = { initialDate?: string; finalDate?: string };

const normalize = (s: any): string =>
  String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

const isPaymentLabel = (label: string): boolean => {
  const l = normalize(label);
  if (!l) return false;
  // Aceitar variações comuns nos formulários
  if (l === "meio de pagamento" || l.includes("meio de pagamento")) return true;
  if (l === "metodo de pagamento" || l.includes("metodo de pagamento")) return true;
  if (l === "tipo de pagamento" || l.includes("tipo de pagamento")) return true;
  if (l === "forma de pagamento" || l.includes("forma de pagamento")) return true;
  // Fallback: label menciona pagamento + algum termo relacionado a método/tipo/meio/forma
  return (
    l.includes("pagamento") &&
    (l.includes("meio") || l.includes("metodo") || l.includes("tipo") || l.includes("forma"))
  );
};

const mapMetodo = (raw: any): string => {
  const v = normalize(raw);
  if (!v) return "outro";
  if (v.includes("pix")) return "pix";
  if (v.includes("dinheiro") || v.includes("cash")) return "dinheiro";
  if (v.includes("cartao") || v.includes("cartão") || v.includes("credito") || v.includes("debito") || v.includes("card")) return "cartao";
  if (v.includes("outro")) return "outro";
  return "outro";
};

const LanchonetesStatsService = async (companyId: number, params: Params = {}): Promise<LanchonetesStats> => {
  const now = new Date();
  const todayStr = getBrazilISODateString(now);
  const startOfMonth = getBrazilMonthStartString(now);
  const daysEvolution = 30;
  const startEvolution = new Date(now.getTime() - (daysEvolution - 1) * 24 * 60 * 60 * 1000);
  const startEvolutionStr = getBrazilISODateString(startEvolution);

  const baseWhere = { companyId };

  const rangeStart = params.initialDate || startEvolutionStr;
  const rangeEnd = params.finalDate || todayStr;

  const [registrosHoje, registrosMes, registrosEvolution, despesasEvolution, registrosDelivery, registrosRange, despesasRange] = await Promise.all([
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
    GourmetDespesa.findAll({
      where: {
        ...baseWhere,
        dataVencimento: { [Op.gte]: startEvolutionStr, [Op.lte]: todayStr },
      },
      attributes: ["id", "valor", "dataVencimento"],
    }),
    GourmetFinanceiro.findAll({
      where: { ...baseWhere, tipo: "delivery" },
      attributes: ["id", "entregadorNome", "entregadorUserId"],
    }),
    GourmetFinanceiro.findAll({
      where: { ...baseWhere, dataVenda: { [Op.gte]: rangeStart, [Op.lte]: rangeEnd } },
      attributes: ["id", "valor", "tipo", "meiosPagamento", "formResponseId"],
    }),
    GourmetDespesa.findAll({
      where: { ...baseWhere, dataVencimento: { [Op.gte]: rangeStart, [Op.lte]: rangeEnd } },
      attributes: ["id", "valor"],
    }),
  ]);

  const totalVendasDia = registrosHoje.reduce((s, r) => s + Number((r as any).valor || 0), 0);
  const totalVendasMes = registrosMes.reduce((s, r) => s + Number((r as any).valor || 0), 0);

  const byDate: Record<string, { total: number; quantidade: number }> = {};
  for (let d = 0; d < daysEvolution; d++) {
    const date = new Date(startEvolution.getTime() + d * 24 * 60 * 60 * 1000);
    const key = getBrazilISODateString(date);
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

  const byDateDesp: Record<string, { total: number; quantidade: number }> = {};
  for (let d = 0; d < daysEvolution; d++) {
    const date = new Date(startEvolution.getTime() + d * 24 * 60 * 60 * 1000);
    const key = getBrazilISODateString(date);
    byDateDesp[key] = { total: 0, quantidade: 0 };
  }
  (despesasEvolution as any[]).forEach((r) => {
    const key = (r as any).dataVencimento;
    const val = Number((r as any).valor || 0);
    if (byDateDesp[key]) {
      byDateDesp[key].total += val;
      byDateDesp[key].quantidade += 1;
    }
  });
  const evolucaoDespesas = Object.entries(byDateDesp)
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

  // Delivery: carregar meio de pagamento por label no formulário (fallback)
  const deliverySemMeios = registrosRange
    .filter((r: any) => r.tipo === "delivery" && (!r.meiosPagamento || (Array.isArray(r.meiosPagamento) && r.meiosPagamento.length === 0)) && r.formResponseId)
    .map((r: any) => Number(r.formResponseId))
    .filter((id) => Number.isFinite(id));

  const formResponseMetodoMap = new Map<number, string>();
  if (deliverySemMeios.length > 0) {
    const uniqueIds = Array.from(new Set(deliverySemMeios));
    const responses = await FormResponse.findAll({
      where: { id: { [Op.in]: uniqueIds } },
      include: [
        {
          association: "answers",
          required: false,
          include: [{ association: "field", required: false, attributes: ["id", "label"] }],
        } as any,
      ],
    });
    responses.forEach((fr: any) => {
      const answers: ResponseAnswer[] = fr.answers || [];
      const found = answers.find((a: any) => isPaymentLabel(a?.field?.label || ""));
      const rawAnswer = found?.answer ?? (found as any)?.answerData ?? "";
      formResponseMetodoMap.set(fr.id, mapMetodo(rawAnswer));
    });
  }

  // Agregar por método (ratear híbrido)
  const byMetodo: Record<string, { total: number; quantidade: number }> = {};
  const addMetodo = (metodo: string, valor: number) => {
    const m = metodo || "outro";
    if (!byMetodo[m]) byMetodo[m] = { total: 0, quantidade: 0 };
    byMetodo[m].total += Number(valor || 0);
    byMetodo[m].quantidade += 1;
  };

  registrosRange.forEach((r: any) => {
    const mp = r.meiosPagamento;
    if (Array.isArray(mp) && mp.length > 0) {
      mp.forEach((p: any) => addMetodo(mapMetodo(p?.metodo), Number(p?.valor || 0)));
      return;
    }
    // Sem meiosPagamento: tentar inferir (delivery via FormResponse) ou cair em outro
    let metodo = "outro";
    if (r.tipo === "delivery" && r.formResponseId) {
      metodo = formResponseMetodoMap.get(Number(r.formResponseId)) || "outro";
    }
    addMetodo(metodo, Number(r.valor || 0));
  });

  const faturamentoPorMeioPagamento = Object.entries(byMetodo)
    .map(([metodo, v]) => ({ metodo, total: Math.round(v.total * 100) / 100, quantidade: v.quantidade }))
    .sort((a, b) => b.total - a.total);

  const toNum = (v: any): number => {
    if (v == null || v === "") return 0;
    const n = typeof v === "number" ? v : parseFloat(String(v));
    return Number.isFinite(n) ? n : 0;
  };
  const totalReceitas = registrosRange.reduce((s, r) => s + toNum((r as any).valor), 0);
  const totalDespesas = despesasRange.reduce((s, r) => s + toNum((r as any).valor), 0);
  const saldoGeral = Math.round((totalReceitas - totalDespesas) * 100) / 100;

  return {
    totalVendasDia: Math.round(totalVendasDia * 100) / 100,
    totalVendasMes: Math.round(totalVendasMes * 100) / 100,
    totalDespesas: Math.round(totalDespesas * 100) / 100,
    saldoGeral,
    evolucaoVendas,
    evolucaoDespesas,
    entregasPorEntregador,
    faturamentoPorMeioPagamento,
  };
};

export default LanchonetesStatsService;
