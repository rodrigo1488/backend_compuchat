import {
  buildProductDisplayName,
  collectVariationOptionIds,
  halfFlavorLabels,
  resolveMenuItemForMessage,
  resolveVariationOptionId,
} from "../FormatMenuOrderMessage";

describe("FormatMenuOrderMessage helpers", () => {
  const productMap = new Map([
    [10, { name: "Pizza Calabresa", value: 30, grupo: "Pizzas" }],
  ]);
  const optionMap = new Map([
    [101, { id: 101, label: "G", value: 45 }],
    [102, { id: 102, label: "M", value: 35 }],
  ]);

  it("resolve variationOptionId ou optionId", () => {
    expect(resolveVariationOptionId({ productId: 1, quantity: 1, variationOptionId: 101 })).toBe(101);
    expect(resolveVariationOptionId({ productId: 1, quantity: 1, optionId: 102 })).toBe(102);
  });

  it("monta nome com variação quando só veio productId + optionId", () => {
    const resolved = resolveMenuItemForMessage(
      {
        productId: 10,
        quantity: 1,
        productName: "Pizza Calabresa",
        optionId: 101,
      },
      productMap as any,
      optionMap as any
    );
    expect(resolved.productName).toBe("Pizza Calabresa - G");
    expect(resolved.productValue).toBe(45);
  });

  it("não duplica label se productName já contém variação", () => {
    const name = buildProductDisplayName("Pizza Calabresa", "Pizza Calabresa - G", "G");
    expect(name).toBe("Pizza Calabresa - G");
  });

  it("meio a meio mantém os dois sabores e o tamanho", () => {
    const resolved = resolveMenuItemForMessage(
      {
        productId: 10,
        quantity: 1,
        type: "halfAndHalf",
        productName: "Meio a meio: Pizza Calabresa / Mussarela",
        half1Name: "Pizza Calabresa",
        half2Name: "Mussarela",
        baseOptionId: 101,
      },
      productMap as any,
      optionMap as any
    );
    expect(resolved.productName).toBe("Meio a meio: Pizza Calabresa / Mussarela (G)");
  });

  it("meio a meio não deixa o tamanho substituir o segundo sabor", () => {
    const resolved = resolveMenuItemForMessage(
      {
        productId: 10,
        quantity: 1,
        type: "halfAndHalf",
        productName: "Pizza Calabresa - G",
        half1Name: "Pizza Calabresa",
        half2Name: "Mussarela",
        baseOptionId: 101,
      },
      productMap as any,
      optionMap as any
    );
    expect(resolved.productName).toBe("Meio a meio: Pizza Calabresa / Mussarela (G)");
    expect(halfFlavorLabels(resolved, productMap as any)).toEqual([
      "Pizza Calabresa",
      "Mussarela",
    ]);
  });

  it("meio a meio sem nome salvo usa os dois sabores do cadastro", () => {
    const map = new Map<number, { name: string; value: number; grupo: string }>([
      [10, { name: "Pizza Calabresa", value: 30, grupo: "Pizzas" }],
      [11, { name: "Mussarela", value: 28, grupo: "Pizzas" }],
    ]);
    const resolved = resolveMenuItemForMessage(
      {
        productId: 10,
        quantity: 1,
        type: "halfAndHalf",
        half1ProductId: 10,
        half2ProductId: 11,
        baseOptionId: 101,
      },
      map as any,
      optionMap as any
    );
    expect(resolved.productName).toBe("Meio a meio: Pizza Calabresa / Mussarela (G)");
  });

  it("coleta optionIds de meio a meio e combo", () => {
    const ids = collectVariationOptionIds([
      {
        productId: 10,
        quantity: 1,
        type: "halfAndHalf",
        baseOptionId: 101,
        half2OptionId: 102,
      },
      {
        productId: 20,
        quantity: 1,
        type: "combo",
        comboItems: [{ productId: 30, variationOptionId: 102 }],
      },
    ]);
    expect(ids.sort()).toEqual([101, 102]);
  });
});
