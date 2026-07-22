import PrintPedido from "../../models/PrintPedido";
import FormResponse from "../../models/FormResponse";
import { logger } from "../../utils/logger";

interface Request {
  jobId: number;
  status: string;
  message?: string;
  companyId: number;
  deviceId: string;
  uniplusContaId?: number | null;
}

const HandlePrintJobAckService = async ({
  jobId,
  status,
  message,
  companyId,
  deviceId,
  uniplusContaId,
}: Request): Promise<void> => {
  const job = await PrintPedido.findOne({
    where: {
      id: jobId,
      companyId,
      deviceId,
      status: "printing",
    },
  });

  if (!job) {
    logger.warn(`Print job ack: job ${jobId} not found or not in printing state`);
    return;
  }

  if (status === "done") {
    const updates: Partial<PrintPedido> = {
      status: "done",
      printedAt: new Date(),
    };
    if (job.tipo === "uniplus" && uniplusContaId != null) {
      updates.uniplusContaId = Number(uniplusContaId);
    }
    await job.update(updates);
    logger.info(`Print job ${jobId} completed successfully (tipo=${job.tipo || "print"})`);

    if (job.tipo === "uniplus" && job.formResponseId && uniplusContaId != null) {
      try {
        const response = await FormResponse.findByPk(job.formResponseId);
        if (response) {
          const meta = {
            ...((response.metadata as Record<string, unknown>) || {}),
            uniplusContaId: Number(uniplusContaId),
            uniplusSyncedAt: new Date().toISOString(),
          };
          await response.update({ metadata: meta });
        }
      } catch (err: any) {
        logger.warn(
          `Print job ${jobId}: failed to update FormResponse metadata: ${err?.message}`
        );
      }
    }
  } else if (status === "error") {
    const tentativas = job.tentativas + 1;
    const newStatus = tentativas >= job.maxTentativas ? "error" : "pending";
    await job.update({
      status: newStatus,
      tentativas,
      errorMessage: message || "Print failed",
    });
    logger.info(
      `Print job ${jobId} failed (attempt ${tentativas}/${job.maxTentativas}): ${message || "unknown"}`
    );
  }
};

export default HandlePrintJobAckService;
