import { MercadoPagoConfig, Payment, Preference, PreApproval, PreApprovalPlan } from "mercadopago";
import AppError from "../../errors/AppError";
import { logger } from "../../utils/logger";

// Função auxiliar para logging robusto de erros
const logErrorDetails = (error: any, context: any = {}): void => {
  const timestamp = new Date().toISOString();

  // Capturar informações básicas do erro
  const errorInfo: any = {
    timestamp,
    error: {
      name: error?.name || "Unknown",
      message: error?.message || "No message",
      stack: error?.stack?.substring(0, 500) || "No stack",
    },
    context,
  };

  // Capturar propriedades adicionais do erro
  if (error?.cause) {
    if (Array.isArray(error.cause)) {
      errorInfo.error.causeArray = error.cause.map((c: any, idx: number) => ({
        index: idx,
        code: c.code,
        description: c.description,
        message: c.message,
        data: c.data,
        field: c.field,
      }));
    } else {
      errorInfo.error.cause = {
        code: error.cause.code,
        description: error.cause.description,
        message: error.cause.message,
        data: error.cause.data,
        field: error.cause.field,
      };
    }
  }

  if (error?.response) {
    errorInfo.error.response = {
      status: error.response.status,
      statusText: error.response.statusText,
      data: error.response.data,
    };
  }

  if (error?.status) {
    errorInfo.error.status = error.status;
  }

  if (error?.statusCode) {
    errorInfo.error.statusCode = error.statusCode;
  }

  // Serializar de forma segura
  let errorJson: string;
  try {
    errorJson = JSON.stringify(errorInfo, null, 2);
  } catch (e) {
    errorJson = JSON.stringify({
      timestamp,
      error: {
        name: String(error?.name || "Unknown"),
        message: String(error?.message || "No message"),
      },
      context,
      serializationError: "Failed to serialize error object",
    }, null, 2);
  }

  // 1. console.error (pode ser capturado pelo PM2)
  console.error("\n[ERRO MERCADO PAGO]", errorJson);

  // 2. process.stderr.write (sempre aparece, mesmo no PM2)
  try {
    process.stderr.write(`\n[ERRO MERCADO PAGO] ${errorJson}\n`);
  } catch (e) {
    // Se stderr.write falhar, continuar
  }

  // 3. logger (formato estruturado para pino)
  logger.error({
    msg: "Erro Mercado Pago",
    timestamp: errorInfo.timestamp,
    errorName: errorInfo.error.name,
    errorMessage: errorInfo.error.message,
    context: errorInfo.context,
  });
};

// Validar credenciais do Mercado Pago
const validateMercadoPagoCredentials = (): void => {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!accessToken || accessToken.trim() === "") {
    logger.error("MERCADOPAGO_ACCESS_TOKEN não configurado");
    throw new AppError("Configuração de pagamento incompleta. Entre em contato com o suporte.", 500);
  }

  // Detectar ambiente baseado no token (aceitar tanto hífen quanto underscore)
  const isTestToken = accessToken.startsWith("TEST-") || accessToken.startsWith("TEST_");
  const isProductionToken = accessToken.startsWith("APP_USR-") || accessToken.startsWith("APP_USR_");

  logger.info("Credenciais do Mercado Pago detectadas:", {
    tokenPrefix: accessToken.substring(0, 10) + "...",
    isTestToken,
    isProductionToken,
    nodeEnv: process.env.NODE_ENV,
  });

  if (process.env.NODE_ENV === "production" && isTestToken) {
    logger.warn("⚠️ ATENÇÃO: Usando credenciais de TESTE em PRODUÇÃO!");
    logger.warn("⚠️ Isso causará erro 'Unauthorized use of live credentials' se tentar processar pagamentos reais!");
  }

  if (process.env.NODE_ENV !== "production" && isProductionToken) {
    logger.warn("⚠️ ATENÇÃO: Usando credenciais de PRODUÇÃO em ambiente de desenvolvimento!");
    logger.warn("⚠️ Use credenciais de TESTE para desenvolvimento. Cartões de teste não funcionam com credenciais de produção!");
  }

  // Se não for nem teste nem produção, avisar
  if (!isTestToken && !isProductionToken) {
    logger.warn("⚠️ Formato de token não reconhecido. Pode causar erros.");
  }
};

// Validação preventiva de credenciais antes de processar pagamento
const validateCredentialsBeforePayment = (): void => {
  const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

  if (!accessToken || accessToken.trim() === "") {
    throw new AppError(
      "MERCADOPAGO_ACCESS_TOKEN não configurado. Configure a variável de ambiente antes de processar pagamentos.",
      500
    );
  }

  // Mercado Pago usa tanto hífen quanto underscore - aceitar ambos
  const isTestToken = accessToken.startsWith("TEST-") || accessToken.startsWith("TEST_");
  const isProductionToken = accessToken.startsWith("APP_USR-") || accessToken.startsWith("APP_USR_");
  const isProduction = process.env.NODE_ENV === "production";

  // Validar formato do token
  if (!isTestToken && !isProductionToken) {
    throw new AppError(
      `Formato de token inválido. O token deve começar com "TEST-" ou "TEST_" (teste) ou "APP_USR-" ou "APP_USR_" (produção). ` +
      `Token recebido começa com: "${accessToken.substring(0, 10)}..."`,
      500
    );
  }

  // Validar compatibilidade entre credenciais e ambiente
  if (isProduction && isTestToken) {
    throw new AppError(
      "Incompatibilidade detectada: Credenciais de TESTE em ambiente de PRODUÇÃO. " +
      "Use credenciais de produção (APP_USR_...) ou altere NODE_ENV para 'development'. " +
      "Isso causará erro 'Unauthorized use of live credentials' ao processar pagamentos.",
      500
    );
  }

  if (!isProduction && isProductionToken) {
    logger.warn(
      "Credenciais de PRODUÇÃO detectadas em ambiente de desenvolvimento. " +
      "Recomendado: Use credenciais de teste (TEST_...) para desenvolvimento. " +
      "Cartões de teste não funcionam com credenciais de produção."
    );
  }
};

