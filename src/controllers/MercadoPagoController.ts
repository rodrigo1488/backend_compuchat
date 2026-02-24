import { Request, Response } from "express";
import * as Yup from "yup";
import AppError from "../errors/AppError";
import {
  createPaymentIntent,
  getPaymentStatus,
  getPreferenceStatus,
  processWebhook,
} from "../services/PaymentService/MercadoPagoService";
import { logger } from "../utils/logger";
import Company from "../models/Company";
import Plan from "../models/Plan";
import Invoices from "../models/Invoices";
import { getIO } from "../libs/socket";
import moment from "moment";
import CreateCompanyService from "../services/CompanyService/CreateCompanyService";
import CreateInvoiceService from "../services/InvoicesService/CreateInvoiceService";
import { Op } from "sequelize";
import User from "../models/User";

export const createPaymentIntentController = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const schema = Yup.object().shape({
    transactionAmount: Yup.number().required().positive(),
    description: Yup.string().required(),
    metadata: Yup.object().optional(),
  });

  try {
    await schema.validate(req.body);
  } catch (err: any) {
    throw new AppError(err.message, 400);
  }

  try {
    const paymentIntent = await createPaymentIntent(req.body);
    return res.status(200).json(paymentIntent);
  } catch (error: any) {
    logger.error("Erro no createPaymentIntentController:", error);
    throw new AppError(
      error.message || "Erro ao criar intenção de pagamento",
      400
    );
  }
};

