import { Op } from "sequelize";
import FormResponse from "../../models/FormResponse";

export interface ProdutoRelatório {
  productName: string;
  quantity: number;
  unitValue: number;
  total: number;
}

export interface RelatorioProdutosResult {
  produtos: ProdutoRelatório[];
  totalGeral: number;
  totalItens: number;
  startDate: string;
  endDate: string;
}

interface Params {
  companyId: number;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
}

/**
 * Agrega todos os menuItems de pedidos (FormResponse) cujo formResponseId
 * pertença à empresa e cuja data de criação esteja no intervalo fornecido.
 * Pedidos cancelados são excluídos.
 */
const RelatorioProdutosService = async ({
  companyId,
  startDate,
  endDate,
}: Params): Promise<RelatorioProdutosResult> => {
  const start = `${startDate} 00:00:00`;
  const end = `${endDate} 23:59:59`;

  // Buscar todas as respostas de formulário (pedidos) da empresa no período
  // O companyId está na Form, mas FormResponse não tem FK direta → filtramos
  // via include(Form) onde companyId === companyId
  const responses = await FormResponse.findAll({
    where: {
      submittedAt: { [Op.gte]: start, [Op.lte]: end },
      orderStatus: { [Op.notIn]: ["cancelado"] },
    },
    attributes: ["id", "metadata"],
    include: [
      {
        association: "form",
        attributes: ["companyId"],
        required: true,
        where: { companyId },
      },
    ],
  });

  // Agregar por nome de produto
  const map = new Map<string, { qty: number; unitValue: number }>();

  for (const response of responses) {
    const meta = (response as any).metadata || {};
    const items: any[] = Array.isArray(meta.menuItems) ? meta.menuItems : [];

    for (const item of items) {
      const name = (item.productName || item.name || "Item").trim();
      const qty = Number(item.quantity) || 0;
      const pv = Number(item.productValue) || 0;
      const at = Number(item.addonsTotal) || 0;
      const unit = Math.round((pv + at) * 100) / 100;

      if (qty <= 0) continue;

      const existing = map.get(name);
      if (existing) {
        existing.qty += qty;
      } else {
        map.set(name, { qty, unitValue: unit });
      }
    }
  }

  const produtos: ProdutoRelatório[] = Array.from(map.entries())
    .map(([productName, { qty, unitValue }]) => ({
      productName,
      quantity: qty,
      unitValue,
      total: Math.round(qty * unitValue * 100) / 100,
    }))
    .sort((a, b) => b.quantity - a.quantity);

  const totalGeral = Math.round(
    produtos.reduce((s, p) => s + p.total, 0) * 100
  ) / 100;

  const totalItens = produtos.reduce((s, p) => s + p.quantity, 0);

  return { produtos, totalGeral, totalItens, startDate, endDate };
};

export default RelatorioProdutosService;
