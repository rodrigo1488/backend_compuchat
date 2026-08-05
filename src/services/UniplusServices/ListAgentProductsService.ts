import { Op } from "sequelize";
import Product from "../../models/Product";

interface Request {
  companyId: number;
  q?: string;
  limit?: number;
}

/**
 * Lista produtos Compuchat para o Print Agent escolher o pai de uma variação UniPlus.
 */
const ListAgentProductsService = async ({
  companyId,
  q,
  limit = 200,
}: Request) => {
  const where: any = { companyId };
  const needle = String(q || "").trim();
  if (needle) {
    where[Op.or] = [
      { name: { [Op.iLike]: `%${needle}%` } },
      { idUniplus: { [Op.iLike]: `%${needle}%` } },
    ];
  }

  const products = await Product.findAll({
    where,
    attributes: ["id", "name", "value", "idUniplus", "grupo", "variablePrice"],
    include: [
      {
        association: "variations",
        attributes: ["id", "name"],
        include: [
          {
            association: "options",
            attributes: ["id", "label", "value", "idUniplus"],
          },
        ],
      },
    ],
    order: [["name", "ASC"]],
    limit: Math.min(Math.max(Number(limit) || 200, 1), 500),
  });

  return {
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      value: Number(p.value),
      idUniplus: p.idUniplus || null,
      grupo: p.grupo || null,
      variablePrice: Boolean(p.variablePrice),
      variations: ((p as any).variations || []).map((v: any) => ({
        id: v.id,
        name: v.name,
        options: (v.options || []).map((o: any) => ({
          id: o.id,
          label: o.label,
          value: Number(o.value),
          idUniplus: o.idUniplus || null,
        })),
      })),
    })),
  };
};

export default ListAgentProductsService;
