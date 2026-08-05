jest.mock("../../../models/Product", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock("../../../models/ProductVariationOption", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock("../../../models/ProductVariation", () => ({
  __esModule: true,
  default: class {},
}));

import { releaseUniplusCodigo } from "../ReleaseUniplusCodigoService";

const Product = require("../../../models/Product").default;
const ProductVariationOption =
  require("../../../models/ProductVariationOption").default;

describe("releaseUniplusCodigo", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Product.update.mockResolvedValue([0]);
  });

  it("variação → avulso: desvincula a option (não deleta) e não mexe em Product", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    ProductVariationOption.findOne.mockResolvedValue({
      id: 5,
      idUniplus: "9001",
      label: "G",
      save,
    });
    Product.findOne.mockResolvedValue(null);

    const result = await releaseUniplusCodigo(1, "9001", {});

    expect(save).toHaveBeenCalled();
    expect(result.clearedOptionIds).toEqual([5]);
    expect(result.removedProductId).toBeUndefined();
  });

  it("avulso-folha → variação: destroi o Product standalone sem variações", async () => {
    ProductVariationOption.findOne.mockResolvedValue(null);
    const destroy = jest.fn().mockResolvedValue(undefined);
    Product.findOne.mockResolvedValue({
      id: 7,
      name: "Guarana Lata",
      value: 5.5,
      variations: [],
      destroy,
    });

    const result = await releaseUniplusCodigo(1, "8001", {
      exceptProductId: 99,
    });

    expect(destroy).toHaveBeenCalled();
    expect(result.removedProductId).toBe(7);
    expect(result.removedProductName).toBe("Guarana Lata");
    expect(result.removedProductValue).toBe(5.5);
  });

  it("avulso-com-variações → erro ERR_UNIPLUS_ATTACH_NOT_LEAF", async () => {
    ProductVariationOption.findOne.mockResolvedValue(null);
    Product.findOne.mockResolvedValue({
      id: 8,
      name: "Pizza Pai",
      value: 40,
      variations: [{ options: [{ id: 1 }] }],
      destroy: jest.fn(),
    });

    let caught: any = null;
    try {
      await releaseUniplusCodigo(1, "7001", {});
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.message)).toContain("ERR_UNIPLUS_ATTACH_NOT_LEAF");
  });
});
