import { resolveDeliveryPrintDeviceIds } from "../deliveryPrintTargets";

describe("resolveDeliveryPrintDeviceIds", () => {
  const items = [
    { grupo: "Pizzas", productName: "Mussarela" },
    { grupo: "Bebidas", productName: "Suco" },
  ];

  it("mantém as impressoras de delivery e acrescenta a do grupo quando o pedido tem o grupo", () => {
    const ids = resolveDeliveryPrintDeviceIds(
      {
        deliveryPrintDeviceIds: [1],
        deliveryGroupPrintConfig: [{ printDeviceId: 2, groupNames: ["Pizzas"] }],
      },
      items
    );
    expect(ids).toEqual([1, 2]);
  });

  it("não acrescenta a impressora extra se o grupo não está no pedido", () => {
    const ids = resolveDeliveryPrintDeviceIds(
      {
        deliveryPrintDeviceIds: [1],
        deliveryGroupPrintConfig: [{ printDeviceId: 2, groupNames: ["Sobremesas"] }],
      },
      items
    );
    expect(ids).toEqual([1]);
  });

  it("não repete a impressora que já recebe todo delivery", () => {
    const ids = resolveDeliveryPrintDeviceIds(
      {
        deliveryPrintDeviceIds: [2],
        deliveryGroupPrintConfig: [{ printDeviceId: 2, groupNames: ["pizzas"] }],
      },
      items
    );
    expect(ids).toEqual([2]);
  });

  it("compara o grupo sem diferenciar maiúsculas", () => {
    const ids = resolveDeliveryPrintDeviceIds(
      {
        deliveryPrintDeviceIds: [],
        deliveryGroupPrintConfig: [{ printDeviceId: 4, groupNames: ["bebidas"] }],
      },
      items
    );
    expect(ids).toEqual([4]);
  });

  it("usa a impressora legada quando não há lista de delivery", () => {
    const ids = resolveDeliveryPrintDeviceIds(
      {
        printDeviceId: 9,
        deliveryGroupPrintConfig: [{ printDeviceId: 3, groupNames: ["*"] }],
      },
      items
    );
    expect(ids).toEqual([9, 3]);
  });
});
