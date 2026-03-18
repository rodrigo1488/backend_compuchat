import { Request, Response } from "express";
import RegisterGourmetVendaService from "../services/GourmetFinanceiroServices/RegisterGourmetVendaService";
import AppError from "../errors/AppError";

interface ItemBody {
  productName: string;
  quantity: number;
  productValue: number;
}

export const registrarVenda = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { itens, total, meiosPagamento } = req.body as { itens?: ItemBody[]; total?: number; meiosPagamento?: any };

  if (!Array.isArray(itens) || itens.length === 0) {
    throw new AppError("ERR_PDV_ITENS_REQUIRED", 400);
  }

  const totalCalculado = itens.reduce((sum: number, item: ItemBody) => {
    const qty = Number(item.quantity) || 0;
    const val = Number(item.productValue) ?? 0;
    return sum + qty * val;
  }, 0);

  const totalRecebido = Number(total);
  if (isNaN(totalRecebido) || Math.abs(totalRecebido - totalCalculado) > 0.01) {
    throw new AppError("ERR_PDV_TOTAL_MISMATCH", 400);
  }

  const record = await RegisterGourmetVendaService({
    companyId,
    tipo: "pdv",
    valor: totalCalculado,
    meiosPagamento: meiosPagamento ?? null,
  });

  return res.status(200).json({
    id: record.id,
    total: Number(record.valor),
    itens: itens.map((i: ItemBody) => ({
      productName: i.productName || "",
      quantity: Number(i.quantity) || 0,
      productValue: Number(i.productValue) ?? 0,
    })),
    meiosPagamento: (record as any).meiosPagamento ?? meiosPagamento ?? null,
  });
};
