import { Op } from "sequelize";
import Product from "../models/Product";
import AppError from "../errors/AppError";

/**
 * Catálogo de um cardápio.
 * mode ausente ou "all": todos os produtos com isMenuProduct.
 * mode "custom": somente os ids em menuProductIds (interseção com isMenuProduct na consulta).
 */
export const menuProductIdsForSettings = (settings: unknown): number[] | null => {
  if (!settings || typeof settings !== "object") return null;
  const raw = settings as { menuCatalogMode?: string; menuProductIds?: unknown };
  if (raw.menuCatalogMode !== "custom") return null;
  if (!Array.isArray(raw.menuProductIds)) return [];
  const ids = raw.menuProductIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids));
};

export const filterProductsByMenuCatalog = <T extends { id: number }>(
  products: T[],
  settings: unknown
): T[] => {
  const ids = menuProductIdsForSettings(settings);
  if (ids == null) return products;
  if (ids.length === 0) return [];
  const allowed = new Set(ids);
  return products.filter((product) => allowed.has(Number(product.id)));
};

export const productIdsFromMenuItems = (
  items: Array<{
    productId?: number;
    half1ProductId?: number;
    half2ProductId?: number;
  }>
): number[] => {
  const ids = new Set<number>();
  items.forEach((item) => {
    [item.productId, item.half1ProductId, item.half2ProductId].forEach((raw) => {
      const id = Number(raw);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    });
  });
  return Array.from(ids);
};

/** Cardápio personalizado só aceita produtos marcados para aquele formulário. */
export const assertProductsInCustomMenu = async (
  items: Array<{
    productId?: number;
    half1ProductId?: number;
    half2ProductId?: number;
  }>,
  companyId: number,
  settings: unknown
): Promise<void> => {
  const allowedIds = menuProductIdsForSettings(settings);
  if (allowedIds == null) return;
  const requested = productIdsFromMenuItems(items);
  if (requested.length === 0) return;
  const allowed = new Set(allowedIds);
  const found = await Product.findAll({
    where: {
      companyId,
      isMenuProduct: true,
      id: { [Op.in]: requested },
    },
    attributes: ["id"],
  });
  const foundIds = new Set(found.map((product) => product.id));
  const blocked = requested.some((id) => !allowed.has(id) || !foundIds.has(id));
  if (blocked) {
    throw new AppError("Um ou mais produtos não fazem parte deste cardápio.", 400);
  }
};