// Traduzir erros do Mercado Pago para mensagens amigáveis
export const translateMercadoPagoError = (error: any): string => {
  const errorMessage = error.message || "";
  const errorCause = error.cause?.[0]?.description || error.cause?.[0]?.message || "";
  const fullError = `${errorMessage} ${errorCause}`.trim();

  const errorMessages: Record<string, string> = {
    "Unauthorized use of live credentials": "Erro de configuração do pagamento. Verifique as credenciais do Mercado Pago. Se estiver em ambiente de teste, use credenciais de teste.",
    "Different parameters for the bin": "Os dados do cartão não correspondem. Por favor, verifique o número do cartão e tente novamente. Se o problema persistir, tente com outro cartão.",
    "Bin not found": "Não foi possível identificar o cartão. Por favor, verifique se o número do cartão está correto e tente novamente. Se estiver usando cartão de teste, certifique-se de usar um cartão de teste válido do Mercado Pago.",
    "invalid_card_data": "Dados do cartão inválidos. Verifique os dados informados.",
    "invalid_card_number": "Número do cartão inválido. Verifique e tente novamente.",
    "invalid_security_code": "Código de segurança inválido. Verifique o CVV do cartão.",
    "invalid_expiration_date": "Data de expiração inválida. Verifique a data de validade do cartão.",
    "insufficient_amount": "Saldo insuficiente no cartão.",
    "card_disabled": "Cartão desabilitado. Entre em contato com o banco emissor.",
    "card_error": "Erro ao processar cartão. Tente novamente ou use outro cartão.",
    "invalid_token": "Token do cartão inválido. Por favor, preencha os dados novamente.",
    "expired_token": "Token do cartão expirado. Por favor, preencha os dados novamente.",
  };

  // Procurar por chaves parciais
  for (const [key, message] of Object.entries(errorMessages)) {
    if (fullError.toLowerCase().includes(key.toLowerCase())) {
      return message;
    }
  }

  // Se não encontrou tradução, retornar mensagem genérica ou original
  if (errorCause) {
    return errorCause;
  }

  if (errorMessage) {
    return errorMessage;
  }

  return "Erro ao processar pagamento. Por favor, tente novamente ou entre em contato com o suporte.";
};

// Inicializar cliente do Mercado Pago
let client: MercadoPagoConfig | null = null;
let payment: Payment | null = null;
let preference: Preference | null = null;
let preapproval: PreApproval | null = null;
let preapprovalPlan: PreApprovalPlan | null = null;

const initializeMercadoPago = (): void => {
  if (client && payment && preference && preapproval && preapprovalPlan) {
    return; // Já inicializado
  }

  try {
    validateMercadoPagoCredentials();
    client = new MercadoPagoConfig({
      accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || "",
      options: {
        timeout: 5000,
        idempotencyKey: "abc",
      },
    });
    payment = new Payment(client);
    preference = new Preference(client);
    preapproval = new PreApproval(client);
    preapprovalPlan = new PreApprovalPlan(client);
  } catch (error: any) {
    logger.error("Erro ao inicializar Mercado Pago:", error);
    throw error; // Relançar para que o erro seja tratado adequadamente
  }
};

// Tentar inicializar na importação do módulo
try {
  initializeMercadoPago();
} catch (error: any) {
  logger.warn("Mercado Pago não inicializado na importação do módulo. Será inicializado quando necessário.");
}

interface PaymentData {
  transactionAmount: number;
  description: string;
  paymentMethodId: string;
  issuerId?: string;
  token: string;
  installments: number;
  identificationType: string;
  identificationNumber: string;
  payer: {
    email: string;
    firstName?: string;
    lastName?: string;
  };
  metadata?: {
    companyId?: number;
    invoiceId?: number;
    planId?: number;
    [key: string]: any; // Permite campos adicionais para flexibilidade
  };
}

interface PaymentIntentData {
  transactionAmount: number;
  description: string;
  metadata?: {
    companyId?: number;
    invoiceId?: number;
    planId?: number;
    companyName?: string;
    companyEmail?: string;
    companyPhone?: string;
    companyPasswordHash?: string;
    recurrence?: string;
    campaignsEnabled?: boolean;
    [key: string]: any;
  };
  payer?: {
    email: string;
    name: string;
  };
  notification_url?: string;
  // Opções de personalização do Checkout Pro
  customization?: {
    // Cores do tema
    theme?: {
      elementsColor?: string; // Cor dos elementos (botões, links) - formato hex: "#00D9FF"
      headerColor?: string; // Cor do cabeçalho - formato hex
    };
    // Textos personalizados
    texts?: {
      valueProp?: string; // Texto de proposta de valor
      securityCode?: string; // Texto sobre código de segurança
    };
    // Configurações de parcelas
    installments?: number; // Número máximo de parcelas
    // Excluir métodos de pagamento específicos
    excludedPaymentMethods?: string[]; // IDs dos métodos a excluir
    excludedPaymentTypes?: string[]; // Tipos de pagamento a excluir
    // Modo binário (aprovado ou rejeitado, sem pendente)
    binaryMode?: boolean;
  };
}

