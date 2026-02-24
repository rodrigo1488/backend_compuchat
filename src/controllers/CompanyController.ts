import * as Yup from "yup";
import { Request, Response } from "express";
import { Op } from "sequelize";
// import { getIO } from "../libs/socket";
import AppError from "../errors/AppError";
import Company from "../models/Company";
import authConfig from "../config/auth";

import ListCompaniesService from "../services/CompanyService/ListCompaniesService";
import CreateCompanyService from "../services/CompanyService/CreateCompanyService";
import UpdateCompanyService from "../services/CompanyService/UpdateCompanyService";
import ShowCompanyService from "../services/CompanyService/ShowCompanyService";
import UpdateSchedulesService from "../services/CompanyService/UpdateSchedulesService";
import DeleteCompanyService from "../services/CompanyService/DeleteCompanyService";
import FindAllCompaniesService from "../services/CompanyService/FindAllCompaniesService";
import { verify } from "jsonwebtoken";
import User from "../models/User";
import ShowPlanCompanyService from "../services/CompanyService/ShowPlanCompanyService";
import ListCompaniesPlanService from "../services/CompanyService/ListCompaniesPlanService";
import { logger } from "../utils/logger";
import { createPaymentIntent } from "../services/PaymentService/MercadoPagoService";
import Plan from "../models/Plan";
import { hash } from "bcryptjs";
import moment from "moment";
import CreateCompanyWithPaymentService from "../services/CompanyService/CreateCompanyWithPaymentService";
import { createPreapproval, getPreapprovalStatus, cancelPreapproval, updatePreapproval } from "../services/PaymentService/MercadoPagoService";
import ListCompanyModulesService from "../services/CompanyModuleServices/ListCompanyModulesService";
import CompanyModule from "../models/CompanyModule";
import Module from "../models/Module";

type IndexQuery = {
  searchParam: string;
  pageNumber: string;
};

interface TokenPayload {
  id: string;
  username: string;
  profile: string;
  companyId: number;
  iat: number;
  exp: number;
}

type CompanyData = {
  name: string;
  id?: number;
  phone?: string;
  email?: string;
  status?: boolean;
  planId?: number;
  campaignsEnabled?: boolean;
  dueDate?: string;
  recurrence?: string;
  password: string;
};

type SchedulesData = {
  schedules: [];
};

export const index = async (req: Request, res: Response): Promise<Response> => {
  const { searchParam, pageNumber } = req.query as IndexQuery;

  const { companies, count, hasMore } = await ListCompaniesService({
    searchParam,
    pageNumber
  });

  return res.json({ companies, count, hasMore });
};

export const store = async (req: Request, res: Response): Promise<Response> => {
  const newCompany: CompanyData = req.body;

  const schema = Yup.object().shape({
    name: Yup.string().required()
  });

  try {
    await schema.validate(newCompany);
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const company = await CreateCompanyService(newCompany);

  return res.status(200).json(company);
};

export const show = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;

  const company = await ShowCompanyService(id);

  return res.status(200).json(company);
};

export const list = async (req: Request, res: Response): Promise<Response> => {
  const companies: Company[] = await FindAllCompaniesService();

  return res.status(200).json(companies);
};

export const update = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const companyData: CompanyData = req.body;

  const schema = Yup.object().shape({
    name: Yup.string()
  });

  try {
    await schema.validate(companyData);
  } catch (err: any) {
    throw new AppError(err.message);
  }

  const { id } = req.params;

  const company = await UpdateCompanyService({ id, ...companyData });

  return res.status(200).json(company);
};

export const updateSchedules = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { schedules }: SchedulesData = req.body;
  const { id } = req.params;

  const company = await UpdateSchedulesService({
    id,
    schedules
  });

  return res.status(200).json(company);
};

export const remove = async (
  req: Request,
  res: Response
): Promise<Response> => {
  const { id } = req.params;

  const company = await DeleteCompanyService(id);

  return res.status(200).json(company);
};

export const listPlan = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;

  const authHeader = req.headers.authorization;
  const [, token] = authHeader.split(" ");
  const decoded = verify(token, authConfig.secret);
  const { id: requestUserId, profile, companyId } = decoded as TokenPayload;
  const requestUser = await User.findByPk(requestUserId);

  if (requestUser.super === true) {
    const company = await ShowPlanCompanyService(id);
    return res.status(200).json(company);
  } else if (companyId.toString() !== id) {
    return res.status(400).json({ error: "Você não possui permissão para acessar este recurso!" });
  } else {
    const company = await ShowPlanCompanyService(id);
    return res.status(200).json(company);
  }

};

