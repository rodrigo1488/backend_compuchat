import Appointment from "../../models/Appointment";
import { Op } from "sequelize";
import { getBrazilDayBounds, getBrazilISODateString } from "../../helpers/BrazilTimezone";

export interface AgendamentoStats {
  agendamentosHoje: number;
  agendamentosSemana: number;
  pendentesConfirmacao: number;
  concluidosHoje: number;
  noShowCount: number;
  porStatus: Array<{ status: string; quantidade: number }>;
  porProfissional?: Array<{ nome: string; quantidade: number }>;
}

interface Options {
  companyId: number;
  dateFrom?: Date;
  dateTo?: Date;
}

const AgendamentoStatsService = async (companyIdOrOptions: number | Options): Promise<AgendamentoStats> => {
  const companyId = typeof companyIdOrOptions === "number" ? companyIdOrOptions : companyIdOrOptions.companyId;
  const opts = typeof companyIdOrOptions === "object" ? companyIdOrOptions : { companyId };
  const now = new Date();
  const { startOfDay: dayStart, endOfDay: dayEnd } = getBrazilDayBounds(now);
  const todayStr = getBrazilISODateString(now);
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const baseWhere = { companyId };

  const [hoje, semana, pendentes, concluidosHoje, noShowCount, allStatus] = await Promise.all([
    Appointment.count({
      where: {
        ...baseWhere,
        startTime: { [Op.between]: [dayStart, dayEnd] } as any,
        status: { [Op.in]: ["pending", "confirmed", "completed"] },
      },
    }),
    Appointment.count({
      where: {
        ...baseWhere,
        startTime: { [Op.gte]: weekStart },
        status: { [Op.in]: ["pending", "confirmed", "completed"] },
      },
    }),
    Appointment.count({
      where: { ...baseWhere, status: "pending" },
    }),
    Appointment.count({
      where: {
        ...baseWhere,
        startTime: { [Op.between]: [dayStart, dayEnd] } as any,
        status: "completed",
      },
    }),
    Appointment.count({
      where: {
        ...baseWhere,
        status: "confirmed",
        startTime: { [Op.lt]: now },
      },
    }),
    Appointment.findAll({
      where: baseWhere,
      attributes: ["status", "assignedUserId"],
      include: [{ association: "assignedUser", attributes: ["name"], required: false }],
    }),
  ]);

  const statusCount: Record<string, number> = {};
  const profissionalCount: Record<string, number> = {};
  allStatus.forEach((a: any) => {
    statusCount[a.status] = (statusCount[a.status] || 0) + 1;
    const nome = a.assignedUser?.name?.trim() || "Sem nome";
    profissionalCount[nome] = (profissionalCount[nome] || 0) + 1;
  });

  const porStatus = Object.entries(statusCount).map(([status, quantidade]) => ({ status, quantidade }));
  const porProfissional = Object.entries(profissionalCount)
    .map(([nome, quantidade]) => ({ nome, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  return {
    agendamentosHoje: hoje,
    agendamentosSemana: semana,
    pendentesConfirmacao: pendentes,
    concluidosHoje: concluidosHoje,
    noShowCount,
    porStatus,
    porProfissional,
  };
};

export default AgendamentoStatsService;
