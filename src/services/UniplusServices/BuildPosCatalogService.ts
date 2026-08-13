import crypto from "crypto";
import User from "../../models/User";
import Mesa from "../../models/Mesa";
import Product from "../../models/Product";
import AddOnGroup from "../../models/AddOnGroup";
import AddOnSubgroup from "../../models/AddOnSubgroup";
import AddOnItem from "../../models/AddOnItem";
import PrintDevice from "../../models/PrintDevice";
import GrupoAddOn from "../../models/GrupoAddOn";

interface Request {
  companyId: number;
}

const imageHash = (url: string): string =>
  crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);

const pinFromUser = (user: User): string => {
  const settings = (user.availabilitySettings || {}) as Record<string, unknown>;
  const pin = settings.posPin ?? settings.pin;
  return pin != null ? String(pin).trim() : "";
};

const BuildPosCatalogService = async ({ companyId }: Request) => {
  const [users, mesas, products, addOnGroups, printers, grupoAssignments] =
    await Promise.all([
      User.findAll({
        where: { companyId, active: true },
        attributes: ["id", "name", "profile", "defaultRoute", "availabilitySettings"],
        order: [["name", "ASC"]],
      }),
      Mesa.findAll({
        where: { companyId },
        attributes: [
          "id",
          "number",
          "name",
          "type",
          "status",
          "formId",
          "displayOrder",
          "section",
        ],
        include: [{ association: "contact", attributes: ["id", "name"] }],
        order: [
          ["displayOrder", "ASC"],
          ["number", "ASC"],
        ],
      }),
      Product.findAll({
        where: { companyId, isMenuProduct: true },
        attributes: [
          "id",
          "name",
          "description",
          "value",
          "grupo",
          "variablePrice",
          "isCombo",
          "allowsHalfAndHalf",
          "halfAndHalfPriceRule",
          "halfAndHalfGrupo",
          "idUniplus",
          "imageUrl",
          "addOnGroupId",
        ],
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
        order: [
          ["grupo", "ASC"],
          ["name", "ASC"],
        ],
      }),
      AddOnGroup.findAll({
        where: { companyId },
        attributes: ["id", "name", "required", "minItems", "maxItems"],
        include: [
          {
            model: AddOnSubgroup,
            as: "subgroups",
            attributes: ["id", "name", "required", "minItems", "maxItems", "order"],
            include: [
              {
                model: AddOnItem,
                as: "items",
                attributes: ["id", "label", "value", "idUniplus", "order", "addOnSubgroupId"],
              },
            ],
          },
          {
            model: AddOnItem,
            as: "items",
            attributes: [
              "id",
              "label",
              "value",
              "idUniplus",
              "order",
              "addOnSubgroupId",
              "addOnGroupId",
            ],
          },
        ],
        order: [["name", "ASC"]],
      }),
      PrintDevice.findAll({
        where: { companyId },
        attributes: ["id", "deviceId", "name"],
        order: [["name", "ASC"]],
      }),
      GrupoAddOn.findAll({
        where: { companyId },
        attributes: ["grupo", "addOnGroupId"],
      }),
    ]);

  const images: Array<{ id: string; url: string; hash: string }> = [];
  const seenUrls = new Set<string>();
  const pushImage = (url?: string | null) => {
    const u = String(url || "").trim();
    if (!u || seenUrls.has(u)) return;
    seenUrls.add(u);
    const hash = imageHash(u);
    images.push({ id: hash, url: u, hash });
  };

  const productPayload = products.map((p) => {
    pushImage(p.imageUrl);
    return {
      id: p.id,
      name: p.name,
      description: p.description || "",
      value: Number(p.value) || 0,
      grupo: p.grupo || "Outros",
      variablePrice: Boolean(p.variablePrice),
      isCombo: Boolean(p.isCombo),
      allowsHalfAndHalf: Boolean(p.allowsHalfAndHalf),
      halfAndHalfPriceRule: p.halfAndHalfPriceRule || "max",
      halfAndHalfGrupo: p.halfAndHalfGrupo || null,
      idUniplus: p.idUniplus || null,
      imageUrl: p.imageUrl || null,
      imageId: p.imageUrl ? imageHash(p.imageUrl) : null,
      addOnGroupId: p.addOnGroupId || null,
      variations: ((p as any).variations || []).map((v: any) => ({
        id: v.id,
        name: v.name,
        options: (v.options || []).map((o: any) => ({
          id: o.id,
          label: o.label,
          value: Number(o.value) || 0,
          idUniplus: o.idUniplus || null,
        })),
      })),
    };
  });

  const groups = addOnGroups.map((g) => ({
    id: g.id,
    name: g.name,
    required: Boolean(g.required),
    minItems: Number(g.minItems) || 0,
    maxItems: g.maxItems == null ? null : Number(g.maxItems),
    items: (g.items || [])
      .filter((it) => !it.addOnSubgroupId)
      .map((it) => ({
        id: it.id,
        label: it.label,
        value: Number(it.value) || 0,
        idUniplus: it.idUniplus || null,
        subgroupId: null,
      })),
    subgroups: (g.subgroups || []).map((sg) => ({
      id: sg.id,
      name: sg.name,
      required: Boolean(sg.required),
      minItems: Number(sg.minItems) || 0,
      maxItems: sg.maxItems == null ? null : Number(sg.maxItems),
      items: (sg.items || []).map((it) => ({
        id: it.id,
        label: it.label,
        value: Number(it.value) || 0,
        idUniplus: it.idUniplus || null,
        subgroupId: sg.id,
      })),
    })),
  }));

  const productGroups = Array.from(
    new Set(productPayload.map((p) => p.grupo).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const catalogVersion = Date.now();
  const updatedAt = new Date().toISOString();

  return {
    catalogVersion,
    updatedAt,
    companyId,
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      profile: u.profile,
      defaultRoute: u.defaultRoute || null,
      pin: pinFromUser(u),
    })),
    mesas: mesas.map((m) => ({
      id: m.id,
      number: m.number,
      name: m.name,
      type: m.type || "mesa",
      status: m.status || "livre",
      formId: m.formId || null,
      displayOrder: m.displayOrder || 0,
      section: m.section || null,
      contactName: (m as any).contact?.name || null,
    })),
    products: productPayload,
    groups,
    productGroups,
    grupoAddOn: grupoAssignments.map((a) => ({
      grupo: a.grupo,
      addOnGroupId: a.addOnGroupId,
    })),
    printers: printers.map((p) => ({
      id: p.id,
      deviceId: p.deviceId,
      name: p.name || p.deviceId,
    })),
    images,
  };
};

export default BuildPosCatalogService;
