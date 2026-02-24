import express from "express";
import * as MercadoPagoController from "../controllers/MercadoPagoController";

const mercadoPagoRoutes = express.Router();

// Criar intenção de pagamento
mercadoPagoRoutes.post(
  "/mercadopago/create-payment-intent",
  MercadoPagoController.createPaymentIntentController
);

// Webhook do Mercado Pago
mercadoPagoRoutes.post(
  "/mercadopago/webhook",
  MercadoPagoController.webhookController
);

// Consultar status do pagamento
mercadoPagoRoutes.get(
  "/mercadopago/payment-status/:paymentId",
  MercadoPagoController.getPaymentStatusController
);

// Consultar status da preferência (para verificar pagamentos PIX)
mercadoPagoRoutes.get(
  "/mercadopago/preference-status/:preferenceId",
  MercadoPagoController.getPreferenceStatusController
);

mercadoPagoRoutes.get(
  "/diagnostic/mercadopago",
  MercadoPagoController.getMercadoPagoDiagnostic
);

export default mercadoPagoRoutes;

