import { flattenAddOnGroups } from "../ListAgentProductsService";

describe("flattenAddOnGroups", () => {
  it("lista itens soltos do grupo (sem subgrupo)", () => {
    const flat = flattenAddOnGroups([
      {
        name: "Adicionais",
        items: [
          { id: 1, label: "Bacon extra", value: 5, idUniplus: null, addOnSubgroupId: null },
        ],
        subgroups: [],
      },
    ]);
    expect(flat).toEqual([
      { id: 1, label: "Bacon extra", value: 5, idUniplus: null, groupName: "Adicionais", subgroupName: null },
    ]);
  });

  it("lista itens de subgrupo com o nome do subgrupo", () => {
    const flat = flattenAddOnGroups([
      {
        name: "Bordas",
        items: [],
        subgroups: [
          {
            name: "Recheadas",
            items: [{ id: 2, label: "Catupiry", value: 8, idUniplus: null, addOnSubgroupId: 10 }],
          },
        ],
      },
    ]);
    expect(flat).toEqual([
      { id: 2, label: "Catupiry", value: 8, idUniplus: null, groupName: "Bordas", subgroupName: "Recheadas" },
    ]);
  });

  it("NÃO duplica item de subgrupo (group.items também traz o addOnGroupId denormalizado)", () => {
    // Reflete o formato real retornado pelo Sequelize: o item de subgrupo tem
    // addOnGroupId preenchido, então aparece tanto em group.items quanto em
    // subgroup.items — o filtro por addOnSubgroupId evita a duplicação.
    const catupiryItem = { id: 2, label: "Catupiry", value: 8, idUniplus: null, addOnSubgroupId: 10 };
    const flat = flattenAddOnGroups([
      {
        name: "Bordas",
        items: [catupiryItem],
        subgroups: [{ name: "Recheadas", items: [catupiryItem] }],
      },
    ]);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toEqual({
      id: 2,
      label: "Catupiry",
      value: 8,
      idUniplus: null,
      groupName: "Bordas",
      subgroupName: "Recheadas",
    });
  });

  it("mix: item solto + item de subgrupo no mesmo grupo, sem duplicar", () => {
    const bordaItem = { id: 3, label: "Borda", value: 6, idUniplus: null, addOnSubgroupId: 20 };
    const soltoItem = { id: 4, label: "Refrigerante", value: 7, idUniplus: "9999", addOnSubgroupId: null };
    const flat = flattenAddOnGroups([
      {
        name: "Grupo Misto",
        items: [bordaItem, soltoItem],
        subgroups: [{ name: "Bordas", items: [bordaItem] }],
      },
    ]);
    expect(flat).toHaveLength(2);
    expect(flat.find((f) => f.id === 3)).toEqual({
      id: 3,
      label: "Borda",
      value: 6,
      idUniplus: null,
      groupName: "Grupo Misto",
      subgroupName: "Bordas",
    });
    expect(flat.find((f) => f.id === 4)).toEqual({
      id: 4,
      label: "Refrigerante",
      value: 7,
      idUniplus: "9999",
      groupName: "Grupo Misto",
      subgroupName: null,
    });
  });

  it("ordena por label", () => {
    const flat = flattenAddOnGroups([
      {
        name: "Adicionais",
        items: [
          { id: 1, label: "Zebra", value: 1, idUniplus: null, addOnSubgroupId: null },
          { id: 2, label: "Abacate", value: 1, idUniplus: null, addOnSubgroupId: null },
        ],
        subgroups: [],
      },
    ]);
    expect(flat.map((f) => f.label)).toEqual(["Abacate", "Zebra"]);
  });
});