export const createPaymentIntent = async (
  data: PaymentIntentData
): Promise<any> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preference) {
      initializeMercadoPago();
    }

    if (!preference) {
      throw new AppError("Erro ao inicializar serviço de pagamento. Entre em contato com o suporte.", 500);
    }

    // Criar preferência de pagamento para obter public key e outros dados necessários
    // Usar external_reference para identificar a preferência depois
    const externalReference = `pref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const preferenceData: any = {
      items: [
        {
          id: `item-${Date.now()}`,
          title: data.description,
          quantity: 1,
          unit_price: data.transactionAmount,
        },
      ],
      metadata: {
        ...data.metadata,
        external_reference: externalReference,
      },
      external_reference: externalReference,
      back_urls: {
        success: `${process.env.FRONTEND_URL}/signup/success`,
        failure: `${process.env.FRONTEND_URL}/signup/failure`,
        pending: `${process.env.FRONTEND_URL}/signup/pending`,
      },
      auto_return: "approved",
      // Personalização visual do checkout alinhada ao design da plataforma
      ...(data.customization?.theme && {
        theme: {
          elementsColor: data.customization.theme.elementsColor || "#00D9FF",
          headerColor: data.customization.theme.headerColor || "#0A0A0F",
        },
      }),
      // Configurações de métodos de pagamento
      payment_methods: {
        excluded_payment_types: data.customization?.excludedPaymentTypes || [],
        excluded_payment_methods: data.customization?.excludedPaymentMethods || [],
        installments: data.customization?.installments || 12,
      },
      // Textos personalizados
      ...(data.customization?.texts && {
        texts: {
          valueProp: data.customization.texts.valueProp || "Segurança e agilidade em seus pagamentos",
          securityCode: data.customization.texts.securityCode || "Código de segurança",
        },
      }),
      // Modo binário (opcional - apenas aprovado ou rejeitado)
      ...(data.customization?.binaryMode !== undefined && {
        binary_mode: data.customization.binaryMode,
      }),
      // Configurações adicionais
      statement_descriptor: "COMPUCHAT",
      expires: true,
      expiration_date_from: new Date().toISOString(),
      expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 horas
      // Nota: Assinaturas recorrentes no Mercado Pago Checkout Pro
      // O Checkout Pro não cria assinaturas recorrentes automaticamente.
      // A recorrência será gerenciada via sistema interno que:
      // 1. Monitora dueDate das empresas
      // 2. Cria nova preferência quando próximo do vencimento
      // 3. Envia link de pagamento para renovação via webhook ou processo agendado
      // O campo recurrence no metadata será usado para definir o período de renovação
    };

    // Adicionar payer se fornecido
    if (data.payer) {
      preferenceData.payer = {
        email: data.payer.email,
        name: data.payer.name,
      };
    }

    // Adicionar notification_url se fornecido
    if (data.notification_url) {
      preferenceData.notification_url = data.notification_url;
    }

    const response = await preference.create({ body: preferenceData });
    const preferenceId = response.id;

    // Nota: Não tentamos atualizar a preferência após criação porque:
    // 1. O Mercado Pago pode não permitir atualizar preferências após criação
    // 2. O preference_id será salvo no sessionStorage antes do redirecionamento
    // 3. As páginas de callback podem obter o preference_id do sessionStorage se não vier na URL

    return {
      preferenceId: preferenceId,
      publicKey: process.env.MERCADOPAGO_PUBLIC_KEY,
      initPoint: response.init_point,
      externalReference: externalReference,
    };
  } catch (error: any) {
    logger.error("Erro ao criar payment intent:", error);
    throw new AppError(
      error.message || "Erro ao criar intenção de pagamento",
      400
    );
  }
};

export const processPayment = async (
  paymentData: PaymentData
): Promise<any> => {
  try {
    // Validação preventiva de credenciais ANTES de qualquer processamento
    validateCredentialsBeforePayment();

    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!payment) {
      initializeMercadoPago();
    }

    if (!payment) {
      throw new AppError("Erro ao inicializar serviço de pagamento. Entre em contato com o suporte.", 500);
    }

    // Log das credenciais sendo usadas (sem expor o token completo)
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || "NÃO CONFIGURADO";
    const tokenType = (accessToken.startsWith("TEST-") || accessToken.startsWith("TEST_")) ? "TESTE" :
      (accessToken.startsWith("APP_USR-") || accessToken.startsWith("APP_USR_")) ? "PRODUÇÃO" : "DESCONHECIDO";

    logger.info("Credenciais do Mercado Pago em uso:", {
      tokenType,
      tokenPrefix: accessToken.substring(0, 15) + "...",
      nodeEnv: process.env.NODE_ENV,
    });

    // Validar token do cartão
    if (!paymentData.token || paymentData.token.trim() === "") {
      logger.error("Token do cartão vazio ou inválido");
      throw new AppError("Token do cartão inválido. Por favor, preencha os dados novamente.", 400);
    }

    // Validar formato do token (geralmente começa com caracteres alfanuméricos)
    const tokenPattern = /^[a-zA-Z0-9_-]+$/;
    if (!tokenPattern.test(paymentData.token)) {
      logger.error("Token do cartão com formato inválido:", paymentData.token.substring(0, 10) + "...");
      throw new AppError("Token do cartão com formato inválido. Por favor, preencha os dados novamente.", 400);
    }

    logger.info("Token do cartão recebido:", {
      tokenLength: paymentData.token.length,
      tokenPrefix: paymentData.token.substring(0, 10) + "...",
    });

    // Validar dados básicos
    if (!paymentData.transactionAmount || paymentData.transactionAmount <= 0) {
      throw new AppError("Valor da transação inválido.", 400);
    }

    if (!paymentData.paymentMethodId) {
      throw new AppError("Método de pagamento não informado.", 400);
    }

    // Validar paymentMethodId
    if (!paymentData.paymentMethodId || paymentData.paymentMethodId.trim() === "") {
      logger.error("paymentMethodId não informado ou vazio");
      throw new AppError("Método de pagamento não identificado. Verifique os dados do cartão.", 400);
    }

    logger.info("Processando pagamento:", {
      transactionAmount: paymentData.transactionAmount,
      paymentMethodId: paymentData.paymentMethodId,
      installments: paymentData.installments,
      hasToken: !!paymentData.token,
      hasIssuerId: !!paymentData.issuerId && paymentData.issuerId.trim() !== "",
      payerEmail: paymentData.payer.email,
    });

    const paymentBody: any = {
      transaction_amount: paymentData.transactionAmount,
      description: paymentData.description,
      payment_method_id: paymentData.paymentMethodId,
      token: paymentData.token,
      installments: paymentData.installments,
      payer: {
        identification: {
          type: paymentData.identificationType,
          number: paymentData.identificationNumber,
        },
        email: paymentData.payer.email,
        first_name: paymentData.payer.firstName || "",
        last_name: paymentData.payer.lastName || "",
      },
      metadata: paymentData.metadata || {},
    };

    // issuer_id: Por padrão, NÃO enviamos issuer_id para evitar erro "Different parameters for the bin"
    // O Mercado Pago geralmente consegue processar o pagamento sem issuer_id
    // Só incluímos se for explicitamente necessário e válido
    // NOTA: O erro "Different parameters for the bin" geralmente ocorre quando o issuer_id não corresponde ao BIN do cartão
    // Por segurança, vamos omitir o issuer_id na maioria dos casos
    if (paymentData.issuerId && paymentData.issuerId.trim() !== "") {
      const issuerIdNumber = parseInt(paymentData.issuerId, 10);
      if (!isNaN(issuerIdNumber) && issuerIdNumber > 0) {
        // Por enquanto, vamos NÃO incluir issuer_id para evitar erros
        // Se necessário no futuro, podemos adicionar lógica específica
        logger.info("issuerId fornecido mas omitindo para evitar erro 'Different parameters for the bin':", issuerIdNumber);
        // paymentBody.issuer_id = issuerIdNumber; // Comentado para evitar erros
      }
    }

    logger.info("Processando pagamento SEM issuer_id para evitar conflitos com BIN do cartão");

    logger.info("Enviando requisição ao Mercado Pago:", {
      transactionAmount: paymentBody.transaction_amount,
      paymentMethodId: paymentBody.payment_method_id,
      installments: paymentBody.installments,
      hasToken: !!paymentBody.token,
      hasIssuerId: !!paymentBody.issuer_id,
    });

    if (!payment) {
      throw new AppError("Serviço de pagamento não inicializado.", 500);
    }

    const response = await payment.create({ body: paymentBody });

    logger.info("Pagamento processado com sucesso:", {
      paymentId: response.id,
      status: response.status,
      statusDetail: response.status_detail,
    });

    return {
      id: response.id,
      status: response.status,
      statusDetail: response.status_detail,
      transactionAmount: response.transaction_amount,
      dateCreated: response.date_created,
      dateApproved: response.date_approved,
    };
  } catch (error: any) {
    // Usar função de logging robusta
    logErrorDetails(error, {
      paymentData: {
        transactionAmount: paymentData.transactionAmount,
        paymentMethodId: paymentData.paymentMethodId,
        tokenLength: paymentData.token?.length,
        installments: paymentData.installments,
        hasIssuerId: !!paymentData.issuerId,
      },
      credentials: {
        tokenType: (process.env.MERCADOPAGO_ACCESS_TOKEN?.startsWith("TEST-") || process.env.MERCADOPAGO_ACCESS_TOKEN?.startsWith("TEST_")) ? "TESTE" :
          (process.env.MERCADOPAGO_ACCESS_TOKEN?.startsWith("APP_USR-") || process.env.MERCADOPAGO_ACCESS_TOKEN?.startsWith("APP_USR_")) ? "PRODUÇÃO" : "DESCONHECIDO",
        nodeEnv: process.env.NODE_ENV,
      },
    });

    // Log COMPLETO do erro do Mercado Pago - capturar TODAS as propriedades
    const errorDetails: any = {
      name: error.name,
      message: error.message,
      status: error.status,
      statusCode: error.statusCode,
      type: error.type,
    };

    // Capturar cause completo
    if (error.cause) {
      if (Array.isArray(error.cause)) {
        errorDetails.causeArray = error.cause.map((c: any, index: number) => ({
          index,
          code: c.code,
          description: c.description,
          message: c.message,
          data: c.data,
          field: c.field,
          fullCause: c,
        }));
      } else {
        errorDetails.cause = {
          code: error.cause.code,
          description: error.cause.description,
          message: error.cause.message,
          data: error.cause.data,
          field: error.cause.field,
          fullCause: error.cause,
        };
      }
    }

    // Capturar response se existir
    if (error.response) {
      errorDetails.response = {
        status: error.response.status,
        statusText: error.response.statusText,
        data: error.response.data,
      };
    }

    // Capturar APIError específico do Mercado Pago
    if (error.api_response) {
      errorDetails.apiResponse = error.api_response;
    }

    // Capturar todas as propriedades do erro
    errorDetails.allProperties = Object.keys(error);

    // Tentar serializar o erro completo (pode falhar se tiver referências circulares)
    try {
      errorDetails.errorString = JSON.stringify(error, Object.getOwnPropertyNames(error), 2);
    } catch (e) {
      errorDetails.errorString = "Erro ao serializar: " + String(error);
    }

    // Log detalhado - usar console.error diretamente para garantir que apareça
    console.error("\n╔═══════════════════════════════════════════════════════════════╗");
    console.error("║          ERRO COMPLETO DO MERCADO PAGO                      ║");
    console.error("╚═══════════════════════════════════════════════════════════════╝");
    console.error("\nMensagem:", errorDetails.message);
    console.error("Nome:", errorDetails.name);
    console.error("Status:", errorDetails.status);
    console.error("Status Code:", errorDetails.statusCode);
    console.error("\n--- CAUSE ---");
    if (errorDetails.causeArray && errorDetails.causeArray.length > 0) {
      errorDetails.causeArray.forEach((cause: any, idx: number) => {
        console.error(`Cause[${idx}]:`, JSON.stringify(cause, null, 2));
      });
    } else if (errorDetails.cause) {
      console.error("Cause:", JSON.stringify(errorDetails.cause, null, 2));
    } else {
      console.error("Cause: não encontrado");
    }
    console.error("\n--- RESPONSE ---");
    if (errorDetails.response) {
      console.error("Response:", JSON.stringify(errorDetails.response, null, 2));
    } else {
      console.error("Response: não encontrado");
    }
    console.error("\n--- TODAS AS PROPRIEDADES ---");
    console.error("Propriedades:", errorDetails.allProperties?.join(", ") || "nenhuma");
    console.error("\n--- ERRO COMPLETO (JSON) ---");
    console.error(errorDetails.errorString || "Não foi possível serializar");
    console.error("\n╔═══════════════════════════════════════════════════════════════╗");
    console.error("║                    FIM DO ERRO                             ║");
    console.error("╚═══════════════════════════════════════════════════════════════╝\n");

    // Log usando console.error e stderr para garantir que apareça (logger do pino pode não exibir objetos complexos)
    const errorDetailsJson = JSON.stringify({
      msg: "Erro COMPLETO do Mercado Pago",
      errorName: errorDetails.name,
      errorMessage: errorDetails.message,
      errorStatus: errorDetails.status,
      errorStatusCode: errorDetails.statusCode,
      causeArray: errorDetails.causeArray,
      cause: errorDetails.cause,
      response: errorDetails.response,
    }, null, 2);

    console.error("\n[ERRO DETALHADO DO MERCADO PAGO]", errorDetailsJson);
    try {
      process.stderr.write(`\n[ERRO DETALHADO DO MERCADO PAGO] ${errorDetailsJson}\n`);
    } catch (e) {
      // Se stderr.write falhar, continuar
    }

    // Log usando logger também (formato que pino entende melhor)
    logger.error({
      msg: "Erro COMPLETO do Mercado Pago",
      errorName: errorDetails.name,
      errorMessage: errorDetails.message,
      errorStatus: errorDetails.status,
      errorStatusCode: errorDetails.statusCode,
    });

    // Extrair mensagem de erro mais específica
    let errorMessage = error.message || "Erro ao processar pagamento";
    let errorCode = null;

    // Verificar se é erro de credenciais (pode estar em diferentes lugares)
    const errorMessageLower = error.message?.toLowerCase() || "";
    const errorString = JSON.stringify(error).toLowerCase();
    const isCredentialsError =
      errorMessageLower.includes("unauthorized use of live credentials") ||
      errorMessageLower.includes("unauthorized") ||
      errorString.includes("unauthorized use of live credentials") ||
      (Array.isArray(error.cause) && error.cause.some((c: any) =>
        c.description?.toLowerCase().includes("unauthorized use of live credentials") ||
        c.message?.toLowerCase().includes("unauthorized use of live credentials")
      )) ||
      (error.cause?.description?.toLowerCase().includes("unauthorized use of live credentials"));

    if (isCredentialsError) {
      const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN || "NÃO CONFIGURADO";
      const tokenType = (accessToken.startsWith("TEST-") || accessToken.startsWith("TEST_")) ? "TESTE" :
        (accessToken.startsWith("APP_USR-") || accessToken.startsWith("APP_USR_")) ? "PRODUÇÃO" : "DESCONHECIDO";

      // Log direto no console para garantir que apareça
      console.error("\n⚠️⚠️⚠️ ERRO DE CREDENCIAIS DETECTADO ⚠️⚠️⚠️");
      console.error("Token Type:", tokenType);
      console.error("Token Prefix:", accessToken.substring(0, 15) + "...");
      console.error("NODE_ENV:", process.env.NODE_ENV);
      console.error("Problema:", tokenType === "PRODUÇÃO"
        ? "Credenciais de PRODUÇÃO detectadas. Use credenciais de TESTE para desenvolvimento."
        : tokenType === "TESTE"
          ? "Credenciais de TESTE detectadas. Certifique-se de usar cartões de teste válidos."
          : "Formato de token não reconhecido.");
      console.error("Solução: Verifique o arquivo MERCADOPAGO_SETUP.md para instruções detalhadas.");
      console.error("⚠️⚠️⚠️ FIM DO ERRO DE CREDENCIAIS ⚠️⚠️⚠️\n");

      logger.error({
        msg: "⚠️ ERRO DE CREDENCIAIS DETECTADO",
        accessTokenPrefix: accessToken.substring(0, 15) + "...",
        tokenType,
        nodeEnv: process.env.NODE_ENV,
        problema: tokenType === "PRODUÇÃO"
          ? "Credenciais de PRODUÇÃO detectadas. Use credenciais de TESTE para desenvolvimento."
          : tokenType === "TESTE"
            ? "Credenciais de TESTE detectadas. Certifique-se de usar cartões de teste válidos."
            : "Formato de token não reconhecido.",
        solucao: "Verifique o arquivo MERCADOPAGO_SETUP.md para instruções detalhadas.",
      });
    }

    // Tentar extrair mensagem do cause array
    if (Array.isArray(error.cause) && error.cause.length > 0) {
      const firstCause = error.cause[0];
      if (firstCause.description) {
        errorMessage = firstCause.description;
      } else if (firstCause.message) {
        errorMessage = firstCause.message;
      }
      if (firstCause.code) {
        errorCode = firstCause.code;
      }
    } else if (error.cause?.description) {
      errorMessage = error.cause.description;
      errorCode = error.cause.code;
    } else if (error.cause?.message) {
      errorMessage = error.cause.message;
      errorCode = error.cause.code;
    }

    // Se for erro "Bin not found", adicionar informações adicionais
    if (errorMessage.toLowerCase().includes("bin not found") || errorCode === "bin_not_found") {
      logger.error("Erro 'Bin not found' - possíveis causas:", {
        tokenLength: paymentData.token?.length,
        paymentMethodId: paymentData.paymentMethodId,
        hasIssuerId: !!paymentData.issuerId,
        suggestion: "O token pode estar inválido ou o número do cartão pode estar incorreto. Tente recriar o token.",
      });
    }

    // Traduzir erro para mensagem amigável
    const friendlyMessage = translateMercadoPagoError({ message: errorMessage, cause: error.cause });

    // Log usando console.error e stderr para garantir que apareça
    const translationLog = {
      original: errorMessage,
      errorCode: errorCode,
      translated: friendlyMessage,
    };

    console.error("\n[ERRO TRADUZIDO]", JSON.stringify(translationLog, null, 2));
    try {
      process.stderr.write(`\n[ERRO TRADUZIDO] ${JSON.stringify(translationLog, null, 2)}\n`);
    } catch (e) {
      // Se stderr.write falhar, continuar
    }

    logger.error({
      msg: "Erro traduzido",
      original: errorMessage,
      errorCode: errorCode,
      translated: friendlyMessage,
    });

    throw new AppError(friendlyMessage, 400);
  }
};

export const getPaymentStatus = async (paymentId: string): Promise<any> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!payment) {
      initializeMercadoPago();
    }

    if (!payment) {
      throw new AppError("Erro ao inicializar serviço de pagamento. Entre em contato com o suporte.", 500);
    }

    const response = await payment.get({ id: paymentId });

    return {
      id: response.id,
      status: response.status,
      statusDetail: response.status_detail,
      transactionAmount: response.transaction_amount,
      dateCreated: response.date_created,
      dateApproved: response.date_approved,
      metadata: response.metadata,
    };
  } catch (error: any) {
    logger.error("Erro ao consultar status do pagamento:", error);
    throw new AppError(
      error.message || "Erro ao consultar status do pagamento",
      400
    );
  }
};

export const getPreferenceStatus = async (preferenceId: string): Promise<any> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preference || !payment) {
      initializeMercadoPago();
    }

    if (!preference || !payment) {
      throw new AppError("Erro ao inicializar serviço de pagamento. Entre em contato com o suporte.", 500);
    }

    // Buscar preferência
    const preferenceData = await preference.get({ preferenceId: preferenceId });

    // Buscar pagamentos associados à preferência
    // O Mercado Pago retorna os pagamentos na resposta da preference quando disponíveis
    let latestPayment = null;
    let latestStatus = "pending";

    // Primeiro, tentar obter external_reference da preferência
    const externalReference = preferenceData.external_reference;

    if (externalReference) {
      try {
        // Buscar pagamentos usando search API por external_reference
        // O SDK do Mercado Pago usa query string direta
        const searchResponse = await payment.search({
          options: {
            qs: `external_reference=${externalReference}&sort=date_created&criteria=desc`
          }
        });

        if (searchResponse && searchResponse.results && searchResponse.results.length > 0) {
          // Pegar o pagamento mais recente
          latestPayment = searchResponse.results[0];
          latestStatus = latestPayment.status || "pending";
        }
      } catch (searchError: any) {
        logger.warn("Erro ao buscar pagamentos por external_reference (não crítico):", searchError.message);
      }
    }

    // Se não encontrou pagamento, verificar se há payment_id na metadata
    if (!latestPayment && preferenceData.metadata) {
      const paymentIdFromMetadata = preferenceData.metadata.payment_id;
      if (paymentIdFromMetadata) {
        try {
          const paymentData = await payment.get({ id: paymentIdFromMetadata });
          latestPayment = paymentData;
          latestStatus = paymentData.status || "pending";
        } catch (paymentError: any) {
          logger.warn("Erro ao buscar pagamento por ID da metadata:", paymentError.message);
        }
      }
    }

    return {
      preferenceId: preferenceData.id,
      status: latestStatus,
      payment: latestPayment,
      initPoint: preferenceData.init_point,
      sandboxInitPoint: preferenceData.sandbox_init_point,
    };
  } catch (error: any) {
    logger.error("Erro ao consultar status da preferência:", error);
    throw new AppError(
      error.message || "Erro ao consultar status da preferência",
      400
    );
  }
};

export const processWebhook = async (data: any): Promise<any> => {
  try {
    // Mercado Pago envia notificações em diferentes formatos
    // Pode vir como { type: "payment", data: { id: "..." } }
    // Ou diretamente como { action: "payment.updated", data: { id: "..." } }

    let paymentId: string | null = null;

    if (data.type === "payment" && data.data?.id) {
      paymentId = data.data.id.toString();
    } else if (data.action === "payment.updated" && data.data?.id) {
      paymentId = data.data.id.toString();
    } else if (data.data?.id) {
      paymentId = data.data.id.toString();
    } else if (data.id) {
      paymentId = data.id.toString();
    }

    if (!paymentId) {
      logger.warn("Webhook recebido sem payment ID:", data);
      return null;
    }

    const paymentInfo = await getPaymentStatus(paymentId);

    return {
      paymentId: paymentInfo.id,
      status: paymentInfo.status,
      statusDetail: paymentInfo.statusDetail,
      metadata: paymentInfo.metadata,
    };
  } catch (error: any) {
    logger.error("Erro ao processar webhook:", error);
    throw new AppError(error.message || "Erro ao processar webhook", 400);
  }
};

export const createCardToken = async (cardData: {
  cardNumber: string;
  cardholderName: string;
  expirationMonth: string;
  expirationYear: string;
  securityCode: string;
  identificationType: string;
  identificationNumber: string;
}): Promise<any> => {
  try {
    // AVISO: Esta implementação viola PCI DSS pois os dados do cartão passam pelo servidor
    // O ideal é usar Secure Fields no frontend

    // Validar dados antes de criar token
    const cardNumberClean = cardData.cardNumber.replace(/\s|-/g, "");
    if (cardNumberClean.length < 13 || cardNumberClean.length > 19) {
      throw new AppError("Número do cartão inválido. Verifique e tente novamente.", 400);
    }

    if (!cardData.cardholderName || cardData.cardholderName.trim().length < 3) {
      throw new AppError("Nome do titular inválido. Verifique e tente novamente.", 400);
    }

    if (!cardData.securityCode || cardData.securityCode.length < 3 || cardData.securityCode.length > 4) {
      throw new AppError("Código de segurança (CVV) inválido. Verifique e tente novamente.", 400);
    }

    const identificationNumberClean = cardData.identificationNumber.replace(/\D/g, "");
    if (identificationNumberClean.length < 11) {
      throw new AppError("CPF/CNPJ inválido. Verifique e tente novamente.", 400);
    }

    const tokenData = {
      card_number: cardNumberClean,
      cardholder: {
        name: cardData.cardholderName.trim(),
        identification: {
          type: cardData.identificationType,
          number: identificationNumberClean,
        },
      },
      security_code: cardData.securityCode,
      expiration_month: cardData.expirationMonth.padStart(2, "0"),
      expiration_year: cardData.expirationYear.length === 2 ? `20${cardData.expirationYear}` : cardData.expirationYear,
    };

    logger.info("Criando token do cartão:", {
      cardNumberLength: cardNumberClean.length,
      cardNumberPrefix: cardNumberClean.substring(0, 6) + "****",
      hasCardholderName: !!tokenData.cardholder.name,
      expirationMonth: tokenData.expiration_month,
      expirationYear: tokenData.expiration_year,
    });

    // Usar API REST do Mercado Pago para criar token
    const response = await fetch("https://api.mercadopago.com/v1/card_tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(tokenData),
    });

    if (!response.ok) {
      const errorData = await response.json();
      logger.error("Erro ao criar token do Mercado Pago:", {
        status: response.status,
        statusText: response.statusText,
        error: errorData,
      });

      // Traduzir erro específico
      let errorMessage = errorData.message || "Erro ao criar token do cartão";
      if (errorData.cause && Array.isArray(errorData.cause) && errorData.cause.length > 0) {
        errorMessage = errorData.cause[0].description || errorMessage;
      }

      throw new AppError(
        translateMercadoPagoError({ message: errorMessage, cause: errorData.cause }) || errorMessage,
        400
      );
    }

    const token = await response.json();

    logger.info("Token criado com sucesso:", {
      tokenId: token.id,
      hasFirstSixDigits: !!token.first_six_digits,
      hasLastFourDigits: !!token.last_four_digits,
    });

    return token;
  } catch (error: any) {
    logger.error("Erro ao criar card token:", {
      error: error.message,
      stack: error.stack?.substring(0, 300),
    });

    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError(
      error.message || "Erro ao criar token do cartão. Por favor, verifique os dados e tente novamente.",
      400
    );
  }
};

export const getPaymentMethodsByBin = async (bin: string): Promise<any> => {
  try {
    const response = await fetch(
      `https://api.mercadopago.com/v1/payment_methods/card_issuers?bin=${bin}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.MERCADOPAGO_ACCESS_TOKEN}`,
        },
      }
    );

    if (!response.ok) {
      logger.warn("Erro ao obter informações do cartão:", await response.text());
      return [];
    }

    const data = await response.json();
    return data;
  } catch (error: any) {
    logger.error("Erro ao obter payment methods:", error);
    return [];
  }
};

