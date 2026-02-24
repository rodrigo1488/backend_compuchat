import { Request, Response, NextFunction } from "express";
import { AIProviderFactory } from "../services/AiServices/AIProviderFactory";

/**
 * Middleware genérico para validar se a empresa tem pelo menos uma API Key de IA configurada
 * (Gemini ou OpenAI)
 */
const validateAIApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> => {
  try {
    const { companyId } = req.user;

    if (!companyId) {
      return res.status(401).json({
        error: "ERR_UNAUTHORIZED",
        message: "Usuário não autenticado"
      });
    }

    // Verificar quais providers estão disponíveis
    const available = await AIProviderFactory.getAvailableProviders(companyId);

    if (!available.gemini && !available.openai) {
      return res.status(400).json({
        error: "AI_KEY_MISSING",
        message: "Nenhuma API Key de IA configurada. Configure pelo menos uma API Key (Gemini ou OpenAI) em Configurações → Integrações."
      });
    }

    // Se passou na validação, continua para o próximo middleware/controller
    next();
  } catch (err: any) {
    return res.status(500).json({
      error: "ERR_VALIDATE_AI_KEY",
      message: err.message || "Erro ao validar API Key de IA"
    });
  }
};

export default validateAIApiKey;
