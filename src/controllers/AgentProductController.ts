import { Response } from "express";
import UpsertUniplusProductsService from "../services/UniplusServices/UpsertUniplusProductsService";
import AttachUniplusVariationService from "../services/UniplusServices/AttachUniplusVariationService";
import ListAgentProductsService from "../services/UniplusServices/ListAgentProductsService";
import { PrintDeviceAuthRequest } from "../middleware/isPrintDeviceAuth";

export const upsert = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const products = Array.isArray(req.body?.products) ? req.body.products : [];

  const data = await UpsertUniplusProductsService({ companyId, products });
  return res.status(200).json(data);
};

export const list = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const q = String(req.query?.q || "");
  const limit = Number(req.query?.limit) || 200;
  const data = await ListAgentProductsService({ companyId, q, limit });
  return res.status(200).json(data);
};

export const attachVariation = async (
  req: PrintDeviceAuthRequest,
  res: Response
): Promise<Response> => {
  const companyId = Number(req.companyId);
  const data = await AttachUniplusVariationService({
    companyId,
    codigo: String(req.body?.codigo || ""),
    parentProductId: Number(req.body?.parentProductId),
    variationName: req.body?.variationName,
    optionLabel: req.body?.optionLabel,
    preco:
      req.body?.preco != null && req.body?.preco !== ""
        ? Number(req.body.preco)
        : undefined,
  });
  return res.status(200).json(data);
};
