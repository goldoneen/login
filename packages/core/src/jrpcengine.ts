import { JRPCEngineEndCallback, JRPCEngineNextCallback, JRPCRequest, JRPCResponse, JsonRpcEngineReturnHandler } from "./jrpc";
import SafeEventEmitter from "./safeEventEmitter";
import SerializableError from "./serializableError";
import { serializeError } from "./utils";

/**
 * An identifier established by the Client that MUST contain a String, Number,
 * or NULL value if included. If it is not included it is assumed to be a
 * notification. The value SHOULD normally not be Null and Numbers SHOULD
 * NOT contain fractional parts.
 */
export type JsonRpcId = number | string | void;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

export type JRPCMiddleware<T, U> = (req: JRPCRequest<T>, res: JRPCResponse<U>, next: JRPCEngineNextCallback, end: JRPCEngineEndCallback) => void;

/**
 * A JSON-RPC request and response processor.
 * Give it a stack of middleware, pass it requests, and get back responses.
 */
export class JsonRpcEngine extends SafeEventEmitter {
  private _middleware: JRPCMiddleware<unknown, unknown>[];

  constructor() {
    super();
    this._middleware = [];
  }

  /**
   * Add a middleware function to the engine's middleware stack.
   *
   * @param middleware - The middleware function to add.
   */
  push<T, U>(middleware: JRPCMiddleware<T, U>): void {
    this._middleware.push(middleware as JRPCMiddleware<unknown, unknown>);
  }

  /**
   * Handle a JSON-RPC request, and return a response.
   *
   * @param request - The request to handle.
   * @param callback - An error-first callback that will receive the response.
   */
  handle<T, U>(request: JRPCRequest<T>, callback: (error: unknown, response: JRPCResponse<U>) => void): void;

  /**
   * Handle an array of JSON-RPC requests, and return an array of responses.
   *
   * @param request - The requests to handle.
   * @param callback - An error-first callback that will receive the array of
   * responses.
   */
  handle<T, U>(requests: JRPCRequest<T>[], callback: (error: unknown, responses: JRPCResponse<U>[]) => void): void;

  /**
   * Handle a JSON-RPC request, and return a response.
   *
   * @param request - The request to handle.
   * @returns A promise that resolves with the response, or rejects with an
   * error.
   */
  handle<T, U>(request: JRPCRequest<T>): Promise<JRPCResponse<U>>;

  /**
   * Handle an array of JSON-RPC requests, and return an array of responses.
   *
   * @param request - The requests to handle.
   * @returns A promise that resolves with the array of responses, or rejects
   * with an error.
   */
  handle<T, U>(requests: JRPCRequest<T>[]): Promise<JRPCResponse<U>[]>;

  handle(req: unknown, cb?: any) {
    if (cb && typeof cb !== "function") {
      throw new Error('"callback" must be a function if provided.');
    }

    if (Array.isArray(req)) {
      if (cb) {
        return this._handleBatch(req, cb);
      }
      return this._handleBatch(req);
    }

    if (cb) {
      return this._handle(req as JRPCRequest<unknown>, cb);
    }
    return this._promiseHandle(req as JRPCRequest<unknown>);
  }

  /**
   * Returns this engine as a middleware function that can be pushed to other
   * engines.
   *
   * @returns This engine as a middleware function.
   */
  asMiddleware(): JRPCMiddleware<unknown, unknown> {
    return async (req, res, next, end) => {
      try {
        const [middlewareError, isComplete, returnHandlers] = await JsonRpcEngine._runAllMiddleware(req, res, this._middleware);

        if (isComplete) {
          await JsonRpcEngine._runReturnHandlers(returnHandlers);
          return end(middlewareError as Error);
        }

        return next(async (handlerCallback) => {
          try {
            await JsonRpcEngine._runReturnHandlers(returnHandlers);
          } catch (error) {
            return handlerCallback(error);
          }
          return handlerCallback();
        });
      } catch (error) {
        return end(error);
      }
    };
  }

  /**
   * Like _handle, but for batch requests.
   */
  private _handleBatch(reqs: JRPCRequest<unknown>[]): Promise<JRPCResponse<unknown>[]>;

  /**
   * Like _handle, but for batch requests.
   */
  private _handleBatch(reqs: JRPCRequest<unknown>[], cb: (error: unknown, responses?: JRPCResponse<unknown>[]) => void): Promise<void>;

  private async _handleBatch(
    reqs: JRPCRequest<unknown>[],
    cb?: (error: unknown, responses?: JRPCResponse<unknown>[]) => void
  ): Promise<JRPCResponse<unknown>[] | void> {
    // The order here is important
    try {
      // 2. Wait for all requests to finish, or throw on some kind of fatal
      // error
      const responses = await Promise.all(
        // 1. Begin executing each request in the order received
        reqs.map(this._promiseHandle.bind(this))
      );

      // 3. Return batch response
      if (cb) {
        return cb(null, responses);
      }
      return responses;
    } catch (error) {
      if (cb) {
        return cb(error);
      }

      throw error;
    }
  }

  /**
   * A promise-wrapped _handle.
   */
  private _promiseHandle(req: JRPCRequest<unknown>): Promise<JRPCResponse<unknown>> {
    return new Promise((resolve) => {
      this._handle(req, (_err, res) => {
        // There will always be a response, and it will always have any error
        // that is caught and propagated.
        resolve(res);
      });
    });
  }