export const validateCardData = (cardData: any): boolean => {
  // Validação básica da estrutura dos dados do cartão
  if (!cardData.cardNumber || !cardData.cardholderName) {
    return false;
  }

  // Validar número do cartão (remover espaços e traços)
  const cardNumber = cardData.cardNumber.replace(/\s|-/g, "");
  if (cardNumber.length < 13 || cardNumber.length > 19) {
    return false;
  }

  // Validar CVV
  if (!cardData.securityCode || cardData.securityCode.length < 3 || cardData.securityCode.length > 4) {
    return false;
  }

  // Validar data de expiração
  if (!cardData.expirationDate || !cardData.expirationDate.match(/^\d{2}\/\d{2}$/)) {
    return false;
  }

  return true;
};

// ==================== PREAPPROVAL / ASSINATURAS RECORRENTES ====================

interface CreatePreapprovalData {
  companyId: number;
  planId: number;
  cardTokenId: string;
  payerEmail: string;
  payerName: string;
  transactionAmount: number;
  recurrence?: string; // MENSAL, TRIMESTRAL, SEMESTRAL, ANUAL
}

interface ProcessPreapprovalPaymentData {
  companyId: number;
  planId: number;
  transactionAmount: number;
}

/**
 * Cria um Preapproval (assinatura recorrente) no Mercado Pago
 */
