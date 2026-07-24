import { Response } from "express";
import UpsertUniplusProductsService from "../services/UniplusServices/UpsertUniplusProductsService";
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
