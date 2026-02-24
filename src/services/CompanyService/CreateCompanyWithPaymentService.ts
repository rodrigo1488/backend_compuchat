import * as Yup from "yup";
import { Op } from "sequelize";
import AppError from "../../errors/AppError";
import Company from "../../models/Company";
import Plan from "../../models/Plan";
import User from "../../models/User";
import Setting from "../../models/Setting";
import Invoices from "../../models/Invoices";
import CreateCompanyService from "./CreateCompanyService";
import CreateInvoiceService from "../InvoicesService/CreateInvoiceService";
import { processPayment } from "../PaymentService/MercadoPagoService";
import { getIO } from "../../libs/socket";
import moment from "moment";
import { logger } from "../../utils/logger";
import sequelize from "../../database";
import { hash } from "bcryptjs";

interface CompanyData {
  name: string;
  phone?: string;
  email?: string;
  password?: string;
  status?: boolean;
  planId?: number;
  campaignsEnabled?: boolean;
  recurrence?: string;
}

interface PaymentData {
  transactionAmount: number;
  paymentMethodId: string;
  token: string;
  installments: number;
  identificationType: string;
  identificationNumber: string;
  payer: {
    email: string;
    firstName?: string;
    lastName?: string;
  };
  issuerId?: string;
}

interface CreateCompanyWithPaymentData {
  companyData: CompanyData;
  paymentData: PaymentData;
}