export const createPreapproval = async (
  data: CreatePreapprovalData
): Promise<{ preapprovalId: string; initPoint?: string }> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preapproval) {
      initializeMercadoPago();
    }

    if (!preapproval) {
      throw new AppError("Erro ao inicializar serviço de pagamento. Entre em contato com o suporte.", 500);
    }

    // Calcular frequência baseado na recorrência
    const recurrence = data.recurrence || "MENSAL";
    let frequency = 1;
    let frequencyType: "days" | "weeks" | "months" = "months";

    if (recurrence === "ANUAL") {
      frequency = 12;
      frequencyType = "months";
    } else if (recurrence === "SEMESTRAL") {
      frequency = 6;
      frequencyType = "months";
    } else if (recurrence === "TRIMESTRAL") {
      frequency = 3;
      frequencyType = "months";
    } else if (recurrence === "MENSAL") {
      frequency = 1;
      frequencyType = "months";
    }

    const preapprovalData: any = {
      reason: `Assinatura ${recurrence} - ${data.payerName}`,
      payer_email: data.payerEmail,
      card_token_id: data.cardTokenId,
      status: "authorized",
      auto_recurring: {
        frequency: frequency,
        frequency_type: frequencyType,
        transaction_amount: data.transactionAmount,
        currency_id: "BRL",
        start_date: new Date().toISOString(),
      },
      external_reference: `company_${data.companyId}_plan_${data.planId}`,
      back_url: `${process.env.FRONTEND_URL}/financeiro`,
      notification_url: `${process.env.BACKEND_URL}/mercadopago/webhook`,
    };

    logger.info("Criando Preapproval:", {
      companyId: data.companyId,
      planId: data.planId,
      recurrence,
      frequency,
      frequencyType,
    });

    const response = await preapproval.create({ body: preapprovalData });
    const preapprovalId = response.id;

    logger.info("Preapproval criado com sucesso:", {
      preapprovalId,
      companyId: data.companyId,
    });

    return {
      preapprovalId: preapprovalId,
      initPoint: response.init_point,
    };
  } catch (error: any) {
    logger.error("Erro ao criar Preapproval:", error);
    logErrorDetails(error, {
      companyId: data.companyId,
      planId: data.planId,
    });
    throw new AppError(
      error.message || "Erro ao criar assinatura recorrente",
      400
    );
  }
};

