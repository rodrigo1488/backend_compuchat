import Product from "../../models/Product";
import ProductVariation from "../../models/ProductVariation";
import ProductVariationOption from "../../models/ProductVariationOption";
import AppError from "../../errors/AppError";

interface Request {
  productId: number;
  companyId: number;
}

const DuplicateProductService = async ({ productId, companyId }: Request): Promise<Product> => {
  const originalProduct = await Product.findByPk(productId, {
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });

  if (!originalProduct) {
    throw new AppError("ERR_PRODUCT_NOT_FOUND", 404);
  }

  if (originalProduct.companyId !== companyId) {
    throw new AppError("ERR_PRODUCT_NOT_FOUND", 404);
  }

  // Criar novo produto com dados do original
  const newProduct = await Product.create({
    name: `${originalProduct.name} (Cópia)`,
    description: originalProduct.description,
    value: originalProduct.value,
    quantity: originalProduct.quantity || 0,
    isMenuProduct: originalProduct.isMenuProduct,
    variablePrice: originalProduct.variablePrice,
    allowsHalfAndHalf: originalProduct.allowsHalfAndHalf,
    halfAndHalfPriceRule: originalProduct.halfAndHalfPriceRule,
    halfAndHalfGrupo: originalProduct.halfAndHalfGrupo,
    grupo: originalProduct.grupo,
    imageUrl: originalProduct.imageUrl,
    addOnGroupId: (originalProduct as any).addOnGroupId ?? null,
    idUniplus: originalProduct.idUniplus ?? null,
    companyId: companyId,
  });

  // Clonar variações e opções
  if (originalProduct.variations && originalProduct.variations.length > 0) {
    for (const variation of originalProduct.variations) {
      const newVariation = await ProductVariation.create({
        productId: newProduct.id,
        name: variation.name,
      });

      if (variation.options && variation.options.length > 0) {
        for (const option of variation.options) {
          await ProductVariationOption.create({
            productVariationId: newVariation.id,
            label: option.label,
            value: option.value,
          });
        }
      }
    }
  }

  // Retornar produto com variações
  const productWithVariations = await Product.findByPk(newProduct.id, {
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });

  return productWithVariations ?? newProduct;
};

export default DuplicateProductService;
