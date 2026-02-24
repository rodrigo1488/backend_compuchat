import Product from "../../models/Product";

interface MenuItem {
  productId: number;
  quantity: number;
  productName?: string;
  productValue?: number;
  grupo?: string;
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
  /** Total já calculado (incluindo taxa de entrega) */
  total?: number;
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

  let calculatedTotal = total;
  if (calculatedTotal == null) {
    calculatedTotal = 0;
    // Adicionar itens agrupados por grupo
    Object.keys(itemsByGroup).forEach((grupo) => {
      itemsByGroup[grupo].forEach((item) => {
        const itemTotal = (item.productValue || 0) * item.quantity;
        calculatedTotal += itemTotal;
      });
    });
    // Adicionar taxa de entrega se houver
    calculatedTotal += deliveryFee || 0;
  }

  // Adicionar itens agrupados por grupo na mensagem
  Object.keys(itemsByGroup).forEach((grupo) => {
    message += `*${grupo}*\n`;
    itemsByGroup[grupo].forEach((item) => {
      const itemTotal = (item.productValue || 0) * item.quantity;
      message += `• ${item.productName} - Qtd: ${item.quantity} - R$ ${itemTotal.toFixed(2).replace(".", ",")}\n`;
    });
    message += "\n";
  });

  // Mostrar subtotal, taxa de entrega (se houver) e total
  const itemsSubtotal = calculatedTotal - (deliveryFee || 0);
  if (deliveryFee && deliveryFee > 0) {
    message += `💰 *Subtotal:* R$ ${itemsSubtotal.toFixed(2).replace(".", ",")}\n`;
    message += `🚚 *Taxa de entrega:* R$ ${deliveryFee.toFixed(2).replace(".", ",")}\n`;
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
