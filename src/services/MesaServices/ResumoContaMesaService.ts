import { Op } from "sequelize";
import FormResponse from "../../models/FormResponse";
import Mesa from "../../models/Mesa";
import AppError from "../../errors/AppError";

interface PedidoResumo {
  id: number;
  protocol: string;
  submittedAt: Date;
  total: number;
  menuItems: Array<{ productName?: string; quantity: number; productValue?: number }>;
}

interface Response {
  pedidos: PedidoResumo[];
  total: number;
  mesa: { id: number; number: string; name: string; type?: string };
  cliente?: { id: number; name: string; number: string } | null;
}

const calcTotalFromMenuItems = (metadata: any): number => {
  const items = metadata?.menuItems || [];
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum: number, item: any) => {
    const qty = Number(item.quantity) || 0;
    const val = Number(item.productValue) ?? 0;
    return sum + qty * val;
  }, 0);
};

const ResumoContaMesaService = async (mesaId: number, companyId: number): Promise<Response> => {
  const mesa = await Mesa.findOne({
    where: { id: mesaId, companyId },
    include: [{ association: "contact", attributes: ["id", "name", "number"] }],
  });

  if (!mesa) {
    throw new AppError("ERR_MESA_NOT_FOUND", 404);
  }

  const cliente =
    mesa.contact != null
      ? { id: (mesa.contact as any).id, name: (mesa.contact as any).name, number: (mesa.contact as any).number }
      : null;

  if (!mesa.sessionId) {
    return {
      pedidos: [],
      total: 0,
      mesa: { id: mesa.id, number: mesa.number, name: mesa.name, type: (mesa as any).type || "mesa" },
      cliente,
    };
  }

  const responses = await FormResponse.findAll({
    where: {
      mesaSessionId: mesa.sessionId,
      [Op.or]: [
        { orderStatus: { [Op.notIn]: ["faturado", "cancelado"] } },
        { orderStatus: null },
      ],
    },
    order: [["submittedAt", "ASC"]],
    attributes: ["id", "protocol", "submittedAt", "metadata"],
  });

  const pedidos: PedidoResumo[] = responses.map((r) => {
    const meta = (r as any).metadata || {};
    const total = calcTotalFromMenuItems(meta);
    return {
      id: r.id,
      protocol: r.protocol || `#${r.id}`,
      submittedAt: r.submittedAt,
      total,
      menuItems: meta.menuItems || [],
    };
  });

  const total = pedidos.reduce((s, p) => s + p.total, 0);

  return {
    pedidos,
    total,
    mesa: { id: mesa.id, number: mesa.number, name: mesa.name, type: (mesa as any).type || "mesa" },
    cliente,
  };
};

export default ResumoContaMesaService;
