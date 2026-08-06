import { Op } from "sequelize";
import Product from "../../models/Product";
import AddOnGroup from "../../models/AddOnGroup";
import AddOnSubgroup from "../../models/AddOnSubgroup";
import AddOnItem from "../../models/AddOnItem";

interface Request {
  companyId: number;
  q?: string;
  limit?: number;
}

async function listAddOns(companyId: number) {
  const groups = await AddOnGroup.findAll({
    where: { companyId },
    order: [["name", "ASC"]],
    include: [
      {
        model: AddOnSubgroup,
        as: "subgroups",
        include: [{ model: AddOnItem, as: "items" }],
      },
      { model: AddOnItem, as: "items" },
    ],
  });

  const flat: Array<{
    id: number;
    label: string;
    value: number;
    idUniplus: string | null;
    groupName: string;
    subgroupName: string | null;
  }> = [];

  for (const group of groups) {
    for (const item of (group as any).items || []) {
      flat.push({
        id: item.id,
        label: item.label,
        value: Number(item.value),
        idUniplus: item.idUniplus || null,
        groupName: group.name,
        subgroupName: null,
      });
    }
    for (const subgroup of (group as any).subgroups || []) {
      for (const item of subgroup.items || []) {
        flat.push({
          id: item.id,
          label: item.label,
          value: Number(item.value),
          idUniplus: item.idUniplus || null,
          groupName: group.name,
          subgroupName: subgroup.name,
        });
      }
    }
  }

  flat.sort((a, b) => a.label.localeCompare(b.label));
  return flat;
}

/**
 * Lista produtos Compuchat para o Print Agent escolher o pai de uma variação UniPlus,
 * e adicionais (AddOnItem) pra vincular como item próprio no pedido UniPlus.
 */
const ListAgentProductsService = async ({
  companyId,
  q,
  limit = 1000,
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
    limit: Math.min(Math.max(Number(limit) || 1000, 1), 1000),
  });

  const addOns = await listAddOns(companyId);

  return {
    addOns,
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
