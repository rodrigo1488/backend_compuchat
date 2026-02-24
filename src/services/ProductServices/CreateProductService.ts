import Product from "../../models/Product";
import ProductVariation from "../../models/ProductVariation";
import ProductVariationOption from "../../models/ProductVariationOption";
import AppError from "../../errors/AppError";

export interface ProductVariationInput {
  name: string;
  options: Array<{ label: string; value: number }>;
}

interface Request {
  name: string;
  description?: string;
  value: number;
  quantity?: number;
  isMenuProduct?: boolean;
  variablePrice?: boolean;
  grupo?: string;
  imageUrl?: string;
  companyId: number;
  allowsHalfAndHalf?: boolean;
  halfAndHalfPriceRule?: string | null;
  halfAndHalfGrupo?: string | null;
  variations?: ProductVariationInput[];
}

const CreateProductService = async ({
  name,
  description,
  value,
  quantity = 0,
  isMenuProduct = false,
  variablePrice = false,
  allowsHalfAndHalf = false,
  halfAndHalfPriceRule,
  halfAndHalfGrupo,
  grupo,
  imageUrl,
  companyId,
  variations = [],
}: Request): Promise<Product> => {
  if (!name || name.trim() === "") {
    throw new AppError("ERR_PRODUCT_NAME_REQUIRED", 400);
  }

  if (value === undefined || value === null || value < 0) {
    throw new AppError("ERR_PRODUCT_VALUE_INVALID", 400);
  }

  const product = await Product.create({
    name: name.trim(),
    description: description?.trim() || null,
    value,
    quantity: quantity || 0,
    isMenuProduct: isMenuProduct || false,
    variablePrice: variablePrice || false,
    allowsHalfAndHalf: allowsHalfAndHalf || false,
    halfAndHalfPriceRule: halfAndHalfPriceRule?.trim() || null,
    halfAndHalfGrupo: halfAndHalfGrupo?.trim() || null,
    grupo: grupo?.trim() || null,
    imageUrl: imageUrl?.trim() || null,
    companyId,
  });

  for (const v of variations) {
    if (!v.name || !v.options || v.options.length === 0) continue;
    const variation = await ProductVariation.create({
      productId: product.id,
      name: v.name.trim(),
    });
    for (const opt of v.options) {
      if (opt.label == null || opt.label === "" || opt.value == null || Number(opt.value) < 0) continue;
      await ProductVariationOption.create({
        productVariationId: variation.id,
        label: String(opt.label).trim(),
        value: Number(opt.value),
      });
    }
  }

  const withVariations = await Product.findByPk(product.id, {
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });
  return withVariations ?? product;
};

export default CreateProductService;
