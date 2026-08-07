import Product from "../../models/Product";

interface MenuItem {
  productId: number;
  quantity: number;
  productName?: string;
  productValue?: number;
  grupo?: string;
  observation?: string;
  addons?: Array<{ label: string; value: number }>;
  addonsTotal?: number;
}

interface CustomField {
  label: string;
  answer: string;
}

interface Request {
  menuItems: MenuItem[];
  customerName: string;
  customerPhone: string;
  customFields?: CustomField[];
  protocol?: string;
  /** Número/nome da mesa (pedidos de mesa ou garçom) */
  tableNumber?: string;
  /** Nome do garçom que anotou o pedido */
  garcomName?: string;
  /** Taxa de entrega (se houver) */
  deliveryFee?: number;
  /** Total já calculado (incluindo taxa de entrega e desconto) */
  total?: number;
  /** Código do cupom aplicado (se houver) */
  couponCode?: string;
  /** Valor do desconto do cupom (se houver) */
  couponDiscount?: number;
}

const FormatMenuOrderMessage = async ({
  menuItems,
  customerName,
  customerPhone,
  customFields = [],
  protocol,
  tableNumber,
  garcomName,
  deliveryFee = 0,
  total,
  couponCode,
  couponDiscount = 0,
}: Request): Promise<string> => {
  // Buscar informações completas dos produtos se não estiverem no menuItem
  const productIds = menuItems.map((item) => item.productId);
  const products = await Product.findAll({
    where: { id: productIds },
  });

  // Criar mapa de produtos para acesso rápido
  const productMap = new Map(
    products.map((p) => [p.id, { name: p.name, value: p.value, grupo: p.grupo || "Outros" }])
  );

  // Agrupar itens por grupo
  const itemsByGroup: { [key: string]: MenuItem[] } = {};

  menuItems.forEach((item) => {
    const product = productMap.get(item.productId);
    const grupo = item.grupo || product?.grupo || "Outros";
    const productName = item.productName || product?.name || "Produto";
    const productValue = item.productValue || product?.value || 0;

    if (!itemsByGroup[grupo]) {
      itemsByGroup[grupo] = [];
    }

    itemsByGroup[grupo].push({
      ...item,
      productName,
      productValue,
      grupo,
    });
  });

  // Construir mensagem
  let message = "🍽️ *NOVO PEDIDO - CARDÁPIO*\n\n";
  if (protocol) {
    message += `📋 *Protocolo:* ${protocol}\n`;
  }
  if (tableNumber) {
    message += `🪑 *Mesa:* ${tableNumber}\n`;
  }
  if (garcomName) {
    message += `👨‍💼 *Garçom:* ${garcomName}\n`;
  }
  message += `👤 *Cliente:* ${customerName}\n`;
  message += `📱 *Telefone:* ${customerPhone}\n\n`;
  message += "📋 *ITENS DO PEDIDO:*\n\n";

  const lineTotal = (item: MenuItem) => {
    const pv = item.productValue || 0;
    const addonsTotal = item.addonsTotal || 0;
    return (pv + addonsTotal) * item.quantity;
  };

  let calculatedTotal = total;
  if (calculatedTotal == null) {
    calculatedTotal = 0;
    Object.keys(itemsByGroup).forEach((grupo) => {
      itemsByGroup[grupo].forEach((item) => {
        calculatedTotal += lineTotal(item);
      });
    });
    calculatedTotal += deliveryFee || 0;
  }

  Object.keys(itemsByGroup).forEach((grupo) => {
    message += `*${grupo}*\n`;
    itemsByGroup[grupo].forEach((item) => {
      const itemTotal = lineTotal(item);
      message += `• ${item.productName} - Qtd: ${item.quantity} - R$ ${itemTotal.toFixed(2).replace(".", ",")}\n`;
      if (item.addons && item.addons.length > 0) {
        item.addons.forEach((a) => {
          message += `  └ ${a.label} + R$ ${Number(a.value).toFixed(2).replace(".", ",")}\n`;
        });
      }
      if (item.observation && String(item.observation).trim()) {
        message += `  📝 Obs: ${String(item.observation).trim()}\n`;
      }
    });
    message += "\n";
  });

  // Mostrar subtotal, taxa de entrega, desconto (se houver) e total
  const itemsSubtotal = calculatedTotal - (deliveryFee || 0) + (couponDiscount || 0);
  if ((deliveryFee && deliveryFee > 0) || (couponDiscount && couponDiscount > 0)) {
    message += `💰 *Subtotal:* R$ ${itemsSubtotal.toFixed(2).replace(".", ",")}\n`;
  }
  if (deliveryFee && deliveryFee > 0) {
    message += `🚚 *Taxa de entrega:* R$ ${deliveryFee.toFixed(2).replace(".", ",")}\n`;
  }
  if (couponDiscount && couponDiscount > 0) {
    message += `🎟️ *Cupom${couponCode ? ` (${couponCode})` : ""}:* - R$ ${couponDiscount.toFixed(2).replace(".", ",")}\n`;
  }
  message += `💰 *TOTAL:* R$ ${calculatedTotal.toFixed(2).replace(".", ",")}\n`;

  // Adicionar campos customizados se houver
  if (customFields && customFields.length > 0) {
    message += "\n";
    customFields.forEach((field) => {
      if (field.answer && field.answer.trim() !== "") {
        message += `*${field.label}:* ${field.answer}\n`;
      }
    });
  }

  return message;
};

export default FormatMenuOrderMessage;