  /**
   * Ensures that the request object is valid, processes it, and passes any
   * error and the response object to the given callback.
   *
   * Does not reject.
   */
  private async _handle(callerReq: JRPCRequest<unknown>, cb: (error: unknown, response: JRPCResponse<unknown>) => void): Promise<void> {
    if (!callerReq || Array.isArray(callerReq) || typeof callerReq !== "object") {
      const error = new SerializableError({ message: "request must be plain object" });
      return cb(error, { id: undefined, jsonrpc: "2.0", error });
    }

    if (typeof callerReq.method !== "string") {
      const error = new SerializableError({ message: "method must be string" });
      return cb(error, { id: callerReq.id, jsonrpc: "2.0", error });
    }

    const req: JRPCRequest<unknown> = { ...callerReq };
    const res: JRPCResponse<unknown> = {
      id: req.id,
      jsonrpc: req.jsonrpc,
    };
    let error: Error = null;

    try {
      await this._processRequest(req, res);
    } catch (_error) {
      // A request handler error, a re-thrown middleware error, or something
      // unexpected.
      error = _error;
    }

    if (error) {
      // Ensure no result is present on an errored response
      delete res.result;
      if (!res.error) {
        res.error = serializeError(error);
      }
    }

    return cb(error, res as JRPCResponse<unknown>);
  }

  /**
   * For the given request and response, runs all middleware and their return
   * handlers, if any, and ensures that internal request processing semantics
   * are satisfied.
   */
  private async _processRequest(req: JRPCRequest<unknown>, res: JRPCResponse<unknown>): Promise<void> {
    const [error, isComplete, returnHandlers] = await JsonRpcEngine._runAllMiddleware(req, res, this._middleware);

    // Throw if "end" was not called, or if the response has neither a result
    // nor an error.
    JsonRpcEngine._checkForCompletion(req, res, isComplete);

    // The return handlers should run even if an error was encountered during
    // middleware processing.
    await JsonRpcEngine._runReturnHandlers(returnHandlers);

    // Now we re-throw the middleware processing error, if any, to catch it
    // further up the call chain.
    if (error) {
      throw error;
    }
  }

  /**
   * Serially executes the given stack of middleware.
   *
   * @returns An array of any error encountered during middleware execution,
   * a boolean indicating whether the request was completed, and an array of
   * middleware-defined return handlers.
   */
  private static async _runAllMiddleware(
    req: JRPCRequest<unknown>,
    res: JRPCResponse<unknown>,
    middlewareStack: JRPCMiddleware<unknown, unknown>[]
  ): Promise<
    [
      unknown, // error
      boolean, // isComplete
      JsonRpcEngineReturnHandler[]
    ]
  > {
    const returnHandlers: JsonRpcEngineReturnHandler[] = [];
    let error = null;
    let isComplete = false;

    // Go down stack of middleware, call and collect optional returnHandlers
    for (const middleware of middlewareStack) {
      // eslint-disable-next-line no-await-in-loop
      [error, isComplete] = await JsonRpcEngine._runMiddleware(req, res, middleware, returnHandlers);
      if (isComplete) {
        break;
      }
    }
    return [error, isComplete, returnHandlers.reverse()];
  }

  /**
   * Runs an individual middleware.
   *
   * @returns An array of any error encountered during middleware exection,
   * and a boolean indicating whether the request should end.
   */
  private static _runMiddleware(
    req: JRPCRequest<unknown>,
    res: JRPCResponse<unknown>,
    middleware: JRPCMiddleware<unknown, unknown>,
    returnHandlers: JsonRpcEngineReturnHandler[]
  ): Promise<[unknown, boolean]> {
    return new Promise((resolve) => {
      const end: JRPCEngineEndCallback = (err?: unknown) => {
        const error = err || res.error;
        if (error) {
          res.error = serializeError(error);
        }
        // True indicates that the request should end
        resolve([error, true]);
      };

      const next: JRPCEngineNextCallback = (returnHandler?: JsonRpcEngineReturnHandler) => {
        if (res.error) {
          end(res.error);
        } else {
          if (returnHandler) {
            if (typeof returnHandler !== "function") {
              end(new SerializableError({ message: "JsonRpcEngine: 'next' return handlers must be functions" }));
            }
            returnHandlers.push(returnHandler);
          }

          // False indicates that the request should not end
          resolve([null, false]);
        }
      };

      try {
        middleware(req, res, next, end);
      } catch (error) {
        end(error);
      }
    });
  }

  /**
   * Serially executes array of return handlers. The request and response are
   * assumed to be in their scope.
   */
  private static async _runReturnHandlers(handlers: JsonRpcEngineReturnHandler[]): Promise<void> {
    for (const handler of handlers) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve, reject) => {
        handler((err) => (err ? reject(err) : resolve()));
      });
    }
  }

  /**
   * Throws an error if the response has neither a result nor an error, or if
   * the "isComplete" flag is falsy.
   */
  private static _checkForCompletion(req: JRPCRequest<unknown>, res: JRPCResponse<unknown>, isComplete: boolean): void {
    if (!("result" in res) && !("error" in res)) {
      throw new SerializableError({ message: "Response has no error or result for request" });
    }
    if (!isComplete) {
      throw new SerializableError({ message: "Nothing ended request" });
    }
  }
}
