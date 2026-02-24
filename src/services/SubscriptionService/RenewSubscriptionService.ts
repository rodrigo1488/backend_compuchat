import { Op } from "sequelize";
import moment from "moment";
import Company from "../../models/Company";
import Plan from "../../models/Plan";
import { logger } from "../../utils/logger";
import AppError from "../../errors/AppError";
import { createPaymentIntent, processPreapprovalPayment } from "../PaymentService/MercadoPagoService";
import SendRenewalEmailService from "../EmailService/SendRenewalEmailService";
import User from "../../models/User";

interface RenewalResult {
  success: boolean;
  companyId: number;
  method: "preapproval" | "preference";
  message: string;
  preferenceId?: string;
  error?: string;
}

/**
 * Serviço para gerenciar renovações automáticas de assinaturas
 */
const RenewSubscriptionService = async (companyId: number): Promise<RenewalResult> => {
  try {
    const company = await Company.findByPk(companyId, {
      include: [{ model: Plan }],
    });

    if (!company) {
      throw new AppError(`Empresa ${companyId} não encontrada`, 404);
    }

    if (!company.status) {
      logger.warn(`Empresa ${companyId} está inativa, pulando renovação`);
      return {
        success: false,
        companyId,
        method: "preference",
        message: "Empresa inativa",
        error: "Empresa está inativa",
      };
    }

    if (!company.autoRenew) {
      logger.info(`Renovação automática desativada para empresa ${companyId}`);
      return {
        success: false,
        companyId,
        method: "preference",
        message: "Renovação automática desativada",
        error: "Renovação automática desativada pelo usuário",
      };
    }

    const plan = company.plan;
    if (!plan) {
      throw new AppError(`Plano não encontrado para empresa ${companyId}`, 404);
    }

    // Verificar se tem Preapproval ativo
    if (company.preapprovalId && company.preapprovalId.trim() !== "") {
      logger.info(`Processando renovação via Preapproval para empresa ${companyId}`);

      try {
        // Processar cobrança via Preapproval
        const paymentResult = await processPreapprovalPayment(company.preapprovalId, {
          companyId: company.id,
          planId: plan.id,
          transactionAmount: plan.value,
        });

        if (paymentResult.success) {
          // Calcular novo dueDate baseado na recorrência
          const recurrence = company.recurrence || "MENSAL";
          let daysToAdd = 30;
          if (recurrence === "ANUAL") {
            daysToAdd = 365;
          } else if (recurrence === "SEMESTRAL") {
            daysToAdd = 180;
          } else if (recurrence === "TRIMESTRAL") {
            daysToAdd = 90;
          } else if (recurrence === "MENSAL") {
            daysToAdd = 30;
          }

          const newDueDate = moment().add(daysToAdd, "days").format();

          await company.update({
            dueDate: newDueDate,
            lastRenewalAttempt: new Date(),
            renewalAttempts: 0,
          });

          logger.info(`Renovação via Preapproval bem-sucedida para empresa ${companyId}`);

          return {
            success: true,
            companyId,
            method: "preapproval",
            message: "Renovação processada via Preapproval",
          };
        } else {
          // Preapproval falhou, incrementar tentativas
          const attempts = (company.renewalAttempts || 0) + 1;
          await company.update({
            lastRenewalAttempt: new Date(),
            renewalAttempts: attempts,
          });

          // Se exceder 3 tentativas, desativar autoRenew e notificar
          if (attempts >= 3) {
            await company.update({ autoRenew: false });
            logger.warn(`Renovação automática desativada para empresa ${companyId} após ${attempts} tentativas falhas`);

            // TODO: Enviar email notificando sobre a desativação
            // await SendRenewalFailureEmailService({ company, attempts });
          }

          logger.error(`Falha ao processar Preapproval para empresa ${companyId}:`, {
            error: paymentResult.error,
            attempts,
          });

          return {
            success: false,
            companyId,
            method: "preapproval",
            message: "Falha ao processar Preapproval",
            error: paymentResult.error || "Erro desconhecido",
          };
        }
      } catch (error: any) {
        logger.error(`Erro ao processar Preapproval para empresa ${companyId}:`, error);

        const attempts = (company.renewalAttempts || 0) + 1;
        await company.update({
          lastRenewalAttempt: new Date(),
          renewalAttempts: attempts,
        });

        if (attempts >= 3) {
          await company.update({ autoRenew: false });
        }

        // Fallback: criar preferência manual
        return await createManualRenewalPreference(company, plan);
      }
    } else {
      // Não tem Preapproval, criar preferência manual
      logger.info(`Criando preferência de renovação manual para empresa ${companyId}`);
      return await createManualRenewalPreference(company, plan);
    }
  } catch (error: any) {
    logger.error(`Erro ao renovar assinatura da empresa ${companyId}:`, {
      error: error.message,
      stack: error.stack,
      companyId,
    });

    // Não lançar erro para não interromper o job cron
    // Retornar resultado de erro
    return {
      success: false,
      companyId,
      method: "preference",
      message: "Erro ao processar renovação",
      error: error.message || "Erro desconhecido",
    };
  }
};

