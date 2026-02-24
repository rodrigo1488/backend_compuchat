import { Request, Response, NextFunction } from "express";
import AppError from "../errors/AppError";
import { logger } from "../utils/logger";

/**
 * Middleware para validar credenciais do Mercado Pago antes de processar requisições de pagamento
 * Evita processamento desnecessário quando credenciais estão incorretas
 */
export const validateMercadoPago = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const accessToken = process.env.MERCADOPAGO_ACCESS_TOKEN;

    if (!accessToken || accessToken.trim() === "") {
      logger.error("MERCADOPAGO_ACCESS_TOKEN não configurado - requisição bloqueada");
      throw new AppError(
        "Configuração de pagamento incompleta. MERCADOPAGO_ACCESS_TOKEN não configurado. Entre em contato com o suporte.",
        500
      );
    }

    const isTestToken = accessToken.startsWith("TEST_");
    const isProductionToken = accessToken.startsWith("APP_USR_");
    const isProduction = process.env.NODE_ENV === "production";

    // Validar formato do token
    if (!isTestToken && !isProductionToken) {
      logger.error(`Formato de token inválido - requisição bloqueada. Prefixo: ${accessToken.substring(0, 10)}...`);
      throw new AppError(
        `Formato de token inválido. O token deve começar com "TEST_" (teste) ou "APP_USR_" (produção). ` +
        `Token recebido começa com: "${accessToken.substring(0, 10)}..."`,
        500
      );
    }

    // Validar compatibilidade entre credenciais e ambiente
    if (isProduction && isTestToken) {
      logger.error("Incompatibilidade detectada: Credenciais de TESTE em PRODUÇÃO - requisição bloqueada");
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
        "Recomendado: Use credenciais de teste (TEST_...) para desenvolvimento."
      );
      // Não bloqueia, apenas avisa
    }

    // Se passou todas as validações, continuar
    next();
  } catch (error: any) {
    if (error instanceof AppError) {
      throw error;
    }
    logger.error("Erro no middleware validateMercadoPago:", error);
    throw new AppError(
      "Erro ao validar credenciais do Mercado Pago",
      500
    );
  }
};

