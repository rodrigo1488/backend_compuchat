import Product from "../../models/Product";
import { logger } from "../../utils/logger";

export interface UniplusProductUpsertItem {
  codigo: string;
  nome: string;
  preco: number;
}

export interface UniplusProductUpsertResult {
  codigo: string;
  action: "created" | "updated" | "skipped";
  productId?: number;
  error?: string;
}

interface Request {
  companyId: number;
  products: UniplusProductUpsertItem[];
}

/**
 * Upsert de produtos UniPlus → Compuchat pela chave idUniplus (= produto.codigo).
 */
const UpsertUniplusProductsService = async ({
  companyId,
  products,
}: Request): Promise<{ results: UniplusProductUpsertResult[] }> => {
  const results: UniplusProductUpsertResult[] = [];
  const list = Array.isArray(products) ? products.slice(0, 100) : [];

  for (const raw of list) {
    const codigo = String(raw?.codigo || "").trim().slice(0, 20);
    const nome = String(raw?.nome || "").trim().slice(0, 255);
    const preco = Number(raw?.preco);

    if (!codigo) {
      results.push({
        codigo: String(raw?.codigo || ""),
        action: "skipped",
        error: "codigo ausente",
      });
      continue;
    }
    if (!nome) {
      results.push({
        codigo,
        action: "skipped",
        error: "nome ausente",
      });
      continue;
    }
    if (!Number.isFinite(preco) || preco < 0) {
      results.push({
        codigo,
        action: "skipped",
        error: "preco inválido",
      });
      continue;
    }

    try {
      const existing = await Product.findOne({
        where: { companyId, idUniplus: codigo },
      });

      if (existing) {
        const nextValue = Math.round(preco * 100) / 100;
        let changed = false;
        if (existing.name !== nome) {
          existing.name = nome;
          changed = true;
        }
        if (Number(existing.value) !== nextValue) {
          existing.value = nextValue;
          changed = true;
        }
        if (changed) {
          await existing.save();
        }
        results.push({
          codigo,
          action: "updated",
          productId: existing.id,
        });
      } else {
        const created = await Product.create({
          name: nome,
          description: null,
          value: Math.round(preco * 100) / 100,
          quantity: 0,
          isMenuProduct: true,
          variablePrice: false,
          allowsHalfAndHalf: false,
          halfAndHalfPriceRule: null,
          halfAndHalfGrupo: null,
          grupo: "Outros",
          imageUrl: null,
          companyId,
          addOnGroupId: null,
          idUniplus: codigo,
        });
        results.push({
          codigo,
          action: "created",
          productId: created.id,
        });
      }
    } catch (err: any) {
      const msg = err?.message || String(err);
      logger.warn(
        `UpsertUniplusProducts codigo=${codigo} companyId=${companyId}: ${msg}`
      );
      results.push({
        codigo,
        action: "skipped",
        error: msg,
      });
    }
  }

  return { results };
};

export default UpsertUniplusProductsService;