export const webhookController = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    // Validar assinatura do webhook se configurado
    if (process.env.MERCADOPAGO_WEBHOOK_SECRET) {
      // Implementar validação de assinatura se necessário
      // const signature = req.headers["x-signature"];
      // if (!validateWebhookSignature(signature, req.body)) {
      //   throw new AppError("Assinatura inválida", 401);
      // }
    }

    // Verificar tipo de webhook (payment, subscription_authorized_payment, subscription_preapproval, etc)
    const webhookType = req.body.type || req.body.topic || "payment";
    
    // Handler para Preapproval/Subscriptions
    if (webhookType === "subscription_authorized_payment" || webhookType === "subscription_preapproval") {
      return await handlePreapprovalWebhook(req, res);
    }

    const webhookData = await processWebhook(req.body);

    if (!webhookData || !webhookData.metadata) {
      logger.warn("Webhook sem metadata, ignorando");
      return res.status(200).json({ received: true });
    }

    const metadata = webhookData.metadata;
    const { companyName, companyEmail, companyPhone, companyPasswordHash, planId, recurrence, campaignsEnabled } = metadata;

    // Se já existe companyId, significa que empresa já foi criada (fluxo antigo)
    if (metadata.companyId && metadata.invoiceId) {
      const company = await Company.findByPk(metadata.companyId);
      const invoice = await Invoices.findByPk(metadata.invoiceId);

      if (company && invoice) {
        // Atualizar invoice e company conforme status
        if (webhookData.status === "approved") {
          const newDueDate = moment().add(30, "days").format();
          await company.update({
            status: true,
            dueDate: newDueDate,
          });

          await invoice.update({
            status: "paid",
          });

          const io = getIO();
          io.to(`company-${metadata.companyId}-mainchannel`).emit(
            `company-${metadata.companyId}-payment`,
            {
              action: "approved",
              company: await company.reload(),
              payment: webhookData,
            }
          );

          logger.info(
            `Pagamento aprovado - Empresa ${metadata.companyId} ativada via webhook`
          );
        } else if (webhookData.status === "rejected") {
          await invoice.update({
            status: "rejected",
          });
          logger.warn(`Pagamento rejeitado - Invoice ${metadata.invoiceId}`);
        } else if (webhookData.status === "pending") {
          await invoice.update({
            status: "pending",
          });
        }
      }
      return res.status(200).json({ received: true, data: webhookData });
    }

    // Novo fluxo: criar empresa apenas quando pagamento for aprovado
    // Nota: Para assinaturas recorrentes futuras:
    // - Quando dueDate se aproximar, sistema interno criará nova preferência
    // - Webhook será chamado novamente com status approved
    // - Lógica abaixo verificará se empresa existe e atualizará dueDate
    // - O campo recurrence no metadata define o período (MENSAL, ANUAL, etc.)
    if (webhookData.status === "approved" && companyName && companyEmail) {
      // Verificar se empresa já existe
      const existingCompany = await Company.findOne({
        where: {
          [Op.or]: [
            { email: companyEmail },
            { name: companyName }
          ]
        }
      });

      if (existingCompany) {
        logger.info(`Renovação de assinatura detectada para empresa existente: ${companyEmail}`);
        
        // Verificar se é renovação (tem isRenewal no metadata) ou primeiro pagamento
        const isRenewal = metadata.isRenewal === true;
        
        // Calcular novo dueDate baseado na recorrência
        const recurrence = metadata.recurrence || existingCompany.recurrence || "MENSAL";
        let daysToAdd = 30; // Padrão MENSAL
        if (recurrence === "ANUAL") {
          daysToAdd = 365;
        } else if (recurrence === "SEMESTRAL") {
          daysToAdd = 180;
        } else if (recurrence === "TRIMESTRAL") {
          daysToAdd = 90;
        } else if (recurrence === "MENSAL") {
          daysToAdd = 30;
        }
        
        // Se for renovação, adicionar ao dueDate atual, senão usar data atual
        let newDueDate: string;
        if (isRenewal && existingCompany.dueDate) {
          // Renovação: adicionar período ao dueDate atual
          newDueDate = moment(existingCompany.dueDate).add(daysToAdd, "days").format();
        } else {
          // Primeiro pagamento ou renovação sem dueDate: usar data atual + período
          newDueDate = moment().add(daysToAdd, "days").format();
        }
        
        await existingCompany.update({
          status: true,
          dueDate: newDueDate,
          recurrence: recurrence,
          lastRenewalAttempt: new Date(),
          renewalAttempts: 0, // Resetar tentativas em caso de sucesso
        });

        // Criar invoice de renovação se for renovação
        if (isRenewal) {
          await CreateInvoiceService({
            companyId: existingCompany.id,
            detail: `Renovação assinatura - ${existingCompany.plan?.name || "Plano"} (${recurrence})`,
            value: webhookData.transactionAmount || existingCompany.plan?.value || 0,
            status: "paid",
            dueDate: newDueDate,
          });
        }

        const io = getIO();
        io.to(`company-${existingCompany.id}-mainchannel`).emit(
          `company-${existingCompany.id}-payment`,
          {
            action: isRenewal ? "renewed" : "approved",
            company: await existingCompany.reload(),
            payment: webhookData,
          }
        );

        logger.info(`Renovação processada para empresa ${existingCompany.id}:`, {
          isRenewal,
          newDueDate,
          recurrence,
        });

        return res.status(200).json({ received: true, data: webhookData });
      }

      // Criar empresa
      logger.info("Criando empresa via webhook após pagamento aprovado:", {
        companyName,
        companyEmail,
        planId,
      });

      // Calcular dueDate baseado na recorrência
      const recurrenceType = recurrence || "MENSAL";
      let daysToAdd = 30; // Padrão MENSAL
      if (recurrenceType === "ANUAL") {
        daysToAdd = 365;
      } else if (recurrenceType === "SEMESTRAL") {
        daysToAdd = 180;
      } else if (recurrenceType === "TRIMESTRAL") {
        daysToAdd = 90;
      } else if (recurrenceType === "MENSAL") {
        daysToAdd = 30;
      }

      // Nota: CreateCompanyService faz hash da senha internamente
      // Mas como já temos o hash no metadata, precisamos passar uma senha temporária
      // e depois atualizar o User com o hash correto
      const company = await CreateCompanyService({
        name: companyName,
        email: companyEmail,
        phone: companyPhone,
        password: "temp_password_will_be_updated", // Será atualizado abaixo
        planId: planId ? parseInt(planId.toString()) : undefined,
        status: true, // Ativar imediatamente
        dueDate: moment().add(daysToAdd, "days").format(),
        recurrence: recurrenceType,
        campaignsEnabled: campaignsEnabled !== undefined ? campaignsEnabled : true,
      });

      // Atualizar senha do usuário com o hash correto
      const user = await User.findOne({ where: { companyId: company.id, profile: "admin" } });
      if (user && companyPasswordHash) {
        await user.update({ passwordHash: companyPasswordHash });
      }

      // Criar invoice com dueDate baseado na recorrência
      const invoice = await CreateInvoiceService({
        companyId: company.id,
        detail: `Pagamento plano - ${company.name} (${recurrenceType})`,
        value: webhookData.transactionAmount || 0,
        status: "paid",
        dueDate: moment().add(daysToAdd, "days").format(),
      });

      logger.info("Empresa criada via webhook:", {
        companyId: company.id,
        invoiceId: invoice.id,
        paymentId: webhookData.id,
        companyEmail: company.email,
      });

      // Emitir evento via Socket.IO
      const io = getIO();
      io.to(`company-${company.id}-mainchannel`).emit(
        `company-${company.id}-payment`,
        {
          action: "approved",
          company: await company.reload(),
          payment: webhookData,
        }
      );
    } else if (webhookData.status === "rejected" || webhookData.status === "pending") {
      logger.info("Pagamento não aprovado, empresa não será criada:", {
        status: webhookData.status,
        companyEmail,
      });
    }

    return res.status(200).json({ received: true, data: webhookData });
  } catch (error: any) {
    logger.error("Erro no webhookController:", error);
    // Retornar 200 mesmo em caso de erro para o MP não reenviar
    return res.status(200).json({ received: true, error: error.message });
  }
};

