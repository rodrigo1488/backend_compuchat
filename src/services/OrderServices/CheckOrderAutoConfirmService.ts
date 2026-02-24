import Form from "../../models/Form";
import FormResponse from "../../models/FormResponse";
import { Op } from "sequelize";
import { logger } from "../../utils/logger";
import UpdateOrderStatusService from "./UpdateOrderStatusService";

/**
 * Busca pedidos em status "novo" que devem ser automaticamente
 * avançados para "confirmado" conforme autoConfirmMinutes do formulário.
 */
const CheckOrderAutoConfirmService = async (): Promise<void> => {
  try {
    const now = new Date();

    const forms = await Form.findAll({
      where: {
        isActive: true,
      },
    });

    for (const form of forms) {
      const formSettings = form.settings as any;
      if (formSettings?.formType !== "cardapio") continue;

      const autoConfirmMinutes = Number(formSettings?.autoConfirmMinutes) || 0;
      if (autoConfirmMinutes <= 0) continue;

      const cutoffTime = new Date(now.getTime() - autoConfirmMinutes * 60 * 1000);

      const responses = await FormResponse.findAll({
        where: {
          formId: form.id,
          orderStatus: "novo",
          submittedAt: { [Op.lte]: cutoffTime },
        },
      });

      for (const response of responses) {
        try {
          await UpdateOrderStatusService({
            formId: form.id,
            responseId: response.id,
            orderStatus: "confirmado",
            companyId: form.companyId,
          });
          logger.info(
            `CheckOrderAutoConfirm: Pedido ${response.id} (${response.protocol || response.id}) avançado para confirmado`
          );
        } catch (err: any) {
          logger.error(`CheckOrderAutoConfirm: Erro ao atualizar pedido ${response.id}:`, err?.message);
        }
      }
    }
  } catch (err: any) {
    logger.error("CheckOrderAutoConfirm: Erro geral:", err?.message);
  }
};

export default CheckOrderAutoConfirmService;