export const indexPlan = async (req: Request, res: Response): Promise<Response> => {
  const { searchParam, pageNumber } = req.query as IndexQuery;

  const authHeader = req.headers.authorization;
  const [, token] = authHeader.split(" ");
  const decoded = verify(token, authConfig.secret);
  const { id, profile, companyId } = decoded as TokenPayload;
  // const company = await Company.findByPk(companyId);
  const requestUser = await User.findByPk(id);

  if (requestUser.super === true) {
    const companies = await ListCompaniesPlanService();
    return res.json({ companies });
  } else {
    return res.status(400).json({ error: "Você não possui permissão para acessar este recurso!" });
  }

};

export const createFreeAccount = async (req: Request, res: Response): Promise<Response> => {
  logger.info("=== createFreeAccount chamado ===");
  logger.info("Body recebido:", {
    companyName: req.body.name,
    companyEmail: req.body.email,
    planId: req.body.planId,
  });

  const schema = Yup.object().shape({
    name: Yup.string().required("Nome da empresa é obrigatório"),
    email: Yup.string().email("Email inválido").required("Email é obrigatório"),
    phone: Yup.string().required("Telefone é obrigatório"),
    password: Yup.string().required("Senha é obrigatória"),
    planId: Yup.number().required("Plano é obrigatório"),
  });

  try {
    await schema.validate(req.body, { abortEarly: false });
    logger.info("✓ Validação do schema passou");
  } catch (err: any) {
    logger.error("✗ Erro na validação do schema:", {
      error: err.message,
      errors: err.inner,
    });

    if (err.inner && err.inner.length > 0) {
      const errors = err.inner.map((e: any) => `${e.path}: ${e.message}`).join(", ");
      logger.error("Erros detalhados:", errors);
      throw new AppError(`Erro de validação: ${errors}`, 400);
    }

    throw new AppError(err.message || "Erro de validação", 400);
  }

  try {
    // Buscar plano (pode ser qualquer plano - pago ou gratuito)
    // No fluxo gratuito, o usuário seleciona o plano que deseja usar após o período de teste
    const plan = await Plan.findByPk(req.body.planId);
    if (!plan) {
      throw new AppError("Plano não encontrado", 404);
    }

    // Criar empresa diretamente sem pagamento (período de teste de 7 dias)
    // O plano selecionado será associado à conta e será ativado após o período de teste
    const company = await CreateCompanyService({
      name: req.body.name,
      email: req.body.email,
      phone: req.body.phone,
      password: req.body.password,
      planId: req.body.planId,
      status: true, // Ativar imediatamente para período de teste
      dueDate: moment().add(7, "days").format(), // 7 dias grátis de teste
      recurrence: "MENSAL",
    });

    logger.info("✓ Conta gratuita criada com sucesso:", {
      companyId: company.id,
      companyName: company.name,
    });

    return res.status(200).json({
      success: true,
      company: {
        id: company.id,
        name: company.name,
        email: company.email,
      },
      message: "Conta criada com sucesso! Você pode fazer login agora.",
    });
  } catch (error: any) {
    logger.error("✗ Erro ao criar conta gratuita:", {
      error: error.message,
      companyName: req.body?.name,
      companyEmail: req.body?.email,
    });

    if (error instanceof AppError) {
      throw error;
    }

    const errorMessage = error.message || "Erro ao criar conta. Por favor, tente novamente.";
    throw new AppError(errorMessage, error.statusCode || 400);
  }
};