/**
 * Handler para webhooks de Preapproval/Subscriptions do Mercado Pago
 */
const handlePreapprovalWebhook = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const webhookData = req.body;
    const webhookType = webhookData.type || webhookData.topic;

    logger.info("Webhook de Preapproval recebido:", {
      type: webhookType,
      data_id: webhookData.data?.id,
      action: webhookData.action,
    });

    // subscription_authorized_payment - Pagamento autorizado de uma assinatura
    if (webhookType === "subscription_authorized_payment" || webhookData.action === "payment.created") {
      const paymentData = webhookData.data;
      
      if (!paymentData || !paymentData.id) {
        logger.warn("Webhook de pagamento autorizado sem dados válidos");
        return res.status(200).json({ received: true });
      }

      // Buscar empresa pelo external_reference ou metadata
      const externalReference = paymentData.external_reference || paymentData.metadata?.external_reference;
      
      if (externalReference && externalReference.includes("company_")) {
        const companyIdMatch = externalReference.match(/company_(\d+)/);
        if (companyIdMatch) {
          const companyId = parseInt(companyIdMatch[1]);
          const company = await Company.findByPk(companyId, {
            include: [{ model: Plan }],
          });

          if (company && company.plan) {
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

            // Atualizar empresa
            await company.update({
              dueDate: newDueDate,
              status: paymentData.status === "approved",
              lastRenewalAttempt: new Date(),
              renewalAttempts: 0,
            });

            // Criar invoice de renovação
            await CreateInvoiceService({
              companyId: company.id,
              detail: `Renovação assinatura - ${company.plan.name} (${recurrence})`,
              value: paymentData.transaction_amount || company.plan.value,
              status: paymentData.status === "approved" ? "paid" : "pending",
              dueDate: newDueDate,
            });

            logger.info(`Renovação via Preapproval processada para empresa ${companyId}:`, {
              paymentId: paymentData.id,
              status: paymentData.status,
              newDueDate,
            });

            // Emitir evento via Socket.IO
            const io = getIO();
            io.to(`company-${company.id}-mainchannel`).emit(
              `company-${company.id}-payment`,
              {
                action: "renewed",
                company: await company.reload(),
                payment: paymentData,
              }
            );
          }
        }
      }
    }

    // subscription_preapproval - Mudanças no Preapproval (criação, atualização, cancelamento)
    if (webhookType === "subscription_preapproval") {
      const preapprovalData = webhookData.data;
      
      if (!preapprovalData || !preapprovalData.id) {
        logger.warn("Webhook de Preapproval sem dados válidos");
        return res.status(200).json({ received: true });
      }

      // Buscar empresa pelo preapprovalId
      const company = await Company.findOne({
        where: {
          preapprovalId: preapprovalData.id,
        },
        include: [{ model: Plan }],
      });

      if (company) {
        // Atualizar status baseado no Preapproval
        if (preapprovalData.status === "cancelled" || preapprovalData.status === "paused") {
          await company.update({
            autoRenew: false,
          });
          logger.info(`Preapproval cancelado/pausado para empresa ${company.id}`);
        } else if (preapprovalData.status === "authorized") {
          await company.update({
            autoRenew: true,
          });
          logger.info(`Preapproval autorizado para empresa ${company.id}`);
        }
      }
    }

    return res.status(200).json({ received: true, data: webhookData });
  } catch (error: any) {
    logger.error("Erro no handlePreapprovalWebhook:", error);
    // Retornar 200 mesmo em caso de erro para o MP não reenviar
    return res.status(200).json({ received: true, error: error.message });
  }
};

