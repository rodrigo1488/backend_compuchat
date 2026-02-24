import PrintPedido from "../../models/PrintPedido";
import { logger } from "../../utils/logger";

interface Request {
  jobId: number;
  status: string;
  message?: string;
  companyId: number;
  deviceId: string;
}

const HandlePrintJobAckService = async ({
  jobId,
  status,
  message,
  companyId,
  deviceId
}: Request): Promise<void> => {
  const job = await PrintPedido.findOne({
    where: {
      id: jobId,
      companyId,
      deviceId,
      status: "printing"
    }
  });

  if (!job) {
    logger.warn(`Print job ack: job ${jobId} not found or not in printing state`);
    return;
  }

  if (status === "done") {
    await job.update({
      status: "done",
      printedAt: new Date()
    });
    logger.info(`Print job ${jobId} completed successfully`);
  } else if (status === "error") {
    const tentativas = job.tentativas + 1;
    const newStatus =
      tentativas >= job.maxTentativas ? "error" : "pending";
    await job.update({
      status: newStatus,
      tentativas,
      errorMessage: message || "Print failed"
    });
    logger.info(
      `Print job ${jobId} failed (attempt ${tentativas}/${job.maxTentativas}): ${message || "unknown"}`
    );
  }
};

export default HandlePrintJobAckService;
