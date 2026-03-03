import AddOnGroup from "../../models/AddOnGroup";
import AddOnSubgroup from "../../models/AddOnSubgroup";
import AddOnItem from "../../models/AddOnItem";
import AppError from "../../errors/AppError";
import sequelize from "../../database";

export interface AddOnItemInput {
  label: string;
  value: number;
  order?: number;
}

export interface AddOnSubgroupInput {
  name: string;
  order?: number;
  items: AddOnItemInput[];
}

interface Request {
  companyId: number;
  name: string;
  subgroups?: AddOnSubgroupInput[];
  items?: AddOnItemInput[];
}

const CreateAddOnGroupService = async ({
  companyId,
  name,
  subgroups = [],
  items = [],
}: Request): Promise<AddOnGroup> => {
  if (!name || !name.trim()) {
    throw new AppError("ERR_ADDON_GROUP_NAME_REQUIRED", 400);
  }

  const t = await sequelize.transaction();
  try {
    const group = await AddOnGroup.create(
      { companyId, name: name.trim() },
      { transaction: t }
    );

    for (let i = 0; i < subgroups.length; i++) {
      const sg = subgroups[i];
      const subgroup = await AddOnSubgroup.create(
        {
          addOnGroupId: group.id,
          name: sg.name.trim(),
          order: sg.order ?? i,
        },
        { transaction: t }
      );
      for (let j = 0; j < (sg.items || []).length; j++) {
        const it = sg.items[j];
        if (!it.label || it.value == null || Number(it.value) < 0) continue;
        await AddOnItem.create(
          {
            addOnGroupId: group.id,
            addOnSubgroupId: subgroup.id,
            label: it.label.trim(),
            value: Number(it.value),
            order: it.order ?? j,
          },
          { transaction: t }
        );
      }
    }

    for (let j = 0; j < items.length; j++) {
      const it = items[j];
      if (!it.label || it.value == null || Number(it.value) < 0) continue;
      await AddOnItem.create(
        {
          addOnGroupId: group.id,
          addOnSubgroupId: null,
          label: it.label.trim(),
          value: Number(it.value),
          order: it.order ?? j,
        },
        { transaction: t }
      );
    }

    await t.commit();
    const created = await AddOnGroup.findByPk(group.id, {
      include: [
        { model: AddOnSubgroup, as: "subgroups", include: [{ model: AddOnItem, as: "items" }] },
        { model: AddOnItem, as: "items" },
      ],
    });
    return created!;
  } catch (err) {
    await t.rollback();
    throw err;
  }
};

export default CreateAddOnGroupService;