/**
 * Cria preferência de pagamento para renovação manual
 */
const createManualRenewalPreference = async (
  company: Company,
  plan: Plan
): Promise<RenewalResult> => {
  try {
    // Buscar usuário admin para obter email
    const adminUser = await User.findOne({
      where: {
        companyId: company.id,
        profile: "admin",
      },
    });

    if (!adminUser) {
      throw new AppError(`Usuário admin não encontrado para empresa ${company.id}`, 404);
    }

    // Calcular novo dueDate baseado na recorrência
    const recurrence = company.recurrence || "MENSAL";
    let daysToAdd = 30;
    if (recurrence === "ANUAL") {
      daysToAdd = 365;
    } else if (recurrence === "SEMESTRAL") {
      daysToAdd = 180;
    } else if (recurrence === "TRIMESTRAL") {
      daysToAdd = 90;
    } else if (recurrence === "MENSAL") {
      daysToAdd = 30;
    }

    // Criar preferência de pagamento
    const preference = await createPaymentIntent({
      transactionAmount: plan.value,
      description: `Renovação assinatura - ${plan.name}`,
      metadata: {
        companyId: company.id,
        planId: plan.id,
        recurrence: recurrence,
        isRenewal: true,
      },
      payer: {
        email: company.email || adminUser.email,
        name: company.name,
      },
      notification_url: `${process.env.BACKEND_URL}/mercadopago/webhook`,
      customization: {
        theme: {
          elementsColor: process.env.MP_CHECKOUT_COLOR || "#00D9FF",
          headerColor: process.env.MP_CHECKOUT_HEADER_COLOR || "#0A0A0F",
        },
        texts: {
          valueProp: "Renovação automática da sua assinatura",
          securityCode: "Código de segurança do cartão",
        },
        installments: parseInt(process.env.MP_MAX_INSTALLMENTS || "12", 10),
      },
    });

    // Enviar email com link de pagamento
    await SendRenewalEmailService({
      company,
      plan,
      preferenceUrl: preference.initPoint,
      dueDate: moment(company.dueDate).format("DD/MM/YYYY"),
      newDueDate: moment().add(daysToAdd, "days").format("DD/MM/YYYY"),
    });

    // Atualizar última tentativa
    await company.update({
      lastRenewalAttempt: new Date(),
      renewalAttempts: (company.renewalAttempts || 0) + 1,
    });

    logger.info(`Preferência de renovação criada para empresa ${company.id}: ${preference.preferenceId}`);

    return {
      success: true,
      companyId: company.id,
      method: "preference",
      message: "Preferência de renovação criada e email enviado",
      preferenceId: preference.preferenceId,
    };
  } catch (error: any) {
    logger.error(`Erro ao criar preferência de renovação para empresa ${company.id}:`, {
      error: error.message,
      stack: error.stack,
      companyId: company.id,
    });

    return {
      success: false,
      companyId: company.id,
      method: "preference",
      message: "Erro ao criar preferência de renovação",
      error: error.message || "Erro desconhecido",
    };
  }
};

/**
 * Busca empresas que precisam de renovação (5 dias antes do vencimento)
 */
export const findCompaniesNeedingRenewal = async (): Promise<Company[]> => {
  const today = moment().startOf("day");
  const fiveDaysFromNow = moment().add(5, "days").endOf("day");

  const companies = await Company.findAll({
    where: {
      status: true,
      autoRenew: true,
      dueDate: {
        [Op.between]: [today.toISOString(), fiveDaysFromNow.toISOString()],
      } as any,
      // Não renovar se já tentou hoje
      [Op.or]: [
        { lastRenewalAttempt: null },
        { lastRenewalAttempt: { [Op.lt]: today.toDate() } },
      ],
    },
    include: [{ model: Plan }],
  });

  return companies;
};

export default RenewSubscriptionService;
