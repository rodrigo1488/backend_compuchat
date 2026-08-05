import { Op } from "sequelize";
import Product from "../../models/Product";
import ProductVariation from "../../models/ProductVariation";
import ProductVariationOption from "../../models/ProductVariationOption";
import AppError from "../../errors/AppError";
import { logger } from "../../utils/logger";

export interface AttachUniplusVariationRequest {
  companyId: number;
  codigo: string;
  parentProductId: number;
  variationName?: string;
  optionLabel?: string;
  preco?: number;
}

export interface AttachUniplusVariationResult {
  parentProductId: number;
  variationId: number;
  optionId: number;
  removedProductId?: number;
}

async function findOptionByCodigo(
  companyId: number,
  codigo: string
): Promise<ProductVariationOption | null> {
  return ProductVariationOption.findOne({
    where: { idUniplus: codigo },
    include: [
      {
        model: ProductVariation,
        required: true,
        include: [
          {
            model: Product,
            required: true,
            where: { companyId },
            attributes: ["id", "companyId", "name"],
          },
        ],
      },
    ],
  });
}

function suggestLabelFromName(name: string, fallback: string): string {
  const tokens = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const last = tokens[tokens.length - 1] || "";
  if (/^(p|m|g|gg|pp|xg|xp)$/i.test(last)) {
    return last.toUpperCase();
  }
  if (name.trim()) return name.trim().slice(0, 40);
  return fallback;
}

/**
 * Anexa um codigo UniPlus como opção de variação de um Product pai.
 * Remove o Product standalone com o mesmo codigo (folha sync), se existir.
 */
const AttachUniplusVariationService = async ({
  companyId,
  codigo: rawCodigo,
  parentProductId,
  variationName: rawVariationName,
  optionLabel: rawOptionLabel,
  preco,
}: AttachUniplusVariationRequest): Promise<AttachUniplusVariationResult> => {
  const codigo = String(rawCodigo || "").trim().slice(0, 20);
  if (!codigo) {
    throw new AppError("ERR_UNIPLUS_ATTACH_CODIGO_REQUIRED", 400);
  }

  const parent = await Product.findOne({
    where: { id: parentProductId, companyId },
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });
  if (!parent) {
    throw new AppError("ERR_PRODUCT_NOT_FOUND", 404);
  }

  const variationName =
    String(rawVariationName || "Tamanho").trim() || "Tamanho";
  let optionLabel = String(rawOptionLabel || "").trim();

  const nextValue =
    preco != null && Number.isFinite(Number(preco)) && Number(preco) >= 0
      ? Math.round(Number(preco) * 100) / 100
      : null;

  const existingOption = await findOptionByCodigo(companyId, codigo);
  if (
    existingOption?.productVariation &&
    existingOption.productVariation.productId !== parent.id
  ) {
    throw new AppError(
      `ERR_UNIPLUS_CODIGO_IN_OTHER_OPTION:${existingOption.productVariation.productId}`,
      409
    );
  }

  let removedProductId: number | undefined;
  let priceFromStandalone = 0;

  const standalone = await Product.findOne({
    where: {
      companyId,
      idUniplus: codigo,
      id: { [Op.ne]: parent.id },
    },
    include: [
      { association: "variations", include: [{ association: "options" }] },
    ],
  });

  if (standalone) {
    const vars = (standalone as any).variations || [];
    const optionCount = vars.reduce(
      (n: number, v: any) => n + (v.options?.length || 0),
      0
    );
    if (optionCount > 0) {
      throw new AppError(
        "ERR_UNIPLUS_ATTACH_NOT_LEAF: produto com o codigo já tem variações; remova manualmente",
        409
      );
    }
    if (!optionLabel) {
      optionLabel = suggestLabelFromName(standalone.name || "", codigo);
    }
    priceFromStandalone = Number.isFinite(Number(standalone.value))
      ? Math.round(Number(standalone.value) * 100) / 100
      : 0;
    await standalone.destroy();
    removedProductId = standalone.id;
    logger.info(
      `Uniplus attach-variation: removed standalone productId=${standalone.id} codigo=${codigo} → parent=${parent.id}`
    );
  }

  if (!optionLabel) {
    optionLabel = codigo;
  }

  await Product.update(
    { idUniplus: null },
    { where: { companyId, idUniplus: codigo } }
  );

  let variation =
    ((parent as any).variations || []).find(
      (v: ProductVariation) =>
        String(v.name || "").trim().toLowerCase() ===
        variationName.toLowerCase()
    ) || null;

  if (!variation) {
    variation = await ProductVariation.create({
      productId: parent.id,
      name: variationName,
    });
  }

  const optionValue =
    nextValue != null
      ? nextValue
      : priceFromStandalone > 0
        ? priceFromStandalone
        : Number(parent.value) || 0;

  let option =
    (await ProductVariationOption.findOne({
      where: { productVariationId: variation.id, idUniplus: codigo },
    })) ||
    (await ProductVariationOption.findOne({
      where: { productVariationId: variation.id, label: optionLabel },
    }));

  if (option) {
    option.label = optionLabel;
    option.value = optionValue;
    option.idUniplus = codigo;
    await option.save();
  } else {
    option = await ProductVariationOption.create({
      productVariationId: variation.id,
      label: optionLabel,
      value: optionValue,
      idUniplus: codigo,
    });
  }

  if (!parent.variablePrice) {
    parent.variablePrice = true;
    await parent.save();
  }

  return {
    parentProductId: parent.id,
    variationId: variation.id,
    optionId: option.id,
    removedProductId,
  };
};

export default AttachUniplusVariationService;
