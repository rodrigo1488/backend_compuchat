import * as Yup from "yup";
import { Request, Response } from "express";
import { getIO } from "../libs/socket";
import CreateProductService from "../services/ProductServices/CreateProductService";
import UpdateProductService from "../services/ProductServices/UpdateProductService";
import DeleteProductService from "../services/ProductServices/DeleteProductService";
import DuplicateProductService from "../services/ProductServices/DuplicateProductService";
import ListProductsService from "../services/ProductServices/ListProductsService";
import ShowProductService from "../services/ProductServices/ShowProductService";
import Product from "../models/Product";
import Form from "../models/Form";
import AddOnGroup from "../models/AddOnGroup";
import AddOnSubgroup from "../models/AddOnSubgroup";
import AddOnItem from "../models/AddOnItem";
import GrupoAddOn from "../models/GrupoAddOn";
import AppError from "../errors/AppError";

export const index = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { searchParam, pageNumber, isMenuProduct, grupo } = req.query;

  const result = await ListProductsService({
    companyId,
    searchParam: searchParam as string,
    pageNumber: pageNumber ? Number(pageNumber) : 1,
    isMenuProduct: isMenuProduct !== undefined ? isMenuProduct === "true" : undefined,
    grupo: grupo as string,
  });

  return res.json(result);
};

export const show = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;
  const { companyId } = req.user;

  const productId = Number(id);
  if (isNaN(productId)) {
    throw new AppError("ERR_PRODUCT_NOT_FOUND", 404);
  }

  const product = await ShowProductService({
    productId,
    companyId,
  });

  return res.json(product);
};

export const store = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const data = { ...req.body };
  if (!data.allowsHalfAndHalf || data.halfAndHalfPriceRule === "" || data.halfAndHalfPriceRule === "null" || data.halfAndHalfPriceRule == null) {
    data.halfAndHalfPriceRule = null;
  }

  const schema = Yup.object().shape({
    name: Yup.string().required("Nome do produto é obrigatório"),
    description: Yup.string().nullable(),
    value: Yup.number()
      .required("Valor é obrigatório")
      .min(0, "Valor deve ser maior ou igual a zero"),
    quantity: Yup.number()
      .integer("Quantidade deve ser um número inteiro")
      .min(0, "Quantidade deve ser maior ou igual a zero")
      .nullable(),
    isMenuProduct: Yup.boolean().nullable(),
    variablePrice: Yup.boolean().nullable(),
    allowsHalfAndHalf: Yup.boolean().nullable(),
    halfAndHalfPriceRule: Yup.string()
      .transform((v) => (v === "" || v == null || v === "null" ? null : v))
      .nullable()
      .test(
        "oneOfOrNull",
        "halfAndHalfPriceRule must be one of the following values: max, fixed, average",
        (v) => v == null || v === "" || v === "null" || ["max", "fixed", "average"].includes(String(v))
      ),
    halfAndHalfGrupo: Yup.string().nullable(),
    grupo: Yup.string().nullable(),
    imageUrl: Yup.string().nullable(),
    addOnGroupId: Yup.number().nullable(),
    variations: Yup.array()
      .of(
        Yup.object().shape({
          name: Yup.string().required(),
          options: Yup.array()
            .of(
              Yup.object().shape({
                label: Yup.string().required(),
                value: Yup.number().min(0).required(),
              })
            )
            .min(1)
            .required(),
        })
      )
      .nullable(),
  }).test(
    "halfAndHalfRule",
    "Regra de cobrança é obrigatória quando 'Permitir meio a meio' está ativo",
    (obj: any) => {
      if (obj?.allowsHalfAndHalf === true) {
        return obj?.halfAndHalfPriceRule != null && ["max", "fixed", "average"].includes(obj.halfAndHalfPriceRule);
      }
      return true;
    }
  );

  try {
    await schema.validate(data);
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const product = await CreateProductService({
    ...data,
    companyId,
  });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-product`, {
    action: "create",
    product,
  });

  return res.status(200).json(product);
};

export const update = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { id } = req.params;
  const { companyId } = req.user;
  const data = { ...req.body };
  if (!data.allowsHalfAndHalf || data.halfAndHalfPriceRule === "" || data.halfAndHalfPriceRule === "null" || data.halfAndHalfPriceRule == null) {
    data.halfAndHalfPriceRule = null;
  }

  const schema = Yup.object().shape({
    name: Yup.string().nullable(),
    description: Yup.string().nullable(),
    value: Yup.number()
      .min(0, "Valor deve ser maior ou igual a zero")
      .nullable(),
    quantity: Yup.number()
      .integer("Quantidade deve ser um número inteiro")
      .min(0, "Quantidade deve ser maior ou igual a zero")
      .nullable(),
    isMenuProduct: Yup.boolean().nullable(),
    allowsHalfAndHalf: Yup.boolean().nullable(),
    halfAndHalfPriceRule: Yup.string()
      .transform((v) => (v === "" || v == null || v === "null" ? null : v))
      .nullable()
      .test(
        "oneOfOrNull",
        "halfAndHalfPriceRule must be one of the following values: max, fixed, average",
        (v) => v == null || v === "" || v === "null" || ["max", "fixed", "average"].includes(String(v))
      ),
    halfAndHalfGrupo: Yup.string().nullable(),
    grupo: Yup.string().nullable(),
    imageUrl: Yup.string().nullable(),
    addOnGroupId: Yup.number().nullable(),
    variations: Yup.array()
      .of(
        Yup.object().shape({
          name: Yup.string().required(),
          options: Yup.array()
            .of(
              Yup.object().shape({
                label: Yup.string().required(),
                value: Yup.number().min(0).required(),
              })
            )
            .min(1)
            .required(),
        })
      )
      .nullable(),
  }).test(
    "halfAndHalfRule",
    "Regra de cobrança é obrigatória quando 'Permitir meio a meio' está ativo",
    (obj: any) => {
      if (obj?.allowsHalfAndHalf === true) {
        return obj?.halfAndHalfPriceRule != null && ["max", "fixed", "average"].includes(obj.halfAndHalfPriceRule);
      }
      return true;
    }
  );

  try {
    await schema.validate(data);
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const product = await UpdateProductService({
    productId: Number(id),
    companyId,
    ...data,
  });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-product`, {
    action: "update",
    product,
  });

  return res.status(200).json(product);
};

