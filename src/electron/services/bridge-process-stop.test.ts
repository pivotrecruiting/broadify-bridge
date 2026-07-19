import { EventEmitter } from "events";
import { stopChildProcessGracefully } from "./bridge-process-stop.js";

class FakeChildProcess extends EventEmitter {
  public killCalls: NodeJS.Signals[] = [];
  private readonly emitOnSigterm: boolean;

  constructor(emitOnSigterm: boolean) {
    super();
    this.emitOnSigterm = emitOnSigterm;
  }

  kill(signal: NodeJS.Signals): void {
    this.killCalls.push(signal);
    if (signal === "SIGTERM" && this.emitOnSigterm) {
      setTimeout(() => {
        this.emit("exit");
      }, 0);
    }
  }
}

describe("stopChildProcessGracefully", () => {
  it("sends SIGTERM and resolves when process exits", async () => {
    const processRef = new FakeChildProcess(true);
    await expect(stopChildProcessGracefully(processRef, 100)).resolves.toBeUndefined();
    expect(processRef.killCalls).toEqual(["SIGTERM"]);
  });

  it("sends SIGKILL on timeout and resolves so shutdown continues", async () => {
    jest.useFakeTimers();
    const processRef = new FakeChildProcess(false);

    const stopPromise = stopChildProcessGracefully(processRef, 50);
    jest.advanceTimersByTime(50);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(processRef.killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    jest.useRealTimers();
  });
});
