import gracefulShutdown from "http-graceful-shutdown";
import app from "./app";
import { initIO } from "./libs/socket";
import { initPrintWebSocket } from "./libs/printWebSocket";
import { logger } from "./utils/logger";
import { StartAllWhatsAppsSessions } from "./services/WbotServices/StartAllWhatsAppsSessions";
import Company from "./models/Company";
import { startQueueProcess } from "./queues";
import { TransferTicketQueue } from "./wbotTransferTicketQueue";
import cron from "node-cron";
import TestAllGeminiApiKeysService from "./services/AiServices/TestAllGeminiApiKeysService";
import RenewSubscriptionService, { findCompaniesNeedingRenewal } from "./services/SubscriptionService/RenewSubscriptionService";
import CheckRemindersService from "./services/ReminderServices/CheckRemindersService";
import CheckAgendamentoRemindersService from "./services/AppointmentServices/CheckAgendamentoRemindersService";
import CheckWaitlistAndNotifyService from "./services/AppointmentServices/CheckWaitlistAndNotifyService";
import CheckOrderAutoConfirmService from "./services/OrderServices/CheckOrderAutoConfirmService";
import CloseStuckTicketsFromDisconnectedWhatsAppService from "./services/TicketServices/CloseStuckTicketsFromDisconnectedWhatsAppService";
import AutoLiberarMesasService from "./services/MesaServices/AutoLiberarMesasService";
import { Op } from "sequelize";
import PrintPedido from "./models/PrintPedido";
import FormResponse from "./models/FormResponse";

const server = app.listen(process.env.PORT, async () => {
  const companies = await Company.findAll();
  const allPromises: any[] = [];
  companies.map(async c => {
    const promise = StartAllWhatsAppsSessions(c.id);
    allPromises.push(promise);
  });

  Promise.all(allPromises).then(() => {
    startQueueProcess();
  });
  
  // Testar chaves da API do Gemini após inicialização
  setTimeout(async () => {
    await TestAllGeminiApiKeysService();
  }, 5000); // Aguardar 5 segundos após o servidor iniciar

  // Fechar tickets travados por conexões WhatsApp desconectadas ou excluídas
  setTimeout(async () => {
    try {
      const result = await CloseStuckTicketsFromDisconnectedWhatsAppService();
      if (result.total > 0) {
        logger.info(`Inicialização: ${result.total} ticket(s) travado(s) foram fechados.`);
      }
    } catch (err: any) {
      logger.error("Erro ao fechar tickets travados na inicialização:", err);
    }
  }, 3000);

  logger.info(`Server started on port: ${process.env.PORT}`);
});

cron.schedule("* * * * *", async () => {

  try {
    // console.log("Running a job at 01:00 at America/Sao_Paulo timezone")
    logger.info(`Serviço de transferencia de tickets iniciado`);

    await TransferTicketQueue();
  }
  catch (error) {
    logger.error(error);
  }

});

// Job para verificar e processar renovações de assinaturas
// Roda diariamente às 9h da manhã
cron.schedule("0 9 * * *", async () => {
  try {
    logger.info("Iniciando verificação de renovações de assinaturas...");
    
    const companiesNeedingRenewal = await findCompaniesNeedingRenewal();
    
    logger.info(`Encontradas ${companiesNeedingRenewal.length} empresas que precisam de renovação`);
    
    for (const company of companiesNeedingRenewal) {
      try {
        const result = await RenewSubscriptionService(company.id);
        
        if (result.success) {
          logger.info(`Renovação processada com sucesso para empresa ${company.id} via ${result.method}`);
        } else {
          logger.warn(`Falha ao renovar empresa ${company.id}: ${result.message || result.error}`);
        }
      } catch (error: any) {
        logger.error(`Erro ao processar renovação para empresa ${company.id}:`, error);
        // Continuar com as próximas empresas mesmo se uma falhar
      }
    }
    
    logger.info("Verificação de renovações concluída");
  } catch (error: any) {
    logger.error("Erro no job de renovação de assinaturas:", error);
  }
});

