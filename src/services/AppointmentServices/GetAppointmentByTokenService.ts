import Appointment from "../../models/Appointment";
import Form from "../../models/Form";
import AppError from "../../errors/AppError";
import { verifyAppointmentToken } from "../../helpers/MesaLinkSign";

interface Request {
  token: string;
  formSlug: string;
}

const GetAppointmentByTokenService = async ({
  token,
  formSlug,
}: Request): Promise<{ appointment: Appointment; form: Form }> => {
  const decoded = verifyAppointmentToken(token);
  if (!decoded) {
    throw new AppError("Link inválido ou expirado", 404);
  }

  const form = await Form.findOne({
    where: { publicId: formSlug, isActive: true },
    attributes: ["id", "companyId", "name", "slug", "publicId", "settings"],
  });

  if (!form) {
    throw new AppError("ERR_FORM_NOT_FOUND", 404);
  }

  const appointment = await Appointment.findOne({
    where: { id: decoded.appointmentId, formId: form.id, companyId: form.companyId },
    include: [
      { association: "appointmentService", attributes: ["id", "name", "durationMinutes", "value"] },
      { association: "assignedUser", attributes: ["id", "name"] },
      { association: "form", attributes: ["id", "slug", "publicId"] },
    ],
  });

  if (!appointment) {
    throw new AppError("Agendamento não encontrado", 404);
  }

  if (["cancelled", "completed"].includes((appointment as any).status)) {
    throw new AppError("Este agendamento já foi cancelado ou concluído", 400);
  }

  return { appointment: appointment as Appointment, form: form as Form };
};

export default GetAppointmentByTokenService;