export const createPaymentPreference = async (req: Request, res: Response): Promise<Response> => {
  logger.info("=== createPaymentPreference chamado ===");
  logger.info("Body recebido:", {
    companyName: req.body.name,
    companyEmail: req.body.email,
    planId: req.body.planId,
  });

  const schema = Yup.object().shape({
    name: Yup.string()
      .min(2, "Nome da empresa deve ter no mínimo 2 caracteres")
      .max(100, "Nome da empresa deve ter no máximo 100 caracteres")
      .required("Nome da empresa é obrigatório"),
    email: Yup.string()
      .email("Email inválido")
      .required("Email é obrigatório")
      .matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Formato de email inválido"),
    phone: Yup.string()
      .required("Telefone é obrigatório")
      .matches(/^[\d\s\(\)\-\+]+$/, "Formato de telefone inválido")
      .test("min-length", "Telefone deve ter no mínimo 10 dígitos", (value) => {
        return value ? value.replace(/\D/g, "").length >= 10 : false;
      }),
    password: Yup.string()
      .min(5, "Senha deve ter no mínimo 5 caracteres")
      .max(50, "Senha deve ter no máximo 50 caracteres")
      .required("Senha é obrigatória"),
    planId: Yup.number()
      .required("Plano é obrigatório")
      .integer("ID do plano deve ser um número inteiro")
      .positive("ID do plano deve ser um número positivo"),
    recurrence: Yup.string()
      .optional()
      .oneOf(["MENSAL", "ANUAL", "TRIMESTRAL", "SEMESTRAL"], "Recorrência inválida"),
  });

  try {
    await schema.validate(req.body, { abortEarly: false });
    logger.info("✓ Validação do schema passou");
  } catch (err: any) {
    logger.error("✗ Erro na validação do schema:", {
      error: err.message,
      errors: err.inner,
    });

    if (err.inner && err.inner.length > 0) {
      const errors = err.inner.map((e: any) => `${e.path}: ${e.message}`).join(", ");
      logger.error("Erros detalhados:", errors);
      throw new AppError(`Erro de validação: ${errors}`, 400);
    }

    throw new AppError(err.message || "Erro de validação", 400);
  }

  try {
    // Validar se empresa com mesmo email/nome já existe
    const existingCompany = await Company.findOne({
      where: {
        [Op.or]: [
          { email: req.body.email },
          { name: req.body.name }
        ]
      }
    });

    if (existingCompany) {
      logger.warn("Tentativa de criar empresa com email/nome já existente:", {
        email: req.body.email,
        name: req.body.name,
      });
      throw new AppError("Já existe uma empresa com este email ou nome. Por favor, use outro email ou nome.", 400);
    }

    // Buscar plano para obter valor
    const plan = await Plan.findByPk(req.body.planId);
    if (!plan) {
      throw new AppError("Plano não encontrado. Verifique se o plano existe.", 404);
    }

    // Verificar se o plano é gratuito - se for, redirecionar para criação gratuita
    if (plan.value === 0 || plan.value === null) {
      throw new AppError("Para planos gratuitos, use o endpoint de criação gratuita.", 400);
    }

    // Validar valor do plano
    if (plan.value < 0) {
      throw new AppError("Valor do plano inválido.", 400);
    }

    // Hash da senha antes de salvar no metadata
    const passwordHash = await hash(req.body.password, 8);

    // Criar preferência de pagamento com personalização alinhada ao design da plataforma
    const preference = await createPaymentIntent({
      transactionAmount: plan.value,
      description: `Pagamento plano - ${plan.name}`,
      metadata: {
        companyName: req.body.name,
        companyEmail: req.body.email,
        companyPhone: req.body.phone,
        companyPasswordHash: passwordHash,
        planId: req.body.planId,
        recurrence: req.body.recurrence || "MENSAL",
        campaignsEnabled: true,
      },
      payer: {
        email: req.body.email,
        name: req.body.name,
      },
      notification_url: `${process.env.BACKEND_URL}/mercadopago/webhook`,
      // Personalização do Checkout Pro alinhada ao design da plataforma
      customization: {
        theme: {
          elementsColor: process.env.MP_CHECKOUT_COLOR || "#00D9FF", // Cor primária da plataforma
          headerColor: process.env.MP_CHECKOUT_HEADER_COLOR || "#0A0A0F", // Cor do fundo escuro
        },
        texts: {
          valueProp: "Sistema completo de atendimento ao cliente com segurança e agilidade",
          securityCode: "Código de segurança do cartão",
        },
        installments: parseInt(process.env.MP_MAX_INSTALLMENTS || "12", 10),
        excludedPaymentMethods: process.env.MP_EXCLUDED_PAYMENT_METHODS
          ? process.env.MP_EXCLUDED_PAYMENT_METHODS.split(",").map((m: string) => m.trim())
          : [],
        excludedPaymentTypes: process.env.MP_EXCLUDED_PAYMENT_TYPES
          ? process.env.MP_EXCLUDED_PAYMENT_TYPES.split(",").map((t: string) => t.trim())
          : [],
        binaryMode: process.env.MP_BINARY_MODE === "true",
      },
    });

    logger.info("✓ Preferência criada com sucesso:", {
      preferenceId: preference.preferenceId,
      initPoint: preference.initPoint,
    });

    return res.status(200).json({
      initPoint: preference.initPoint,
      preferenceId: preference.preferenceId,
    });
  } catch (error: any) {
    logger.error("✗ Erro ao criar preferência de pagamento:", {
      error: error.message,
      statusCode: error.statusCode,
      companyName: req.body?.name,
      companyEmail: req.body?.email,
    });

    if (error instanceof AppError) {
      throw error;
    }

    const errorMessage = error.message || "Erro ao criar preferência de pagamento. Por favor, tente novamente.";
    throw new AppError(errorMessage, error.statusCode || 400);
  }
};

