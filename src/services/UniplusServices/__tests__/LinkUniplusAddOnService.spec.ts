jest.mock("../../../models/AddOnItem", () => ({
  __esModule: true,
  default: {
    findOne: jest.fn(),
  },
}));

jest.mock("../../../models/AddOnGroup", () => ({
  __esModule: true,
  default: class {},
}));

jest.mock("../ReleaseUniplusCodigoService", () => ({
  __esModule: true,
  releaseUniplusCodigo: jest.fn(),
}));

import LinkUniplusAddOnService from "../LinkUniplusAddOnService";

const AddOnItem = require("../../../models/AddOnItem").default;
const { releaseUniplusCodigo } = require("../ReleaseUniplusCodigoService");

describe("LinkUniplusAddOnService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    releaseUniplusCodigo.mockResolvedValue({
      clearedOptionIds: [],
      removedProductId: undefined,
    });
  });

  it("vincula um adicional existente ao codigo informado", async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const target = { id: 5, label: "Bacon extra", idUniplus: null, save };
    AddOnItem.findOne.mockResolvedValue(target);

    const result = await LinkUniplusAddOnService({
      companyId: 1,
      codigo: "9101",
      addOnItemId: 5,
    });

    expect(releaseUniplusCodigo).toHaveBeenCalledWith(1, "9101", {
      exceptAddOnItemId: 5,
    });
    expect(target.idUniplus).toBe("9101");
    expect(save).toHaveBeenCalled();
    expect(result).toEqual({
      addOnItemId: 5,
      label: "Bacon extra",
      removedProductId: undefined,
      clearedOptionIds: [],
    });
  });

  it("lança erro quando o adicional não existe/não pertence a company", async () => {
    AddOnItem.findOne.mockResolvedValue(null);

    let caught: any = null;
    try {
      await LinkUniplusAddOnService({
        companyId: 1,
        codigo: "9101",
        addOnItemId: 999,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.message)).toContain("ERR_UNIPLUS_ADDON_NOT_FOUND");
  });

  it("reatribui codigo que estava vinculado a um produto avulso (propaga removedProductId)", async () => {
    releaseUniplusCodigo.mockResolvedValue({
      clearedOptionIds: [],
      removedProductId: 77,
    });
    const save = jest.fn().mockResolvedValue(undefined);
    const target = { id: 8, label: "Borda recheada", idUniplus: null, save };
    AddOnItem.findOne.mockResolvedValue(target);

    const result = await LinkUniplusAddOnService({
      companyId: 1,
      codigo: "321",
      addOnItemId: 8,
    });

    expect(result.removedProductId).toBe(77);
    expect(target.idUniplus).toBe("321");
  });

  it("valida codigo vazio", async () => {
    let caught: any = null;
    try {
      await LinkUniplusAddOnService({
        companyId: 1,
        codigo: "",
        addOnItemId: 5,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(String(caught.message)).toContain("ERR_UNIPLUS_ATTACH_CODIGO_REQUIRED");
  });
});
