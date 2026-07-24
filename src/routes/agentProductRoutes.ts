import { Router } from "express";
import isPrintDeviceAuth from "../middleware/isPrintDeviceAuth";
import * as AgentProductController from "../controllers/AgentProductController";

const routes = Router();

routes.post(
  "/agent/products/upsert",
  isPrintDeviceAuth,
  AgentProductController.upsert
);

export default routes;