export const getMercadoPagoPublicKey = async (req: Request, res: Response): Promise<Response> => {
  try {
    const publicKey = process.env.MERCADOPAGO_PUBLIC_KEY;

    if (!publicKey) {
      throw new AppError("Public key do Mercado Pago não configurada", 500);
    }

    return res.status(200).json({
      publicKey,
    });
  } catch (error: any) {
    logger.error("Erro ao obter public key:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("Erro ao obter chave pública do Mercado Pago", 500);
  }
};

export const createCompanyWithTransparentCheckout = async (req: Request, res: Response): Promise<Response> => {
  logger.info("=== createCompanyWithTransparentCheckout chamado ===");
  logger.info("Body recebido:", {
    companyName: req.body.companyData?.name,
    companyEmail: req.body.companyData?.email,
    planId: req.body.companyData?.planId,
  });

  const schema = Yup.object().shape({
    companyData: Yup.object().shape({
      name: Yup.string().required("Nome da empresa é obrigatório"),
      email: Yup.string().email("Email inválido").required("Email é obrigatório"),
      phone: Yup.string().required("Telefone é obrigatório"),
      password: Yup.string().required("Senha é obrigatória"),
      planId: Yup.number().required("Plano é obrigatório"),
      recurrence: Yup.string().optional(),
      campaignsEnabled: Yup.boolean().optional(),
    }),
    paymentData: Yup.object().shape({
      token: Yup.string().required("Token do cartão é obrigatório"),
      paymentMethodId: Yup.string().required("Método de pagamento é obrigatório"),
      installments: Yup.number().required("Número de parcelas é obrigatório"),
      transactionAmount: Yup.number().required("Valor da transação é obrigatório"),
      identificationType: Yup.string().required("Tipo de identificação é obrigatório"),
      identificationNumber: Yup.string().required("Número de identificação é obrigatório"),
      payer: Yup.object().shape({
        email: Yup.string().email("Email inválido").required("Email é obrigatório"),
        firstName: Yup.string().optional(),
        lastName: Yup.string().optional(),
      }),
      issuerId: Yup.string().optional(),
    }),
  });

  try {
    await schema.validate(req.body, { abortEarly: false });
    logger.info("✓ Validação do schema passou");
  } catch (err: any) {
    logger.error("✗ Erro na validação do schema:", {
      error: err.message,
      errors: err.inner,
    });

    if (err.inner && err.inner.length > 0) {
      const errors = err.inner.map((e: any) => `${e.path}: ${e.message}`).join(", ");
      logger.error("Erros detalhados:", errors);
      throw new AppError(`Erro de validação: ${errors}`, 400);
    }

    throw new AppError(err.message || "Erro de validação", 400);
  }

  try {
    // Buscar plano para validar valor
    const plan = await Plan.findByPk(req.body.companyData.planId);
    if (!plan) {
      throw new AppError("Plano não encontrado", 404);
    }

    // Validar se o valor corresponde ao plano
    if (req.body.paymentData.transactionAmount !== plan.value) {
      throw new AppError("Valor do pagamento não corresponde ao valor do plano", 400);
    }

    // Processar pagamento e criar empresa
    const result = await CreateCompanyWithPaymentService({
      companyData: {
        name: req.body.companyData.name,
        email: req.body.companyData.email,
        phone: req.body.companyData.phone,
        password: req.body.companyData.password,
        planId: req.body.companyData.planId,
        recurrence: req.body.companyData.recurrence || "MENSAL",
        campaignsEnabled: req.body.companyData.campaignsEnabled ?? true,
      },
      paymentData: {
        ...req.body.paymentData,
        description: `Pagamento plano - ${plan.name}`,
      },
    });

    logger.info("✓ Empresa criada com pagamento processado:", {
      companyId: result.company.id,
      paymentId: result.payment.id,
      paymentStatus: result.payment.status,
    });

    return res.status(200).json({
      success: true,
      company: {
        id: result.company.id,
        name: result.company.name,
        email: result.company.email,
      },
      payment: {
        id: result.payment.id,
        status: result.payment.status,
        statusDetail: result.payment.statusDetail,
      },
      invoice: {
        id: result.invoice.id,
        status: result.invoice.status,
      },
      message: result.payment.status === "approved"
        ? "Conta criada e pagamento aprovado com sucesso!"
        : "Conta criada. Aguardando confirmação do pagamento.",
    });
  } catch (error: any) {
    logger.error("✗ Erro ao criar empresa com checkout transparente:", {
      error: error.message,
      companyName: req.body?.companyData?.name,
      companyEmail: req.body?.companyData?.email,
    });

    if (error instanceof AppError) {
      throw error;
    }

    const errorMessage = error.message || "Erro ao processar pagamento. Por favor, tente novamente.";
    throw new AppError(errorMessage, error.statusCode || 400);
  }
};

export const createCompanyPreapproval = async (req: Request, res: Response): Promise<Response> => {
  logger.info("=== createCompanyPreapproval chamado ===");
  const { id } = req.params;

  const schema = Yup.object().shape({
    cardTokenId: Yup.string().required("Token do cartão é obrigatório"),
  });

  try {
    await schema.validate(req.body, { abortEarly: false });
  } catch (err: any) {
    if (err.inner && err.inner.length > 0) {
      const errors = err.inner.map((e: any) => `${e.path}: ${e.message}`).join(", ");
      throw new AppError(`Erro de validação: ${errors}`, 400);
    }
    throw new AppError(err.message || "Erro de validação", 400);
  }

  try {
    const company = await Company.findByPk(id, {
      include: [{ model: Plan }],
    });

    if (!company) {
      throw new AppError("Empresa não encontrada", 404);
    }

    if (!company.plan) {
      throw new AppError("Plano não encontrado para esta empresa", 404);
    }

    // Verificar se já tem Preapproval ativo
    if (company.preapprovalId) {
      const existingPreapproval = await getPreapprovalStatus(company.preapprovalId);
      if (existingPreapproval && existingPreapproval.status === "authorized") {
        throw new AppError("Empresa já possui uma assinatura recorrente ativa", 400);
      }
    }

    // Buscar usuário admin para obter email
    const adminUser = await User.findOne({
      where: {
        companyId: company.id,
        profile: "admin",
      },
    });

    if (!adminUser) {
      throw new AppError("Usuário admin não encontrado", 404);
    }

    // Criar Preapproval
    const preapprovalResult = await createPreapproval({
      companyId: company.id,
      planId: company.planId,
      cardTokenId: req.body.cardTokenId,
      payerEmail: company.email || adminUser.email,
      payerName: company.name,
      transactionAmount: company.plan.value,
      recurrence: company.recurrence || "MENSAL",
    });

    // Atualizar empresa com preapprovalId e cardTokenId
    await company.update({
      preapprovalId: preapprovalResult.preapprovalId,
      cardTokenId: req.body.cardTokenId,
      autoRenew: true,
    });

    logger.info("✓ Preapproval criado com sucesso:", {
      companyId: company.id,
      preapprovalId: preapprovalResult.preapprovalId,
    });

    return res.status(200).json({
      success: true,
      preapprovalId: preapprovalResult.preapprovalId,
      initPoint: preapprovalResult.initPoint,
      message: "Assinatura recorrente criada com sucesso! Os pagamentos serão processados automaticamente.",
    });
  } catch (error: any) {
    logger.error("✗ Erro ao criar Preapproval:", {
      error: error.message,
      companyId: id,
    });

    if (error instanceof AppError) {
      throw error;
    }

    const errorMessage = error.message || "Erro ao criar assinatura recorrente. Por favor, tente novamente.";
    throw new AppError(errorMessage, error.statusCode || 400);
  }
};

export const getCompanyPreapprovalStatus = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;

  try {
    const company = await Company.findByPk(id);

    if (!company) {
      throw new AppError("Empresa não encontrada", 404);
    }

    if (!company.preapprovalId) {
      return res.status(200).json({
        hasPreapproval: false,
        message: "Empresa não possui assinatura recorrente configurada",
      });
    }

    const preapprovalStatus = await getPreapprovalStatus(company.preapprovalId);

    return res.status(200).json({
      hasPreapproval: true,
      preapprovalId: company.preapprovalId,
      status: preapprovalStatus.status,
      autoRenew: company.autoRenew,
      preapproval: preapprovalStatus,
    });
  } catch (error: any) {
    logger.error("Erro ao obter status do Preapproval:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("Erro ao consultar assinatura recorrente", 400);
  }
};

export const cancelCompanyPreapproval = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;

  try {
    const company = await Company.findByPk(id);

    if (!company) {
      throw new AppError("Empresa não encontrada", 404);
    }

    if (!company.preapprovalId) {
      throw new AppError("Empresa não possui assinatura recorrente para cancelar", 400);
    }

    await cancelPreapproval(company.preapprovalId);

    // Atualizar empresa removendo preapprovalId mas mantendo outros dados
    await company.update({
      preapprovalId: null,
      autoRenew: false,
    });

    logger.info(`Preapproval cancelado para empresa ${id}`);

    return res.status(200).json({
      success: true,
      message: "Assinatura recorrente cancelada com sucesso",
    });
  } catch (error: any) {
    logger.error("Erro ao cancelar Preapproval:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("Erro ao cancelar assinatura recorrente", 400);
  }
};

export const updateCompanyAutoRenew = async (req: Request, res: Response): Promise<Response> => {
  const { id } = req.params;

  const schema = Yup.object().shape({
    autoRenew: Yup.boolean().required("autoRenew é obrigatório"),
  });

  try {
    await schema.validate(req.body, { abortEarly: false });
  } catch (err: any) {
    if (err.inner && err.inner.length > 0) {
      const errors = err.inner.map((e: any) => `${e.path}: ${e.message}`).join(", ");
      throw new AppError(`Erro de validação: ${errors}`, 400);
    }
    throw new AppError(err.message || "Erro de validação", 400);
  }

  try {
    const company = await Company.findByPk(id);

    if (!company) {
      throw new AppError("Empresa não encontrada", 404);
    }

    await company.update({
      autoRenew: req.body.autoRenew,
    });

    logger.info(`AutoRenew atualizado para empresa ${id}: ${req.body.autoRenew}`);

    return res.status(200).json({
      success: true,
      autoRenew: company.autoRenew,
      message: `Renovação automática ${req.body.autoRenew ? "ativada" : "desativada"} com sucesso`,
    });
  } catch (error: any) {
    logger.error("Erro ao atualizar autoRenew:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("Erro ao atualizar renovação automática", 400);
  }
};

export const getCompanyByEmail = async (req: Request, res: Response): Promise<Response> => {
  const { email } = req.query;

  if (!email || typeof email !== "string") {
    throw new AppError("Email é obrigatório", 400);
  }

  try {
    const company = await Company.findOne({
      where: {
        email: email,
      },
      attributes: ["id", "name", "email", "status", "dueDate"],
    });

    if (!company) {
      return res.status(200).json({
        exists: false,
        message: "Empresa não encontrada",
      });
    }

    return res.status(200).json({
      exists: true,
      company: {
        id: company.id,
        name: company.name,
        email: company.email,
        status: company.status,
        dueDate: company.dueDate,
      },
    });
  } catch (error: any) {
    logger.error("Erro ao buscar empresa por email:", error);

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError("Erro ao buscar empresa", 400);
  }
};

/** GET /companies/:id/modules - Super admin: listar módulos da empresa */
export const getCompanyModules = async (req: Request, res: Response): Promise<Response> => {
  const companyId = Number(req.params.id);
  if (!companyId || isNaN(companyId)) {
    throw new AppError("ID da empresa inválido", 400);
  }
  const modules = await ListCompanyModulesService(companyId);
  return res.json({ modules });
};

/** PUT /companies/:id/modules - Super admin: definir módulos da empresa (slugs) */
export const updateCompanyModules = async (req: Request, res: Response): Promise<Response> => {
  const companyId = Number(req.params.id);
  const { modules } = req.body as { modules?: string[] };

  if (!companyId || isNaN(companyId)) {
    throw new AppError("ID da empresa inválido", 400);
  }

  const company = await Company.findByPk(companyId);
  if (!company) {
    throw new AppError("Empresa não encontrada", 404);
  }

  const slugs = Array.isArray(modules) ? modules : [];
  const activeModules = await Module.findAll({
    where: { slug: slugs, isActive: true },
    attributes: ["id", "slug"],
  });

  await CompanyModule.destroy({ where: { companyId } });

  for (const mod of activeModules) {
    await CompanyModule.create({ companyId, moduleId: mod.id });
  }

  const result = await ListCompanyModulesService(companyId);
  return res.json({ modules: result });
};