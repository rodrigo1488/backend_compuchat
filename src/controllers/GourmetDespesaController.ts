import * as Yup from "yup";
import { Request, Response } from "express";
import { Op } from "sequelize";
import GourmetDespesa from "../models/GourmetDespesa";
import AppError from "../errors/AppError";
import ExtractDespesaFromDocumentService from "../services/GourmetFinanceiroServices/ExtractDespesaFromDocumentService";

const storeSchema = Yup.object().shape({
  descricao: Yup.string().required("Descrição é obrigatória").max(255),
  observacoes: Yup.string().nullable(),
  valor: Yup.number().required("Valor é obrigatório").min(0, "Valor deve ser >= 0"),
  dataVencimento: Yup.string().required("Data de vencimento é obrigatória").matches(/^\d{4}-\d{2}-\d{2}$/, "Use o formato AAAA-MM-DD"),
});

const updateSchema = storeSchema;

export const index = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { search, initialDate, finalDate } = req.query as { search?: string; initialDate?: string; finalDate?: string };

  const where: any = { companyId };

  if (search && String(search).trim()) {
    const term = `%${String(search).trim()}%`;
    where[Op.or] = [
      { descricao: { [Op.iLike]: term } },
      { observacoes: { [Op.iLike]: term } },
    ];
  }

  if (initialDate || finalDate) {
    where.dataVencimento = {};
    if (initialDate) where.dataVencimento[Op.gte] = initialDate;
    if (finalDate) where.dataVencimento[Op.lte] = finalDate;
  }

  const despesas = await GourmetDespesa.findAll({
    where,
    order: [["dataVencimento", "DESC"], ["id", "DESC"]],
    attributes: ["id", "descricao", "observacoes", "valor", "dataVencimento", "createdAt", "updatedAt"],
  });

  return res.json(despesas.map((d) => ({
    id: d.id,
    descricao: d.descricao,
    observacoes: d.observacoes ?? "",
    valor: Number((d as any).valor),
    dataVencimento: d.dataVencimento,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  })));
};

export const show = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { id } = req.params;

  const despesa = await GourmetDespesa.findOne({
    where: { id: Number(id), companyId },
  });

  if (!despesa) {
    throw new AppError("ERR_DESPESA_NOT_FOUND", 404);
  }

  return res.json({
    id: despesa.id,
    descricao: despesa.descricao,
    observacoes: despesa.observacoes ?? "",
    valor: Number((despesa as any).valor),
    dataVencimento: despesa.dataVencimento,
    createdAt: despesa.createdAt,
    updatedAt: despesa.updatedAt,
  });
};

export const store = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;

  await storeSchema.validate(req.body, { abortEarly: false }).catch((err: Yup.ValidationError) => {
    throw new AppError(err.errors?.join(" ") || "Validation failed", 400);
  });

  const { descricao, observacoes, valor, dataVencimento } = req.body;

  const despesa = await GourmetDespesa.create({
    companyId,
    descricao: String(descricao).trim(),
    observacoes: observacoes ? String(observacoes).trim() : null,
    valor: Number(valor),
    dataVencimento: String(dataVencimento),
  });

  return res.status(201).json({
    id: despesa.id,
    descricao: despesa.descricao,
    observacoes: despesa.observacoes ?? "",
    valor: Number((despesa as any).valor),
    dataVencimento: despesa.dataVencimento,
    createdAt: despesa.createdAt,
    updatedAt: despesa.updatedAt,
  });
};

export const update = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { id } = req.params;

  await updateSchema.validate(req.body, { abortEarly: false }).catch((err: Yup.ValidationError) => {
    throw new AppError(err.errors?.join(" ") || "Validation failed", 400);
  });

  const despesa = await GourmetDespesa.findOne({
    where: { id: Number(id), companyId },
  });

  if (!despesa) {
    throw new AppError("ERR_DESPESA_NOT_FOUND", 404);
  }

  const { descricao, observacoes, valor, dataVencimento } = req.body;

  await despesa.update({
    descricao: String(descricao).trim(),
    observacoes: observacoes ? String(observacoes).trim() : null,
    valor: Number(valor),
    dataVencimento: String(dataVencimento),
  });

  return res.json({
    id: despesa.id,
    descricao: despesa.descricao,
    observacoes: despesa.observacoes ?? "",
    valor: Number((despesa as any).valor),
    dataVencimento: despesa.dataVencimento,
    createdAt: despesa.createdAt,
    updatedAt: despesa.updatedAt,
  });
};

export const destroy = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { id } = req.params;

  const despesa = await GourmetDespesa.findOne({
    where: { id: Number(id), companyId },
  });

  if (!despesa) {
    throw new AppError("ERR_DESPESA_NOT_FOUND", 404);
  }

  await despesa.destroy();
  return res.status(204).send();
};

export const extractFromDocument = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const file = (req as any).file as Express.Multer.File | undefined;

  if (!file || !file.buffer) {
    throw new AppError("ERR_DESPESA_FILE_REQUIRED", 400);
  }

  const fileBase64 = Buffer.from(file.buffer).toString("base64");
  const extracted = await ExtractDespesaFromDocumentService({
    companyId,
    fileBase64,
    mimeType: file.mimetype,
  });

  return res.json(extracted);
};