export const destroy = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { id } = req.params;
  const { companyId } = req.user;

  await DeleteProductService({
    productId: Number(id),
    companyId,
  });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-product`, {
    action: "delete",
    productId: Number(id),
  });

  return res.status(200).json({ message: "Produto deletado com sucesso" });
};

export const getPublicMenuProducts = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { publicId } = req.params as any;

  // Buscar formulário pelo publicId para obter companyId
  const form = await Form.findOne({
    where: { publicId, isActive: true },
    attributes: ["id", "companyId"],
  });

  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  // Buscar todos os produtos de cardápio da empresa (com variações e addOnGroupId)
  const products = await Product.findAll({
    where: {
      companyId: form.companyId,
      isMenuProduct: true,
    },
    order: [["grupo", "ASC"], ["name", "ASC"]],
    attributes: ["id", "name", "description", "value", "grupo", "isMenuProduct", "variablePrice", "imageUrl", "allowsHalfAndHalf", "halfAndHalfPriceRule", "halfAndHalfGrupo", "addOnGroupId"],
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });

  // Mapeamento grupo -> addOnGroupId (atribuição por categoria)
  const grupoAssignments = await GrupoAddOn.findAll({
    where: { companyId: form.companyId },
    attributes: ["grupo", "addOnGroupId"],
  });
  const grupoToAddOnId = new Map(grupoAssignments.map((a) => [a.grupo, a.addOnGroupId]));

  const addOnGroupIds = new Set<number>();
  products.forEach((p) => {
    const resolved = p.addOnGroupId ?? (p.grupo ? grupoToAddOnId.get(p.grupo) : undefined);
    if (resolved) addOnGroupIds.add(resolved);
  });

  const addOnGroupsRaw = await AddOnGroup.findAll({
    where: { id: Array.from(addOnGroupIds), companyId: form.companyId },
    include: [
      { model: AddOnSubgroup, as: "subgroups", include: [{ model: AddOnItem, as: "items" }] },
      { model: AddOnItem, as: "items" },
    ],
  });

  const addOnGroupMap = new Map(
    addOnGroupsRaw.map((g) => {
      const subs = (g.subgroups || []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0));
      const subgroups = subs.map((sg: any) => ({
        id: sg.id,
        name: sg.name,
        order: sg.order,
        items: (sg.items || []).slice().sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).map((it: any) => ({ id: it.id, label: it.label, value: Number(it.value), order: it.order })),
      }));
      const rootItems = (g.items || []).filter((it: any) => !it.addOnSubgroupId).sort((a: any, b: any) => (a.order ?? 0) - (b.order ?? 0)).map((it: any) => ({ id: it.id, label: it.label, value: Number(it.value), order: it.order }));
      return [
        g.id,
        { id: g.id, name: g.name, subgroups, items: rootItems },
      ];
    })
  );

  const productsWithAddOn = products.map((p) => {
    const po = p.toJSON() as Record<string, unknown> & { addOnGroupId?: number | null; grupo?: string };
    const resolvedAddOnId = po.addOnGroupId ?? (po.grupo ? grupoToAddOnId.get(po.grupo) : undefined);
    po.addOnGroup = resolvedAddOnId ? addOnGroupMap.get(resolvedAddOnId) ?? null : null;
    return po;
  });

  return res.json({
    products: productsWithAddOn,
    count: productsWithAddOn.length,
  });
};

export const uploadImage = async (req: Request, res: Response): Promise<Response> => {
  const file = req.file as Express.Multer.File;
  if (!file || !file.filename) {
    throw new AppError("ERR_PRODUCT_IMAGE_REQUIRED", 400);
  }
  const baseUrl = process.env.BACKEND_URL || "http://localhost:3333";
  const imageUrl = `${baseUrl.replace(/\/$/, "")}/public/products/${file.filename}`;
  return res.json({ imageUrl });
};

export const duplicate = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { id } = req.params;
  const { companyId } = req.user;

  const product = await DuplicateProductService({
    productId: Number(id),
    companyId,
  });

  const io = getIO();
  io.to(`company-${companyId}-mainchannel`).emit(`company-${companyId}-product`, {
    action: "create",
    product,
  });

  return res.status(200).json(product);
};
