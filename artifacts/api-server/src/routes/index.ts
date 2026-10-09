import { Router, type IRouter } from "express";
import healthRouter from "./health";
import meRouter from "./me";
import vehiclesRouter from "./vehicles";
import journeysRouter from "./journeys";
import categoriesRouter from "./categories";
import locationsRouter from "./locations";
import uploadsRouter from "./uploads";
import socialRouter from "./social";
import convoysRouter from "./convoys";
import groupsRouter from "./groups";
import eventsRouter from "./events";
import notificationsRouter from "./notifications";
import presenceRouter from "./presence";
import liveLocationRouter from "./liveLocation";
import navigationRouter from "./navigation";

const router: IRouter = Router();

router.use(healthRouter);
router.use(meRouter);
router.use(vehiclesRouter);
router.use(journeysRouter);
router.use(categoriesRouter);
router.use(locationsRouter);
router.use(uploadsRouter);
router.use(socialRouter);
router.use(convoysRouter);
router.use(groupsRouter);
router.use(eventsRouter);
router.use(notificationsRouter);
router.use(presenceRouter);
router.use(liveLocationRouter);
router.use(navigationRouter);

export default router;
