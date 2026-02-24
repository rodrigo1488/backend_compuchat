import * as Yup from "yup";
import AppError from "../../errors/AppError";
import Prompt from "../../models/Prompt";
import ShowPromptService from "./ShowPromptService";
import Setting from "../../models/Setting";
import { validateGeminiApiKey } from "../../config/gemini";
import { validateOpenAIApiKey } from "../../config/openai";

interface PromptData {
    id?: number;
    name: string;
    apiKey?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    queueId?: number;
    maxMessages?: number;
    companyId: string | number;
    model: string;
    provider?: string;
    canSendInternalMessages?: boolean;
    canTransferToAgent?: boolean;
    canChangeTag?: boolean;
    permitirCriarAgendamentos?: boolean;
    tipoAgente?: string;
    isTemplate?: boolean;
    templateVariables?: string;
    transferQueueId?: number | null;
    businessHours?: any;
}

interface Request {
    promptData: PromptData;
    promptId: string | number;
    companyId: string | number;
}

const UpdatePromptService = async ({
    promptId,
    promptData,
    companyId
}: Request): Promise<Prompt | undefined> => {
    const promptTable = await ShowPromptService({ promptId: promptId, companyId });

    const provider = promptData.provider || promptTable.provider || "openai";

    // Validação baseada no provider (queueId agora é opcional)
    const promptSchema = Yup.object().shape({
        name: Yup.string().required("ERR_PROMPT_NAME_INVALID"),
        prompt: Yup.string().required("ERR_PROMPT_PROMPT_INVALID"),
        queueId: Yup.number().nullable(),
        maxMessages: Yup.number().required("ERR_PROMPT_MAX_MESSAGES_INVALID"),
        provider: Yup.string().oneOf(["openai", "gemini"], "ERR_PROMPT_PROVIDER_INVALID")
    });

    // Não exigir apiKey no prompt - será buscada das Settings
    const { name, prompt, maxTokens, temperature, promptTokens, completionTokens, totalTokens, queueId, maxMessages, model, canSendInternalMessages, canTransferToAgent, canChangeTag, permitirCriarAgendamentos, tipoAgente, isTemplate, templateVariables, transferQueueId, businessHours } = promptData;

    try {
        await promptSchema.validate({ name, prompt, maxTokens, temperature, promptTokens, completionTokens, totalTokens, queueId, maxMessages, provider });
    } catch (err) {
        throw new AppError(`${JSON.stringify(err, undefined, 2)}`);
    }

    // Validar que a API key está nas Settings (tanto para Gemini quanto OpenAI)
    if (provider === "gemini") {
        const geminiSetting = await Setting.findOne({
            where: {
                key: "geminiApiKey",
                companyId
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
                companyId
            }
        });

        try {
            validateOpenAIApiKey(openaiSetting?.value);
        } catch (err: any) {
            throw new AppError("Para usar OpenAI, configure a API Key do OpenAI em Configurações → Integrações → Chave da API do OpenAI", 400);
        }
    }

    // Garantir que provider tenha valor e modelo tenha valor default se não fornecido
    const finalModel = model || (provider === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini");

    const updateData: any = {
        name,
        prompt,
        maxTokens,
        temperature,
        promptTokens,
        completionTokens,
        totalTokens,
        queueId,
        maxMessages,
        model: finalModel,
        provider,
        canSendInternalMessages: canSendInternalMessages !== undefined ? canSendInternalMessages : false,
        canTransferToAgent: canTransferToAgent !== undefined ? canTransferToAgent : false,
        canChangeTag: canChangeTag !== undefined ? canChangeTag : false,
        permitirCriarAgendamentos: permitirCriarAgendamentos !== undefined ? permitirCriarAgendamentos : false,
        tipoAgente: tipoAgente !== undefined ? tipoAgente : promptTable.tipoAgente || "personalizado",
        isTemplate: isTemplate !== undefined ? isTemplate : promptTable.isTemplate || false,
        templateVariables: templateVariables !== undefined ? templateVariables : promptTable.templateVariables,
        transferQueueId: transferQueueId || null,
        businessHours: businessHours !== undefined ? businessHours : promptTable.businessHours,
        // Sempre definir apiKey como string vazia - será buscada das Settings
        apiKey: ""
    };

    await promptTable.update(updateData);
    await promptTable.reload();
    return promptTable;
};

export default UpdatePromptService;
