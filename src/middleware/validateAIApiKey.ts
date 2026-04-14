import { Request, Response, NextFunction } from "express";
import { isAiBackendConfigured } from "../config/openai";

/**
 * Garante que o backend tem LM Studio (OpenAI-compat) configurado via ambiente.
 */
const validateAIApiKey = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> => {
  try {
    if (!req.user?.companyId) {
      return res.status(401).json({
        error: "ERR_UNAUTHORIZED",
        message: "Usuário não autenticado"
      });
    }

    if (!isAiBackendConfigured()) {
      return res.status(400).json({
        error: "AI_NOT_CONFIGURED",
        message:
          "Servidor de IA não configurado. O administrador deve definir LM_STUDIO_BASE_URL no ambiente do backend."
      });
    }

    next();
  } catch (err: any) {
    return res.status(500).json({
      error: "ERR_VALIDATE_AI_KEY",
      message: err.message || "Erro ao validar configuração de IA"
    });
  }
};

export default validateAIApiKey;