/**
 * Processa pagamento de uma assinatura recorrente via Preapproval
 * Nota: O Mercado Pago processa automaticamente, mas podemos forçar uma cobrança
 */
export const processPreapprovalPayment = async (
  preapprovalId: string,
  metadata: ProcessPreapprovalPaymentData
): Promise<{ success: boolean; paymentId?: string; error?: string }> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preapproval) {
      initializeMercadoPago();
    }

    if (!preapproval) {
      throw new AppError("Erro ao inicializar serviço de pagamento.", 500);
    }

    // Buscar informações do Preapproval
    const preapprovalInfo = await preapproval.get({ id: preapprovalId });

    if (!preapprovalInfo || !preapprovalInfo.status) {
      throw new AppError("Preapproval não encontrado ou inválido", 404);
    }

    // Verificar status do Preapproval
    if (preapprovalInfo.status !== "authorized") {
      logger.warn(`Preapproval ${preapprovalId} não está autorizado. Status: ${preapprovalInfo.status}`);
      return {
        success: false,
        error: `Preapproval não autorizado. Status: ${preapprovalInfo.status}`,
      };
    }

    // O Mercado Pago processa pagamentos automaticamente baseado na configuração do Preapproval
    // Não há necessidade de processar manualmente, mas podemos verificar o status
    logger.info(`Preapproval ${preapprovalId} está ativo e processará pagamentos automaticamente`);

    return {
      success: true,
      paymentId: preapprovalInfo.id,
    };
  } catch (error: any) {
    logger.error("Erro ao processar pagamento do Preapproval:", error);
    logErrorDetails(error, {
      preapprovalId,
      metadata,
    });
    return {
      success: false,
      error: error.message || "Erro ao processar pagamento recorrente",
    };
  }
};

