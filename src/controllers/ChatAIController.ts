import { Request, Response } from "express";
import { analyzeChatContext, summarizeUnreadAudios, improveMessage, generateTicketInfo } from "../services/AiServices/ChatAIService";
import transcribeAudio from "../services/AiServices/TranscribeAudioService";
import AppError from "../errors/AppError";

export const analyze = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { ticketId, question, suggestResponse } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: "ticketId é obrigatório" });
    }

    const result = await analyzeChatContext({
      ticketId: Number(ticketId),
      companyId,
      question,
      suggestResponse: Boolean(suggestResponse)
    });

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("Erro ao analisar chat:", err);
    
    if (err.message?.includes("API Key") || err.message?.includes("GEMINI_KEY") || err.message?.includes("OPENAI")) {
      return res.status(400).json({ 
        error: "AI_KEY_MISSING",
        message: err.message || "API Key de IA não configurada"
      });
    }
    
    if (err instanceof AppError) {
      return res.status(err.statusCode || 500).json({
        error: err.message || "Erro ao analisar chat"
      });
    }
    
    return res.status(500).json({
      error: "ERR_CHAT_AI_ANALYZE",
      message: err.message || "Erro ao analisar chat com IA"
    });
  }
};

export const audioSummary = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { ticketId } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: "ticketId é obrigatório" });
    }

    const result = await summarizeUnreadAudios({
      ticketId: Number(ticketId),
      companyId
    });

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("Erro ao resumir áudios:", err);
    
    if (err.message?.includes("API Key") || err.message?.includes("GEMINI_KEY") || err.message?.includes("OPENAI")) {
      return res.status(400).json({ 
        error: "AI_KEY_MISSING",
        message: err.message || "API Key de IA não configurada"
      });
    }
    
    if (err instanceof AppError) {
      return res.status(err.statusCode || 500).json({
        error: err.message || "Erro ao resumir áudios"
      });
    }
    
    return res.status(500).json({
      error: "ERR_CHAT_AI_AUDIO_SUMMARY",
      message: err.message || "Erro ao resumir áudios com IA"
    });
  }
};

export const improve = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { ticketId, draftText } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: "ticketId é obrigatório" });
    }

    console.log(`[ChatAIController] Melhorando mensagem - ticketId: ${ticketId}, companyId: ${companyId}, draftText length: ${draftText?.length || 0}`);

    const result = await improveMessage({
      ticketId: Number(ticketId),
      companyId,
      draftText: draftText || ""
    });

    console.log(`[ChatAIController] Mensagem melhorada com sucesso - improvedText length: ${result.improvedText?.length || 0}`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("[ChatAIController] Erro ao melhorar mensagem:", err);
    console.error("[ChatAIController] Stack trace:", err.stack);
    
    if (err.message?.includes("API Key") || err.message?.includes("GEMINI_KEY") || err.message?.includes("OPENAI")) {
      return res.status(400).json({ 
        error: "AI_KEY_MISSING",
        message: err.message || "API Key de IA não configurada"
      });
    }
    
    if (err instanceof AppError) {
      return res.status(err.statusCode || 500).json({
        error: err.message || "Erro ao melhorar mensagem"
      });
    }
    
    return res.status(500).json({
      error: "ERR_CHAT_AI_IMPROVE",
      message: err.message || "Erro ao melhorar mensagem com IA"
    });
  }
};

export const transcribe = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { messageId } = req.params;

    if (!messageId) {
      return res.status(400).json({ error: "messageId é obrigatório" });
    }

    const result = await transcribeAudio({
      messageId,
      companyId
    });

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("Erro ao transcrever áudio:", err);
    
    if (err.message?.includes("GEMINI_KEY") || err.message?.includes("Chave da API") || err.message === "ERR_AI_CONFIG_MISSING") {
      return res.status(400).json({ error: "ERR_AI_CONFIG_MISSING" });
    }
    
    if (err instanceof AppError) {
      // Usar código de erro para o frontend exibir mensagem amigável via i18n
      const errorCode = err.message?.startsWith("ERR_") ? err.message.split(":")[0] : null;
      return res.status(err.statusCode || 500).json({
        error: errorCode || err.message || "ERR_CHAT_AI_TRANSCRIBE"
      });
    }
    
    return res.status(500).json({
      error: "ERR_CHAT_AI_TRANSCRIBE",
      message: err.message || "Erro ao transcrever áudio com IA"
    });
  }
};

export const generateTicket = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { ticketId } = req.body;

    if (!ticketId) {
      return res.status(400).json({ error: "ticketId é obrigatório" });
    }

    console.log(`[ChatAIController] Gerando informações do ticket - ticketId: ${ticketId}, companyId: ${companyId}`);

    const result = await generateTicketInfo({
      ticketId: Number(ticketId),
      companyId
    });

    console.log(`[ChatAIController] Informações do ticket geradas com sucesso`);

    return res.status(200).json(result);
  } catch (err: any) {
    console.error("[ChatAIController] Erro ao gerar informações do ticket:", err);
    console.error("[ChatAIController] Stack trace:", err.stack);
    
    if (err.message?.includes("API Key") || err.message?.includes("GEMINI_KEY") || err.message?.includes("OPENAI")) {
      return res.status(400).json({ 
        error: "AI_KEY_MISSING",
        message: err.message || "API Key de IA não configurada"
      });
    }
    
    if (err instanceof AppError) {
      return res.status(err.statusCode || 500).json({
        error: err.message || "Erro ao gerar informações do ticket"
      });
    }
    
    return res.status(500).json({
      error: "ERR_CHAT_AI_GENERATE_TICKET",
      message: err.message || "Erro ao gerar informações do ticket com IA"
    });
  }
};
