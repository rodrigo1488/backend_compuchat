import { resolveItemUniplusCodigo } from "../ValidateUniplusPreflightService";

describe("resolveItemUniplusCodigo com variação", () => {
  const byId = new Map<number, any>([
    [10, { id: 10, name: "Pizza Calabresa", idUniplus: null }],
  ]);
  const catalog: any[] = [];
  const optionById = new Map<number, any>([
    [101, { id: 101, idUniplus: "2001" }],
    [102, { id: 102, idUniplus: "2002" }],
  ]);

  it("usa idUniplus da option (variationOptionId)", () => {
    const code = resolveItemUniplusCodigo(
      { productId: 10, variationOptionId: 101, productName: "Pizza Calabresa G" },
      byId,
      catalog,
      optionById
    );
    expect(code).toBe("2001");
  });

  it("meio a meio prioriza baseOptionId sobre half options", () => {
    const code = resolveItemUniplusCodigo(
      {
        type: "halfAndHalf",
        productId: 10,
        baseOptionId: 102,
        half1OptionId: 101,
        productName: "Pizza G - Metade A / Metade B",
      },
      byId,
      catalog,
      optionById
    );
    expect(code).toBe("2002");
  });
});
