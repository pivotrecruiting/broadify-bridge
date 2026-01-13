import util from "node:util";

type LoggerTarget = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

function formatConsoleArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  return util.inspect(value, { depth: 4, breakLength: 120 });
}

function formatConsoleArgs(args: unknown[]): string {
  return args.map(formatConsoleArg).join(" ");
}

/**
 * Redirect console output into the bridge pino logger.
 */
export function bindConsoleToLogger(logger: LoggerTarget): void {
  console.log = (...args) => logger.info(formatConsoleArgs(args));
  console.info = (...args) => logger.info(formatConsoleArgs(args));
  console.warn = (...args) => logger.warn(formatConsoleArgs(args));
  console.error = (...args) => logger.error(formatConsoleArgs(args));
  console.debug = (...args) =>
    (logger.debug || logger.info)(formatConsoleArgs(args));
}