/**
 * Obtém status de um Preapproval
 */
export const getPreapprovalStatus = async (preapprovalId: string): Promise<any> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preapproval) {
      initializeMercadoPago();
    }

    if (!preapproval) {
      throw new AppError("Erro ao inicializar serviço de pagamento.", 500);
    }

    const response = await preapproval.get({ id: preapprovalId });
    return response;
  } catch (error: any) {
    logger.error("Erro ao obter status do Preapproval:", error);
    throw new AppError(
      error.message || "Erro ao consultar assinatura",
      400
    );
  }
};

/**
 * Cancela um Preapproval (assinatura)
 */
export const cancelPreapproval = async (preapprovalId: string): Promise<boolean> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preapproval) {
      initializeMercadoPago();
    }

    if (!preapproval) {
      throw new AppError("Erro ao inicializar serviço de pagamento.", 500);
    }

    // Atualizar status para cancelled
    await preapproval.update({
      id: preapprovalId,
      body: {
        status: "cancelled",
      },
    });

    logger.info(`Preapproval ${preapprovalId} cancelado com sucesso`);
    return true;
  } catch (error: any) {
    logger.error("Erro ao cancelar Preapproval:", error);
    throw new AppError(
      error.message || "Erro ao cancelar assinatura",
      400
    );
  }
};

/**
 * Atualiza um Preapproval (ex: mudar valor, frequência, etc)
 */
export const updatePreapproval = async (
  preapprovalId: string,
  updates: {
    auto_recurring?: {
      frequency?: number;
      frequency_type?: "days" | "weeks" | "months";
      transaction_amount?: number;
      currency_id?: string;
    };
    card_token_id?: string;
    status?: "authorized" | "paused" | "cancelled";
  }
): Promise<any> => {
  try {
    // Inicializar Mercado Pago se ainda não foi inicializado
    if (!preapproval) {
      initializeMercadoPago();
    }

    if (!preapproval) {
      throw new AppError("Erro ao inicializar serviço de pagamento.", 500);
    }

    const response = await preapproval.update({
      id: preapprovalId,
      body: updates as any,
    });

    logger.info(`Preapproval ${preapprovalId} atualizado com sucesso`);
    return response;
  } catch (error: any) {
    logger.error("Erro ao atualizar Preapproval:", error);
    throw new AppError(
      error.message || "Erro ao atualizar assinatura",
      400
    );
  }
};