const CreateCompanyWithPaymentService = async (
  data: CreateCompanyWithPaymentData
): Promise<{ company: Company; payment: any; invoice: any }> => {
  const { companyData, paymentData } = data;

  logger.info("Iniciando criação de empresa com pagamento:", {
    companyName: companyData.name,
    companyEmail: companyData.email,
    planId: companyData.planId,
    transactionAmount: paymentData.transactionAmount,
  });

  // Validar se o plano existe
  let plan: Plan | null = null;
  if (companyData.planId) {
    plan = await Plan.findByPk(companyData.planId);
    if (!plan) {
      logger.error("Plano não encontrado:", companyData.planId);
      throw new AppError("Plano não encontrado", 404);
    }

    // Validar se o valor do pagamento corresponde ao valor do plano
    if (paymentData.transactionAmount !== plan.value) {
      logger.error("Valor do pagamento não corresponde ao plano:", {
        paymentAmount: paymentData.transactionAmount,
        planValue: plan.value,
      });
      throw new AppError("Valor do pagamento não corresponde ao valor do plano", 400);
    }
  }

  // Verificar se empresa com mesmo email/nome já existe
  const existingCompany = await Company.findOne({
    where: {
      [Op.or]: [
        { email: companyData.email },
        { name: companyData.name }
      ]
    }
  });

  if (existingCompany) {
    logger.error("Empresa já existe:", {
      email: companyData.email,
      name: companyData.name,
    });
    throw new AppError("Já existe uma empresa com este email ou nome", 400);
  }

  // PASSO 1: Processar pagamento PRIMEIRO (antes de criar empresa)
  logger.info("Processando pagamento antes de criar empresa...");
  let paymentResult;
  try {
    paymentResult = await processPayment({
      ...paymentData,
      description: `Pagamento plano - ${companyData.name}`,
      metadata: {
        planId: companyData.planId,
        companyName: companyData.name,
        companyEmail: companyData.email,
      },
    });

    logger.info("Pagamento processado:", {
      paymentId: paymentResult.id,
      status: paymentResult.status,
      statusDetail: paymentResult.statusDetail,
    });

    // Se pagamento foi rejeitado, não criar empresa
    if (paymentResult.status === "rejected") {
      logger.warn("Pagamento rejeitado, não criando empresa:", {
        paymentId: paymentResult.id,
        statusDetail: paymentResult.statusDetail,
      });
      throw new AppError(
        `Pagamento rejeitado: ${paymentResult.statusDetail || "Não foi possível processar o pagamento"}`,
        400
      );
    }
  } catch (error: any) {
    logger.error("Erro ao processar pagamento - empresa NÃO será criada:", {
      error: error.message,
      companyName: companyData.name,
    });
    // Re-lançar o erro para que não seja criada a empresa
    throw error;
  }

  // PASSO 2: Se pagamento foi aprovado ou está pendente, criar empresa e invoice em transação
  logger.info("Pagamento processado com sucesso, criando empresa e invoice...");

  const transaction = await sequelize.transaction();

  try {
    // Criar empresa dentro da transação
    const company = await Company.create({
      name: companyData.name,
      phone: companyData.phone,
      email: companyData.email,
      status: paymentResult.status === "approved", // Ativar apenas se pagamento aprovado
      planId: companyData.planId,
      dueDate: moment().add(30, "days").format(),
      recurrence: companyData.recurrence,
    }, { transaction });

    logger.info("Empresa criada:", { companyId: company.id, companyName: company.name });

    // Criar usuário admin dentro da transação
    const passwordHash = await hash(companyData.password || "123456", 8);
    await User.create({
      name: company.name,
      email: company.email,
      password: companyData.password,
      passwordHash,
      profile: "admin",
      companyId: company.id,
    }, { transaction });

    logger.info("Usuário admin criado para empresa:", company.id);

    // Criar settings padrão dentro da transação
    const settingsToCreate = [
      { key: "asaas", value: "" },
      { key: "tokenixc", value: "" },
      { key: "ipixc", value: "" },
      { key: "ipmkauth", value: "" },
      { key: "clientsecretmkauth", value: "" },
      { key: "clientidmkauth", value: "" },
      { key: "CheckMsgIsGroup", value: "enabled" },
      { key: "call", value: "disabled" },
      { key: "scheduleType", value: "disabled" },
      { key: "sendGreetingAccepted", value: "disabled" },
      { key: "sendMsgTransfTicket", value: "disabled" },
      { key: "userRating", value: "disabled" },
      { key: "chatBotType", value: "text" },
      { key: "tokensgp", value: "" },
      { key: "ipsgp", value: "" },
      { key: "appsgp", value: "" },
    ];

    if (companyData.campaignsEnabled !== undefined) {
      settingsToCreate.push({
        key: "campaignsEnabled",
        value: `${companyData.campaignsEnabled}`,
      });
    }

    for (const setting of settingsToCreate) {
      await Setting.findOrCreate({
        where: {
          companyId: company.id,
          key: setting.key,
        },
        defaults: {
          companyId: company.id,
          key: setting.key,
          value: setting.value,
        },
        transaction,
      });
    }

    // Criar invoice dentro da transação
    const planName = plan?.name || "N/A";
    const invoiceStatus = paymentResult.status === "approved" ? "paid" : "pending";
    
    const invoice = await Invoices.create({
      detail: `Plano ${planName} - Payment ID: ${paymentResult.id}`,
      value: paymentData.transactionAmount,
      companyId: company.id,
      dueDate: moment().add(30, "days").format(),
      status: invoiceStatus,
    }, { transaction });

    logger.info("Invoice criada:", {
      invoiceId: invoice.id,
      status: invoice.status,
      companyId: company.id,
    });

    // Commit da transação
    await transaction.commit();

    logger.info("Transação concluída com sucesso:", {
      companyId: company.id,
      invoiceId: invoice.id,
      paymentId: paymentResult.id,
      paymentStatus: paymentResult.status,
    });

    // Se pagamento aprovado, emitir evento via Socket.IO
    if (paymentResult.status === "approved") {
      const io = getIO();
      io.to(`company-${company.id}-mainchannel`).emit(
        `company-${company.id}-payment`,
        {
          action: "approved",
          company,
          payment: paymentResult,
        }
      );

      logger.info(`Empresa ${company.id} ativada após pagamento aprovado`);
    }

    return {
      company,
      payment: paymentResult,
      invoice,
    };
  } catch (error: any) {
    // Rollback da transação em caso de erro
    await transaction.rollback();
    logger.error("Erro ao criar empresa/invoice - rollback executado:", {
      error: error.message,
      companyName: companyData.name,
    });
    throw error;
  }
};

export default CreateCompanyWithPaymentService;

