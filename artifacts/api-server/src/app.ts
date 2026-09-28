import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttpImport from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errors";

/**
 * `pino-http` is a CommonJS module whose type definitions use `export =`
 * (a callable function with a namespace merged onto it).  Under some
 * TypeScript interop settings the imported binding is typed as the module
 * *namespace* rather than the callable factory, which produces:
 *
 *   TS2349: This expression is not callable.
 *
 * Casting through `unknown` to an explicit factory signature makes this file
 * compile under any interop configuration.  Runtime behaviour is unchanged:
 * esbuild resolves this import to `module.exports`, which is the factory
 * function itself — the same thing this code has always called.
 *
 * Note `pino` (used in ./lib/logger) does *not* need this treatment, as it
 * ships a real ES default export.
 */
interface PinoHttpRequest {
  id?: unknown;
  method?: string;
  url?: string;
}

interface PinoHttpResponse {
  statusCode?: number;
}

interface PinoHttpOptions {
  logger: typeof logger;
  serializers: {
    req(req: PinoHttpRequest): unknown;
    res(res: PinoHttpResponse): unknown;
  };
}

const pinoHttp = pinoHttpImport as unknown as (
  opts: PinoHttpOptions,
) => RequestHandler;

const app: Express = express();

app.disable("x-powered-by");
app.set("trust proxy", 1); // Railway terminates TLS in front of the API

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req: PinoHttpRequest) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: PinoHttpResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// The mobile app is not a browser; CORS only matters for the web build.
app.use(cors());
app.use(express.json({ limit: "512kb" }));

app.use("/api", router);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
