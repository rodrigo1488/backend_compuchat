import { Request, Response } from "express";
import DashboardDataService, { DashboardData, Params } from "../services/ReportService/DashbardDataService";
import DashboardExtendedService, { ExtendedParams } from "../services/ReportService/DashboardExtendedService";
import OrdersStatsService from "../services/ReportService/OrdersStatsService";
import LanchonetesStatsService from "../services/ReportService/LanchonetesStatsService";
import AgendamentoStatsService from "../services/ReportService/AgendamentoStatsService";
import { TicketsAttendance } from "../services/ReportService/TicketsAttendance";
import { TicketsDayService } from "../services/ReportService/TicketsDayService";
import DashboardFinancialService from "../services/ReportService/DashboardFinancialService";

type IndexQuery = {
  initialDate: string;
  finalDate: string;
};

export const index = async (req: Request, res: Response): Promise<Response> => {
  const params: Params = req.query;
  const { companyId } = req.user;
  let daysInterval = 3;

  const dashboardData: DashboardData = await DashboardDataService(
    companyId,
    params
  );
  return res.status(200).json(dashboardData);
};

export const reportsUsers = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { initialDate, finalDate } = req.query as IndexQuery;
  if (!initialDate || !finalDate) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const { data } = await TicketsAttendance({
      initialDate: from.toISOString().slice(0, 10),
      finalDate: to.toISOString().slice(0, 10),
      companyId,
    });
    return res.json({ data });
  }
  const { data } = await TicketsAttendance({ initialDate, finalDate, companyId });
  return res.json({ data });
}

export const reportsDay = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const { initialDate, finalDate } = req.query as IndexQuery;
  if (!initialDate || !finalDate) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const result = await TicketsDayService({
      initialDate: from.toISOString().slice(0, 10),
      finalDate: to.toISOString().slice(0, 10),
      companyId,
    });
    return res.json(result);
  }
  const { count, data } = await TicketsDayService({ initialDate, finalDate, companyId });
  return res.json({ count, data });
}

export const extended = async (req: Request, res: Response): Promise<Response> => {
  const params: ExtendedParams = req.query;
  const { companyId } = req.user;

  const extendedData = await DashboardExtendedService(companyId, params);

  return res.status(200).json(extendedData);
};

export const ordersStats = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const stats = await OrdersStatsService(companyId);
  return res.status(200).json(stats);
};

export const lanchonetesStats = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const stats = await LanchonetesStatsService(companyId);
  return res.status(200).json(stats);
};

export const agendamentoStats = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const stats = await AgendamentoStatsService(companyId);
  return res.status(200).json(stats);
};

export const financialSummary = async (req: Request, res: Response): Promise<Response> => {
  const { companyId } = req.user;
  const data = await DashboardFinancialService(companyId);
  return res.status(200).json(data);
};
