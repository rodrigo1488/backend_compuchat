import GourmetFinanceiro from "../../models/GourmetFinanceiro";
import { getBrazilISODateString } from "../../helpers/BrazilTimezone";

interface RequestMesa {
  companyId: number;
  tipo: "mesa";
  valor: number;
  mesaId: number;
  mesaNumero?: string | null;
}

interface RequestDelivery {
  companyId: number;
  tipo: "delivery";
  valor: number;
  formResponseId: number;
  protocol?: string | null;
  entregadorUserId?: number | null;
  entregadorNome?: string | null;
}

type Request = RequestMesa | RequestDelivery;

const RegisterGourmetVendaService = async (data: Request): Promise<GourmetFinanceiro> => {
  const today = getBrazilISODateString(new Date());
  const payload: any = {
    companyId: data.companyId,
    tipo: data.tipo,
    valor: data.valor,
    dataVenda: today,
  };
  if (data.tipo === "mesa") {
    payload.mesaId = data.mesaId;
    payload.mesaNumero = data.mesaNumero ?? null;
    payload.formResponseId = null;
    payload.protocol = null;
    payload.entregadorUserId = null;
    payload.entregadorNome = null;
  } else {
    payload.mesaId = null;
    payload.mesaNumero = null;
    payload.formResponseId = data.formResponseId;
    payload.protocol = data.protocol ?? null;
    payload.entregadorUserId = data.entregadorUserId ?? null;
    payload.entregadorNome = data.entregadorNome ?? null;
  }
  const record = await GourmetFinanceiro.create(payload);
  return record;
};

export default RegisterGourmetVendaService;
