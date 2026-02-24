import { Request, Response } from "express";
import AgentSummaryGeminiService from "../services/ReportService/AgentSummaryGeminiService";
import ChatGeminiService from "../services/AiServices/ChatGeminiService";
import TestGeminiApiKeyService from "../services/AiServices/TestGeminiApiKeyService";
import TestOpenAIApiKeyService from "../services/AiServices/TestOpenAIApiKeyService";
import { AIProviderSelector } from "../services/AiServices/AIProviderSelector";

export const agentSummary = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { agentId, dateStart, dateEnd, maxMessages } = req.body;

    // agentId é opcional - se não fornecido, gera resumo geral
    let agentIdNumber: number | undefined = undefined;
    
    if (agentId) {
      agentIdNumber = Number(agentId);
      if (isNaN(agentIdNumber)) {
        return res.status(400).json({ error: "agentId inválido" });
      }
    }

    const summary = await AgentSummaryGeminiService({
      companyId,
      agentId: agentIdNumber,
      dateStart,
      dateEnd,
      maxMessages
    });

    return res.status(200).json(summary);
  } catch (err: any) {
    console.error("Erro ao gerar resumo IA:", err);
    
    if (err.message === "GEMINI_KEY_MISSING") {
      return res.status(400).json({ error: "GEMINI_KEY_MISSING" });
    }
    
    return res.status(500).json({ 
      error: "ERR_GEMINI_SUMMARY",
      message: err.message || "Erro ao gerar resumo com IA"
    });
  }
};

export const chat = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { message, conversationHistory, articles } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: "Mensagem é obrigatória" });
    }

    const response = await ChatGeminiService({
      companyId,
      message: message.trim(),
      conversationHistory: conversationHistory || [],
      articles: articles || []
    });

    return res.status(200).json(response);
  } catch (err: any) {
    console.error("Erro no chat IA:", err);
    
    if (err.message === "GEMINI_KEY_MISSING") {
      return res.status(400).json({ error: "GEMINI_KEY_MISSING" });
    }
    
    return res.status(500).json({ 
      error: "ERR_GEMINI_CHAT",
      message: err.message || "Erro ao processar mensagem com IA"
    });
  }
};

export const testApiKey = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { provider } = req.query; // provider pode ser "gemini" ou "openai"

    let result;
    if (provider === "openai") {
      result = await TestOpenAIApiKeyService({ companyId });
    } else {
      // Default para Gemini para manter compatibilidade
      result = await TestGeminiApiKeyService({ companyId });
    }

    if (result.valid) {
      return res.status(200).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (err: any) {
    return res.status(500).json({ 
      valid: false,
      message: err.message || "Erro ao testar chave da API"
    });
  }
};

/**
 * Obtém configurações de providers de IA
 */
export const getProviderConfigurations = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;

    const config = await AIProviderSelector.getProviderConfigurations(companyId);

    return res.status(200).json(config);
  } catch (err: any) {
    console.error("Erro ao obter configurações de providers:", err);
    return res.status(500).json({ 
      error: "ERR_GET_PROVIDER_CONFIG",
      message: err.message || "Erro ao obter configurações de providers"
    });
  }
};

/**
 * Define configuração de provider para uma funcionalidade
 */
export const setProviderConfiguration = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { functionType, provider } = req.body;

    if (!functionType || !provider) {
      return res.status(400).json({ 
        error: "functionType e provider são obrigatórios" 
      });
    }

    if (!["summaries", "chat", "messageImprovement", "transcription", "campaigns"].includes(functionType)) {
      return res.status(400).json({ 
        error: "functionType inválido" 
      });
    }

    if (!["gemini", "openai"].includes(provider)) {
      return res.status(400).json({ 
        error: "provider inválido (deve ser 'gemini' ou 'openai')" 
      });
    }

    const Setting = require("../models/Setting").default;
    const settingKeys: Record<string, string> = {
      summaries: "aiProviderSummaries",
      chat: "aiProviderChat",
      messageImprovement: "aiProviderMessageImprovement",
      transcription: "aiProviderTranscription",
      campaigns: "aiProviderCampaigns"
    };

    const settingKey = settingKeys[functionType];
    
    // Verificar se a configuração já existe
    let setting = await Setting.findOne({
      where: {
        key: settingKey,
        companyId
      }
    });

    if (setting) {
      await setting.update({ value: provider });
    } else {
      setting = await Setting.create({
        key: settingKey,
        value: provider,
        companyId
      });
    }

    return res.status(200).json({
      success: true,
      functionType,
      provider,
      message: `Provider ${provider} configurado para ${functionType}`
    });
  } catch (err: any) {
    console.error("Erro ao configurar provider:", err);
    return res.status(500).json({ 
      error: "ERR_SET_PROVIDER_CONFIG",
      message: err.message || "Erro ao configurar provider"
    });
  }
};

/**
 * Obtém configurações do chat IA
 */
export const getChatConfig = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { getChatConfig } = await import("../services/AiServices/ChatConfigService");
    const config = await getChatConfig(companyId);
    return res.status(200).json(config);
  } catch (err: any) {
    console.error("Erro ao obter configurações do chat:", err);
    return res.status(500).json({ 
      error: "ERR_GET_CHAT_CONFIG",
      message: err.message || "Erro ao obter configurações do chat"
    });
  }
};

/**
 * Salva configurações do chat IA
 */
export const setChatConfig = async (
  req: Request,
  res: Response
): Promise<Response> => {
  try {
    const { companyId } = req.user;
    const { temperature, maxHistoryMessages, maxTokens, topP } = req.body;
    const { saveChatConfig } = await import("../services/AiServices/ChatConfigService");
    
    const config = await saveChatConfig(companyId, {
      temperature,
      maxHistoryMessages,
      maxTokens,
      topP
    });

    return res.status(200).json({
      success: true,
      config,
      message: "Configurações do chat salvas com sucesso"
    });
  } catch (err: any) {
    console.error("Erro ao salvar configurações do chat:", err);
    return res.status(400).json({ 
      error: "ERR_SET_CHAT_CONFIG",
      message: err.message || "Erro ao salvar configurações do chat"
    });
  }
};


