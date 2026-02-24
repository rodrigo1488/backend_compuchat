import express from "express";
import isAuth from "../middleware/isAuth";
import validateAIApiKey from "../middleware/validateAIApiKey";
import * as AiSummaryController from "../controllers/AiSummaryController";
import * as ChatAIController from "../controllers/ChatAIController";
import * as CampaignAIController from "../controllers/CampaignAIController";

const routes = express.Router();

// Rotas de teste da API key não precisam de validação (elas mesmas validam)
routes.get("/ai/test-key", isAuth, AiSummaryController.testApiKey);

// Rotas de configuração de providers
routes.get("/ai/providers/config", isAuth, AiSummaryController.getProviderConfigurations);
routes.post("/ai/providers/config", isAuth, AiSummaryController.setProviderConfiguration);

// Rotas de configuração do chat IA
routes.get("/ai/chat/config", isAuth, AiSummaryController.getChatConfig);
routes.post("/ai/chat/config", isAuth, AiSummaryController.setChatConfig);

// Todas as outras rotas de IA precisam validar a API key antes de acessar (agora genérico - Gemini ou OpenAI)
routes.post("/ai/summary/agent", isAuth, validateAIApiKey, AiSummaryController.agentSummary);
routes.post("/ai/chat", isAuth, validateAIApiKey, AiSummaryController.chat);

// Rotas para IA no chat
routes.post("/chat-ai/analyze", isAuth, validateAIApiKey, ChatAIController.analyze);
routes.post("/chat-ai/audio-summary", isAuth, validateAIApiKey, ChatAIController.audioSummary);
routes.post("/chat-ai/improve", isAuth, validateAIApiKey, ChatAIController.improve);
routes.post("/chat-ai/transcribe/:messageId", isAuth, validateAIApiKey, ChatAIController.transcribe);
routes.post("/chat-ai/generate-ticket", isAuth, validateAIApiKey, ChatAIController.generateTicket);

// Rotas para IA em campanhas
routes.post("/ai/campaign/initial", isAuth, validateAIApiKey, CampaignAIController.generateCampaignInitialMessage);
routes.post("/ai/campaign/variations", isAuth, validateAIApiKey, CampaignAIController.generateCampaignVariations);

export default routes;


