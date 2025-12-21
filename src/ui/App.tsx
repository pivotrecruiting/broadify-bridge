import { useState, useEffect } from "react";
import { Settings } from "lucide-react";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import logo from "./assets/logo.svg";
import type { BridgeStatus } from "types";

import "./styles/App.css";

function App() {
  const [networkLan, setNetworkLan] = useState("0.0.0.0");
  const [networkPort, setNetworkPort] = useState<string>("8000");
  const [engineAtem, setEngineAtem] = useState("ATEM 192.168.1.1");
  const [enginePort, setEnginePort] = useState("9091");
  const [outputUsk, setOutputUsk] = useState("HDMI Decklink Card");
  const [outputDsk, setOutputDsk] = useState("SDI");
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({
    running: false,
    reachable: false,
  });
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [portAvailability, setPortAvailability] = useState<
    Map<number, boolean>
  >(new Map());
  const [checkingPorts, setCheckingPorts] = useState(false);

  // Subscribe to bridge status updates
  useEffect(() => {
    if (!window.electron) return;

    // Get initial status
    window.electron.bridgeGetStatus().then(setBridgeStatus);

    // Subscribe to status updates
    const unsubscribe = window.electron.subscribeBridgeStatus((status) => {
      setBridgeStatus(status);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // Check port availability on mount and when port changes
  useEffect(() => {
    if (!window.electron) return;

    const checkPorts = async () => {
      // Don't check ports while bridge is running (would show our own bridge as "in use")
      if (bridgeStatus.running) {
        console.log("[PortCheck] Skipping port check - bridge is running");
        return;
      }

      setCheckingPorts(true);
      try {
        const ports = [8000, 8080, 3000, 5000, 9000];
        console.log("[PortCheck] Checking ports:", ports, "on", networkLan);
        const results = await window.electron.checkPortsAvailability(
          ports,
          networkLan
        );
        console.log("[PortCheck] Results:", results);
        const availabilityMap = new Map<number, boolean>();
        results.forEach((result) => {
          availabilityMap.set(result.port, result.available);
        });
        setPortAvailability(availabilityMap);

        // Check if currently selected port is available on new IP
        // This ensures that when IP changes, if the selected port is not available, it gets reset
        if (networkPort && networkPort.trim() !== "") {
          const currentPort = parseInt(networkPort, 10);
          if (!isNaN(currentPort)) {
            const portAvailable = availabilityMap.get(currentPort);
            if (portAvailable === false) {
              console.log(
                `[PortCheck] Port ${currentPort} not available on ${networkLan}, resetting selection`
              );
              setNetworkPort("");
            }
          }
        }
      } catch (error) {
        console.error("Error checking port availability:", error);
      } finally {
        setCheckingPorts(false);
      }
    };

    // Initial check
    checkPorts();

    // Re-check when network config changes (with debounce)
    const timeoutId = setTimeout(checkPorts, 500);
    return () => clearTimeout(timeoutId);
  }, [networkLan, bridgeStatus.running]);

  const handleLetsGo = async () => {
    if (!window.electron) return;

    // Validate port is selected
    if (!networkPort || networkPort.trim() === "") {
      alert("Bitte wählen Sie einen Port aus.");
      return;
    }

    const port = parseInt(networkPort, 10);
    if (isNaN(port)) {
      alert("Ungültiger Port. Bitte wählen Sie einen gültigen Port aus.");
      return;
    }

    setIsStarting(true);
    try {
      const result = await window.electron.bridgeStart({
        host: networkLan,
        port: port,
      });

      if (!result.success) {
        console.error("Failed to start bridge:", result.error);
        alert(`Failed to start bridge: ${result.error || "Unknown error"}`);
      } else {
        // If port was changed automatically, update UI
        if (
          result.actualPort &&
          result.actualPort !== parseInt(networkPort, 10)
        ) {
          setNetworkPort(result.actualPort.toString());
          alert(
            `Port ${networkPort} was not available. Bridge started on port ${result.actualPort} instead.`
          );
        }
        console.log("Lets Go!", {
          network: { lan: networkLan, port: result.actualPort || networkPort },
          engine: { atem: engineAtem, port: enginePort },
          outputs: { usk: outputUsk, dsk: outputDsk },
        });
      }
    } catch (error) {
      console.error("Error starting bridge:", error);
      alert(
        `Error starting bridge: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopServer = async () => {
    if (!window.electron) return;

    setIsStopping(true);
    try {
      const result = await window.electron.bridgeStop();

      if (!result.success) {
        console.error("Failed to stop bridge:", result.error);
        alert(`Failed to stop bridge: ${result.error || "Unknown error"}`);
      } else {
        // Re-check port availability after stopping bridge
        setTimeout(async () => {
          if (window.electron) {
            try {
              const ports = [8000, 8080, 3000, 5000, 9000];
              const results = await window.electron.checkPortsAvailability(
                ports,
                networkLan
              );
              const availabilityMap = new Map<number, boolean>();
              results.forEach((result) => {
                availabilityMap.set(result.port, result.available);
              });
              setPortAvailability(availabilityMap);
            } catch (error) {
              console.error("Error re-checking ports after stop:", error);
            }
          }
        }, 1000); // Wait 1 second for port to be released
      }
    } catch (error) {
      console.error("Error stopping bridge:", error);
      alert(
        `Error stopping bridge: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    } finally {
      setIsStopping(false);
    }
  };

  return (
    <div className="min-h-screen md:h-screen md:overflow-hidden w-full bg-gradient-to-tr from-background to-accent/50 flex items-center justify-center p-4 sm:p-6 md:p-8">
      <div className="w-full max-w-4xl md:h-auto flex items-center justify-center md:overflow-visible">
        {/* Main Container with Frosted Effect */}
        <div className="p-4 sm:p-6 md:p-8 space-y-4 sm:space-y-5 md:space-y-6 w-full">
          {/* Header */}
          <div className="flex items-center justify-between mb-2 sm:mb-2 md:mb-3">
            <button className="text-card-foreground hover:text-card-foreground/80 transition-colors">
              <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
            </button>
            <div className="flex-1 flex justify-center">
              <img src={logo} alt="broadify" className="h-14 sm:h-16 md:h-20" />
            </div>
            <div className="flex items-center gap-2">
              <div
                className={`w-3 h-3 rounded-full ${
                  bridgeStatus.running && bridgeStatus.reachable
                    ? "bg-green-500"
                    : bridgeStatus.running
                    ? "bg-yellow-500"
                    : "bg-destructive"
                }`}
              />
              <span className="text-card-foreground text-xs sm:text-sm font-semibold">
                {bridgeStatus.running && bridgeStatus.reachable
                  ? "Running"
                  : bridgeStatus.running
                  ? "Starting..."
                  : "Stopped"}
              </span>
            </div>
          </div>

          {/* Network Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Network
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    LAN
                  </label>
                  <Select
                    value={networkLan}
                    onValueChange={setNetworkLan}
                    disabled={bridgeStatus.running}
                  >
                    <SelectTrigger className="w-full sm:w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0.0.0.0">
                        0.0.0.0 (All Interfaces)
                      </SelectItem>
                      <SelectItem value="127.0.0.1">
                        127.0.0.1 (Localhost)
                      </SelectItem>
                      <SelectItem value="192.168.178.1">
                        192.168.178.1
                      </SelectItem>
                      <SelectItem value="192.168.1.1">192.168.1.1</SelectItem>
                      <SelectItem value="192.168.0.1">192.168.0.1</SelectItem>
                      <SelectItem value="10.0.0.1">10.0.0.1</SelectItem>
                      <SelectItem value="172.16.0.1">172.16.0.1</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    Port
                  </label>
                  <div className="flex items-center gap-2 flex-1">
                    <Select
                      value={networkPort || undefined}
                      onValueChange={setNetworkPort}
                      disabled={bridgeStatus.running || checkingPorts}
                    >
                      <SelectTrigger className="w-full sm:w-24">
                        <SelectValue placeholder="Select">
                          {networkPort || ""}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {[8000, 8080, 3000, 5000, 9000].map((port) => {
                          const available = portAvailability.get(port);
                          const isSelected = networkPort === port.toString();
                          // Disable belegte Ports, aber nicht den aktuell ausgewählten (damit Select sich öffnen kann)
                          const isDisabled = available === false && !isSelected;
                          return (
                            <SelectItem
                              key={port}
                              value={port.toString()}
                              disabled={isDisabled}
                            >
                              <div className="flex items-center gap-2">
                                <div
                                  className={`w-2 h-2 rounded-full ${
                                    available === true
                                      ? "bg-green-500"
                                      : available === false
                                      ? "bg-red-500"
                                      : "bg-gray-400"
                                  }`}
                                />
                                <span>{port}</span>
                                {available === false && (
                                  <span className="text-xs text-red-400">
                                    (belegt)
                                  </span>
                                )}
                              </div>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    {checkingPorts && (
                      <span className="text-xs text-card-foreground/60">
                        Prüfe...
                      </span>
                    )}
                    {!checkingPorts &&
                      portAvailability.has(parseInt(networkPort, 10)) && (
                        <div
                          className={`w-2 h-2 rounded-full ${
                            portAvailability.get(parseInt(networkPort, 10))
                              ? "bg-green-500"
                              : "bg-red-500"
                          }`}
                          title={
                            portAvailability.get(parseInt(networkPort, 10))
                              ? "Port ist frei"
                              : "Port ist belegt"
                          }
                        />
                      )}
                  </div>
                </div>
              </div>
            </div>
          </Card>

          {/* Engine Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6 items-center">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Engine
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 md:gap-6">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px] opacity-0 pointer-events-none">
                    {/* Invisible label for alignment */}
                  </label>
                  <Select value={engineAtem} onValueChange={setEngineAtem}>
                    <SelectTrigger className="w-full sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ATEM 192.168.1.1">
                        ATEM 192.168.1.1
                      </SelectItem>
                      <SelectItem value="ATEM 192.168.1.2">
                        ATEM 192.168.1.2
                      </SelectItem>
                      <SelectItem value="ATEM 192.168.1.10">
                        ATEM 192.168.1.10
                      </SelectItem>
                      <SelectItem value="ATEM 10.0.0.1">
                        ATEM 10.0.0.1
                      </SelectItem>
                      <SelectItem value="ATEM 172.16.0.1">
                        ATEM 172.16.0.1
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    Port
                  </label>
                  <Select value={enginePort} onValueChange={setEnginePort}>
                    <SelectTrigger className="w-full sm:w-24">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="9091">9091</SelectItem>
                      <SelectItem value="9910">9910</SelectItem>
                      <SelectItem value="8080">8080</SelectItem>
                      <SelectItem value="8000">8000</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </Card>

          {/* Outputs Section */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="grid grid-cols-1 md:grid-cols-[100px_1fr] lg:grid-cols-[120px_1fr] gap-4 md:gap-6">
              <h2 className="text-card-foreground font-bold text-base sm:text-lg md:text-lg">
                Outputs
              </h2>
              <div className="space-y-3 sm:space-y-4">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    USK
                  </label>
                  <Select value={outputUsk} onValueChange={setOutputUsk}>
                    <SelectTrigger className="w-full sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="HDMI Decklink Card">
                        HDMI Decklink Card
                      </SelectItem>
                      <SelectItem value="SDI Decklink Card">
                        SDI Decklink Card
                      </SelectItem>
                      <SelectItem value="USB Capture">USB Capture</SelectItem>
                      <SelectItem value="Blackmagic DeckLink 4K">
                        Blackmagic DeckLink 4K
                      </SelectItem>
                      <SelectItem value="Blackmagic DeckLink 8K">
                        Blackmagic DeckLink 8K
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap min-w-[40px] sm:min-w-[50px]">
                    DSK
                  </label>
                  <Select value={outputDsk} onValueChange={setOutputDsk}>
                    <SelectTrigger className="w-full sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="SDI">SDI</SelectItem>
                      <SelectItem value="HDMI">HDMI</SelectItem>
                      <SelectItem value="USB">USB</SelectItem>
                      <SelectItem value="DisplayPort">DisplayPort</SelectItem>
                      <SelectItem value="Thunderbolt">Thunderbolt</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </Card>

          {/* Lets Go / Stop Server Button */}
          <Card variant="frosted" className="p-4 sm:p-5 md:p-6" gradient>
            <div className="flex justify-center">
              {!bridgeStatus.running ? (
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-8 sm:px-24 md:px-32 py-5 sm:py-5 md:py-6 text-base sm:text-lg rounded-lg border border-primary/20 shadow-lg w-full sm:w-auto"
                  onClick={handleLetsGo}
                  disabled={
                    isStarting || !networkPort || networkPort.trim() === ""
                  }
                >
                  {isStarting ? "Starting..." : "Launch GUI"}
                </Button>
              ) : (
                <Button
                  className="bg-destructive hover:bg-destructive/90 text-white font-bold px-8 sm:px-24 md:px-32 py-5 sm:py-5 md:py-6 text-base sm:text-lg rounded-lg border border-red-500/20 shadow-lg w-full sm:w-auto"
                  onClick={handleStopServer}
                  disabled={isStopping}
                >
                  {isStopping ? "Stopping..." : "Stop Server"}
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

export default App;
