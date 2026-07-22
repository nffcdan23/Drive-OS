import { Router, type IRouter } from "express";
import healthRouter from "./health";
import usersRouter from "./users";
import vehiclesRouter from "./vehicles";
import journeysRouter from "./journeys";
import categoriesRouter from "./categories";
import communityRouter from "./community";
import notificationsRouter from "./notifications";

const router: IRouter = Router();

router.use(healthRouter);
router.use(usersRouter);
router.use(vehiclesRouter);
router.use(journeysRouter);
router.use(categoriesRouter);
router.use(communityRouter);
router.use(notificationsRouter);

export default router;
