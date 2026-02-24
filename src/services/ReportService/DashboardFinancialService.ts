import Company from "../../models/Company";
import Plan from "../../models/Plan";
import Invoices from "../../models/Invoices";
export interface DashboardFinancialData {
  planName: string;
  planValue: number | null;
  dueDate: string | null;
  status: "active" | "expired" | "unknown";
  autoRenew: boolean;
  lastInvoice: { dueDate: string; status: string; value: number } | null;
}

const DashboardFinancialService = async (companyId: number): Promise<DashboardFinancialData> => {
  const company = await Company.findOne({
    where: { id: companyId },
    include: [{ model: Plan, as: "plan", attributes: ["id", "name", "value"] }],
    attributes: ["id", "dueDate", "autoRenew", "planId"],
  });

  if (!company) {
    return {
      planName: "—",
      planValue: null,
      dueDate: null,
      status: "unknown",
      autoRenew: false,
      lastInvoice: null,
    };
  }

  const plan = (company as any).plan;
  const planName = plan?.name || "—";
  const planValue = plan?.value ?? null;
  const dueDate = (company as any).dueDate || null;
  const autoRenew = Boolean((company as any).autoRenew);

  let status: "active" | "expired" | "unknown" = "unknown";
  if (dueDate) {
    const due = new Date(dueDate);
    due.setHours(23, 59, 59, 999);
    status = due >= new Date() ? "active" : "expired";
  }

  const lastInvoice = await Invoices.findOne({
    where: { companyId },
    order: [["dueDate", "DESC"]],
    attributes: ["dueDate", "status", "value"],
  });

  return {
    planName,
    planValue,
    dueDate,
    status,
    autoRenew,
    lastInvoice: lastInvoice
      ? {
          dueDate: (lastInvoice as any).dueDate,
          status: (lastInvoice as any).status,
          value: (lastInvoice as any).value ?? 0,
        }
      : null,
  };
};

export default DashboardFinancialService;
