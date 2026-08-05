import { Router } from "express";
import isPrintDeviceAuth from "../middleware/isPrintDeviceAuth";
import * as AgentProductController from "../controllers/AgentProductController";

const routes = Router();

routes.get(
  "/agent/products",
  isPrintDeviceAuth,
  AgentProductController.list
);

routes.post(
  "/agent/products/upsert",
  isPrintDeviceAuth,
  AgentProductController.upsert
);

routes.post(
  "/agent/products/attach-variation",
  isPrintDeviceAuth,
  AgentProductController.attachVariation
);

export default routes;
