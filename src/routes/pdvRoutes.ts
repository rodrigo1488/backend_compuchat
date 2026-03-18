import express from "express";
import isAuth from "../middleware/isAuth";
import hasCompanyModule from "../middleware/hasCompanyModule";
import * as PdvController from "../controllers/PdvController";

const routes = express.Router();
const requireLanchonetes = hasCompanyModule("lanchonetes");

routes.post("/pdv/venda", isAuth, requireLanchonetes, PdvController.registrarVenda);

export default routes;