// Job para verificar e enviar lembretes de agendamentos e tarefas
// Roda a cada 1 minuto
cron.schedule("* * * * *", async () => {
  try {
    await CheckRemindersService();
  } catch (error: any) {
    logger.error("Erro ao processar lembretes:", error);
  }
});

// Job para lembretes de agendamento (formulário público) — reminderHours por form
cron.schedule("* * * * *", async () => {
  try {
    await CheckAgendamentoRemindersService();
  } catch (error: any) {
    logger.error("Erro ao processar lembretes de agendamento:", error);
  }
});

// Job para lista de espera: verificar vagas e notificar por WhatsApp
cron.schedule("* * * * *", async () => {
  try {
    await CheckWaitlistAndNotifyService();
  } catch (error: any) {
    logger.error("Erro ao processar lista de espera:", error);
  }
});

// Job para avançar pedidos novo -> confirmado automaticamente
cron.schedule("* * * * *", async () => {
  try {
    await CheckOrderAutoConfirmService();
  } catch (error: any) {
    logger.error("Erro no job de auto-confirmação de pedidos:", error);
  }
});

// Job para reverter jobs de impressão travados (printing há mais de 5 min)
cron.schedule("* * * * *", async () => {
  try {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const [affected] = await PrintPedido.update(
      { status: "pending" },
      {
        where: {
          status: "printing",
          updatedAt: { [Op.lt]: fiveMinAgo }
        }
      }
    );
    if (affected > 0) {
      logger.info(`Reverted ${affected} stuck print job(s) to pending`);
    }
  } catch (error: any) {
    logger.error("Erro ao reverter jobs de impressão travados:", error);
  }
});

// Cleanup de jobs expirados (done/error com mais de 24h)
cron.schedule("0 2 * * *", async () => {
  try {
    const result = await PrintPedido.destroy({
      where: {
        status: { [Op.in]: ["done", "error"] },
        expiresAt: { [Op.lt]: new Date() }
      }
    });
    if (result > 0) {
      logger.info(`Cleaned up ${result} expired print job(s)`);
    }
  } catch (error: any) {
    logger.error("Erro no cleanup de jobs de impressão:", error);
  }
});

// Cleanup de respostas/pedidos de formulário com mais de 24h
cron.schedule("0 3 * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const result = await FormResponse.destroy({
      where: { submittedAt: { [Op.lt]: cutoff } }
    });
    if (result > 0) {
      logger.info(`Removidas ${result} resposta(s) de formulário com mais de 24h`);
    }
  } catch (error: any) {
    logger.error("Erro no cleanup de respostas de formulário:", error);
  }
});

// Fechar tickets travados por conexão WhatsApp desconectada ou excluída — diariamente às 00:00
cron.schedule("0 0 * * *", async () => {
  try {
    logger.info("Iniciando verificação diária de tickets travados (conexões desconectadas/excluídas)...");
    const result = await CloseStuckTicketsFromDisconnectedWhatsAppService();
    if (result.total > 0) {
      logger.info(`Verificação diária: ${result.total} ticket(s) travado(s) foram fechados.`);
    } else {
      logger.info("Verificação diária de tickets travados concluída (nenhum ticket para fechar).");
    }
  } catch (error: any) {
    logger.error("Erro no job de fechamento de tickets travados:", error);
  }
});

// Job para liberar automaticamente mesas/comandas ocupadas há mais de 24 horas
// Roda a cada hora
cron.schedule("0 * * * *", async () => {
  try {
    logger.info("Iniciando verificação de mesas ocupadas há mais de 24 horas...");
    const result = await AutoLiberarMesasService();
    if (result.total > 0) {
      logger.info(`Liberação automática: ${result.total} mesa(s) liberada(s) automaticamente após 24 horas.`);
    } else {
      logger.info("Verificação de mesas concluída (nenhuma mesa para liberar).");
    }
  } catch (error: any) {
    logger.error("Erro no job de liberação automática de mesas:", error);
  }
});

initIO(server);
initPrintWebSocket(server);
gracefulShutdown(server);
