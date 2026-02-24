import { Request, Response, NextFunction } from "express";
import { validateCompanyGeminiApiKey } from "../helpers/ValidateGeminiApiKey";

/**
 * Middleware para validar se a empresa tem API Key do Gemini configurada
 * Bloqueia o acesso a recursos de IA se a chave não estiver configurada
 */
const validateGeminiApiKey = async (
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

    // Valida se a empresa tem a API key configurada
    await validateCompanyGeminiApiKey(companyId);

    // Se passou na validação, continua para o próximo middleware/controller
    next();
  } catch (err: any) {
    // Se for erro de API key não configurada, retorna erro específico
    if (err.statusCode === 400 && err.message.includes("API Key do Gemini")) {
      return res.status(400).json({
        error: "GEMINI_KEY_MISSING",
        message: err.message || "A API Key do Gemini não está configurada. Configure em Configurações → Integrações → Chave da API do Gemini."
      });
    }

    // Outros erros
    return res.status(500).json({
      error: "ERR_VALIDATE_GEMINI_KEY",
      message: err.message || "Erro ao validar API Key do Gemini"
    });
  }
};

export default validateGeminiApiKey;

