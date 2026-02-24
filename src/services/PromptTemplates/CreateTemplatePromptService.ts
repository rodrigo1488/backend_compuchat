import * as Yup from "yup";
import AppError from "../../errors/AppError";
import Prompt from "../../models/Prompt";
import ShowPromptService from "../PromptServices/ShowPromptService";
import Setting from "../../models/Setting";
import { validateGeminiApiKey } from "../../config/gemini";
import { validateOpenAIApiKey } from "../../config/openai";
import { AGENT_TEMPLATES, processTemplate, AgentType, TemplateVariables } from "./TemplateDefinitions";
import Company from "../../models/Company";

interface CreateTemplatePromptData {
  tipoAgente: AgentType;
  companyId: string | number;
  model?: string;
  provider?: string;
  queueId?: number;
  maxMessages?: number;
  maxTokens?: number;
  temperature?: number;
  variables?: TemplateVariables;
  canSendInternalMessages?: boolean;
  canTransferToAgent?: boolean;
  canChangeTag?: boolean;
  permitirCriarAgendamentos?: boolean;
  businessHours?: any;
}

const CreateTemplatePromptService = async (
  promptData: CreateTemplatePromptData
): Promise<Prompt> => {
  // Garantir que companyId seja number
  const companyIdNumber = typeof promptData.companyId === "string"
    ? parseInt(promptData.companyId, 10)
    : promptData.companyId;

  if (isNaN(companyIdNumber)) {
    throw new AppError("companyId inválido", 400);
  }

  // Validar tipo de agente
  if (!AGENT_TEMPLATES[promptData.tipoAgente]) {
    throw new AppError(`Tipo de agente inválido: ${promptData.tipoAgente}`, 400);
  }

  const template = AGENT_TEMPLATES[promptData.tipoAgente];
  const provider = promptData.provider || "openai";

  // Buscar nome da empresa
  const company = await Company.findByPk(companyIdNumber);
  const companyName = company?.name || "";

  // Processar template com variáveis
  const variables: TemplateVariables = {
    ...template.defaultVariables,
    ...promptData.variables,
    nome_empresa: promptData.variables?.nome_empresa || companyName
  };

  const processedPrompt = processTemplate(template, variables, companyName);

  // Validar provider e API key
  if (provider === "gemini") {
    const geminiSetting = await Setting.findOne({
      where: {
        key: "geminiApiKey",
        companyId: companyIdNumber
      }
    });

    try {
      validateGeminiApiKey(geminiSetting?.value);
    } catch (err: any) {
      throw new AppError("Para usar Gemini, configure a API Key do Gemini em Configurações → Integrações → Chave da API do Gemini", 400);
    }
  } else if (provider === "openai") {
    const openaiSetting = await Setting.findOne({
      where: {
        key: "openaiApiKey",
        companyId: companyIdNumber
      }
    });

    try {
      validateOpenAIApiKey(openaiSetting?.value);
    } catch (err: any) {
      throw new AppError("Para usar OpenAI, configure a API Key do OpenAI em Configurações → Integrações → Chave da API do OpenAI", 400);
    }
  }

  // Definir modelo padrão
  const finalModel = promptData.model || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-3.5-turbo-1106");

  // Criar prompt a partir do template
  const promptToCreate: any = {
    name: variables.nome_agente || template.nome,
    prompt: processedPrompt,
    queueId: promptData.queueId || null,
    maxMessages: promptData.maxMessages || 10,
    maxTokens: promptData.maxTokens || 100,
    temperature: promptData.temperature || 1,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    model: finalModel,
    provider: provider,
    companyId: companyIdNumber,
    apiKey: "", // Sempre string vazia - será buscada das Settings
    tipoAgente: promptData.tipoAgente,
    isTemplate: true,
    templateVariables: JSON.stringify(variables),
    canSendInternalMessages: promptData.canSendInternalMessages !== undefined ? promptData.canSendInternalMessages : template.permissoes.canSendInternalMessages,
    canTransferToAgent: promptData.canTransferToAgent !== undefined ? promptData.canTransferToAgent : template.permissoes.canTransferToAgent,
    canChangeTag: promptData.canChangeTag !== undefined ? promptData.canChangeTag : template.permissoes.canChangeTag,
    permitirCriarAgendamentos: promptData.permitirCriarAgendamentos !== undefined ? promptData.permitirCriarAgendamentos : (template.permissoes.permitirCriarAgendamentos || false),
    businessHours: promptData.businessHours || null,
    transferQueueId: null
  };

  try {
    let promptTable = await Prompt.create(promptToCreate);
    promptTable = await ShowPromptService({ promptId: promptTable.id, companyId: companyIdNumber });
    return promptTable;
  } catch (err: any) {
    console.error("Erro ao criar prompt template:", {
      message: err.message,
      errors: err.errors,
      stack: err.stack
    });
    throw new AppError(`Erro ao criar prompt template: ${err.message || "Erro desconhecido"}`, 500);
  }
};

export default CreateTemplatePromptService;