export const getPaymentStatusController = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { paymentId } = req.params;

  if (!paymentId) {
    throw new AppError("Payment ID é obrigatório", 400);
  }

  try {
    const paymentStatus = await getPaymentStatus(paymentId);
    return res.status(200).json(paymentStatus);
  } catch (error: any) {
    logger.error("Erro no getPaymentStatusController:", error);
    throw new AppError(
      error.message || "Erro ao consultar status do pagamento",
      400
    );
  }
};

export const getPreferenceStatusController = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { preferenceId } = req.params;

  if (!preferenceId) {
    throw new AppError("Preference ID é obrigatório", 400);
  }

  try {
    const preferenceStatus = await getPreferenceStatus(preferenceId);
    return res.status(200).json(preferenceStatus);
  } catch (error: any) {
    logger.error("Erro no getPreferenceStatusController:", error);
    throw new AppError(
      error.message || "Erro ao consultar status da preferência",
      400
    );
  }
};

export const getMercadoPagoDiagnostic = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || "NÃO CONFIGURADO";
    const tokenType = accessToken.startsWith("TEST_") ? "TESTE" : 
                     accessToken.startsWith("APP_USR_") ? "PRODUÇÃO" : "DESCONHECIDO";
    const isProduction = process.env.NODE_ENV === "production";
    
    // Verificar se o cliente foi inicializado (precisa importar do service)
    // Por enquanto, vamos verificar se o token está configurado
    let clientStatus = "não inicializado";
    try {
      if (accessToken !== "NÃO CONFIGURADO") {
        clientStatus = "configurado";
      }
    } catch (e) {
      clientStatus = "erro na inicialização";
    }
    
    const compatibility = {
      valid: (tokenType === "TESTE" && !isProduction) ||
             (tokenType === "PRODUÇÃO" && isProduction),
      warning: tokenType === "PRODUÇÃO" && !isProduction,
      error: tokenType === "TESTE" && isProduction,
    };
    
    const diagnostic = {
      status: clientStatus,
      credentials: {
        type: tokenType,
        prefix: accessToken.substring(0, 15) + "...",
        configured: accessToken !== "NÃO CONFIGURADO",
        length: accessToken.length,
      },
      environment: {
        nodeEnv: process.env.NODE_ENV || "não configurado",
        isProduction,
      },
      compatibility,
      recommendations: [
        ...(compatibility.error ? [
          "ERRO: Credenciais de TESTE em ambiente de PRODUÇÃO. Use credenciais de produção (APP_USR_...) ou altere NODE_ENV."
        ] : []),
        ...(compatibility.warning ? [
          "AVISO: Credenciais de PRODUÇÃO em desenvolvimento. Use credenciais de teste (TEST_...) para desenvolvimento."
        ] : []),
        ...(tokenType === "DESCONHECIDO" ? [
          "ERRO: Formato de token não reconhecido. Deve começar com 'TEST_' ou 'APP_USR_'."
        ] : []),
        ...(accessToken === "NÃO CONFIGURADO" ? [
          "ERRO: MERCADOPAGO_ACCESS_TOKEN não configurado. Configure a variável de ambiente."
        ] : []),
      ],
      timestamp: new Date().toISOString(),
    };
    
    return res.status(200).json(diagnostic);
  } catch (error: any) {
    logger.error("Erro no getMercadoPagoDiagnostic:", error);
    throw new AppError(
      error.message || "Erro ao obter diagnóstico do Mercado Pago",
      500
    );
  }
};

