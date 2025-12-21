import { useState, useEffect } from "react";
import { Settings, Loader2 } from "lucide-react";
import { Card } from "@/components/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import logo from "./assets/logo.svg";
import type {
  BridgeStatus,
  NetworkConfigT,
  NetworkBindingOptionT,
} from "types";

import "./styles/App.css";

function App() {
  const [networkBindingId, setNetworkBindingId] = useState<string>("localhost");
  const [networkPort, setNetworkPort] = useState<string>("8787");
  const [customPort, setCustomPort] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [networkConfig, setNetworkConfig] = useState<NetworkConfigT | null>(
    null
  );
  const [networkBindingOptions, setNetworkBindingOptions] = useState<
    NetworkBindingOptionT[]
  >([]);
  const [engineAtem, setEngineAtem] = useState("ATEM 192.168.1.1");
  const [enginePort, setEnginePort] = useState("9091");
  const [output1, setOutput1] = useState("HDMI Decklink Card");
  const [output2, setOutput2] = useState("SDI");
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

  // Load network configuration and binding options
  useEffect(() => {
    if (!window.electron) return;

    const loadConfig = async () => {
      try {
        const config = await window.electron.getNetworkConfig();
        setNetworkConfig(config);
        setNetworkBindingId(config.networkBinding.default.id);

        // Load network binding options with detected interfaces
        const options = await window.electron.getNetworkBindingOptions();
        setNetworkBindingOptions(options);

        // Set default port from interface portConfig or global default
        const defaultOption = options.find(
          (opt) => opt.id === config.networkBinding.default.id
        );
        const defaultPort =
          defaultOption?.portConfig?.defaultPort || config.port.default;

        // If "All Interfaces" is selected or portConfig requires customOnly, use custom port
        if (
          config.networkBinding.default.id === "all" ||
          defaultOption?.advanced ||
          defaultOption?.portConfig?.customOnly
        ) {
          setCustomPort(defaultPort.toString());
          setShowAdvanced(true);
        } else {
          setNetworkPort(defaultPort.toString());
          setShowAdvanced(false);
        }
      } catch (error) {
        console.error("Error loading network config:", error);
      }
    };

    loadConfig();
  }, []);

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

  // Get current bind address from selected network binding
  const getCurrentBindAddress = (): string => {
    const option = networkBindingOptions.find(
      (opt) => opt.id === networkBindingId
    );
    return option?.bindAddress || "127.0.0.1";
  };

  // Get current interface port config
  const getCurrentPortConfig = () => {
    const option = networkBindingOptions.find(
      (opt) => opt.id === networkBindingId
    );
    return option?.portConfig;
  };

  // Check port availability on mount and when port changes
  useEffect(() => {
    if (!window.electron || !networkConfig) return;

    const checkPorts = async () => {
      // Don't check ports while bridge is running (would show our own bridge as "in use")
      if (bridgeStatus.running) {
        console.log("[PortCheck] Skipping port check - bridge is running");
        return;
      }

      setCheckingPorts(true);
      try {
        // Synthetic delay of 500ms for better UX
        await new Promise((resolve) => setTimeout(resolve, 500));

        const option = networkBindingOptions.find(
          (opt) => opt.id === networkBindingId
        );
        const bindAddress = option?.bindAddress || "127.0.0.1";
        const ports = [
          networkConfig.port.default,
          ...networkConfig.port.autoFallback,
        ];
        console.log("[PortCheck] Checking ports:", ports, "on", bindAddress);
        const results = await window.electron.checkPortsAvailability(
          ports,
          bindAddress
        );
        console.log("[PortCheck] Results:", results);
        const availabilityMap = new Map<number, boolean>();
        results.forEach((result) => {
          availabilityMap.set(result.port, result.available);
        });
        setPortAvailability(availabilityMap);

        // Check if currently selected port is available on new IP
        // This ensures that when IP changes, if the selected port is not available, it gets reset
        const portConfig = getCurrentPortConfig();
        const useCustomPort =
          portConfig?.customOnly || (showAdvanced && customPort);

        if (useCustomPort && customPort) {
          const currentPort = parseInt(customPort, 10);
          if (!isNaN(currentPort)) {
            // Check custom port availability
            const customPortResult =
              await window.electron.checkPortAvailability(
                currentPort,
                bindAddress
              );
            if (!customPortResult.available) {
              console.log(
                `[PortCheck] Custom port ${currentPort} not available on ${bindAddress}`
              );
              // Don't reset, just log - user can change it
            }
          }
        } else {
          const currentPort = parseInt(networkPort, 10);
          if (!isNaN(currentPort)) {
            const portAvailable = availabilityMap.get(currentPort);
            if (portAvailable === false && ports.includes(currentPort)) {
              console.log(
                `[PortCheck] Port ${currentPort} not available on ${bindAddress}, resetting selection`
              );
              setNetworkPort(networkConfig.port.default.toString());
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
  }, [
    networkBindingId,
    networkPort,
    customPort,
    showAdvanced,
    bridgeStatus.running,
    networkConfig,
    networkBindingOptions,
  ]);

  const handleLetsGo = async () => {
    if (!window.electron || !networkConfig) return;

    // Determine port to use (custom port if interface requires it or if provided, otherwise selected port)
    const portConfig = getCurrentPortConfig();
    const useCustomPort =
      portConfig?.customOnly ||
      (showAdvanced && customPort && customPort.trim() !== "");

    let portToUse: number;
    if (useCustomPort) {
      const portValue =
        customPort ||
        portConfig?.defaultPort?.toString() ||
        networkConfig?.port.default.toString() ||
        "8787";
      if (!portValue || portValue.trim() === "") {
        alert("Bitte geben Sie einen Port ein.");
        return;
      }
      const customPortNum = parseInt(portValue, 10);
      if (isNaN(customPortNum) || customPortNum < 1 || customPortNum > 65535) {
        alert(
          "Ungültiger Custom Port. Bitte geben Sie einen Port zwischen 1 und 65535 ein."
        );
        return;
      }
      portToUse = customPortNum;
    } else {
      if (!networkPort || networkPort.trim() === "") {
        alert("Bitte wählen Sie einen Port aus.");
        return;
      }
      portToUse = parseInt(networkPort, 10);
      if (isNaN(portToUse)) {
        alert("Ungültiger Port. Bitte wählen Sie einen gültigen Port aus.");
        return;
      }
    }

    // Get bind address from selected network binding
    const bindAddress = getCurrentBindAddress();

    setIsStarting(true);
    try {
      const result = await window.electron.bridgeStart({
        host: bindAddress,
        port: portToUse,
      });

      if (!result.success) {
        console.error("Failed to start bridge:", result.error);
        alert(`Failed to start bridge: ${result.error || "Unknown error"}`);
      } else {
        // If port was changed automatically, update UI
        if (result.actualPort && result.actualPort !== portToUse) {
          const portConfig = getCurrentPortConfig();
          const useCustomPort =
            portConfig?.customOnly || (showAdvanced && customPort);
          if (useCustomPort) {
            setCustomPort(result.actualPort.toString());
          } else {
            setNetworkPort(result.actualPort.toString());
          }
          alert(
            `Port ${portToUse} was not available. Bridge started on port ${result.actualPort} instead.`
          );
        }
        console.log("Lets Go!", {
          network: {
            binding: networkBindingId,
            bindAddress,
            port: result.actualPort || portToUse,
          },
          engine: { atem: engineAtem, port: enginePort },
          outputs: { output1: output1, output2: output2 },
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
          if (window.electron && networkConfig) {
            try {
              setCheckingPorts(true);
              // Synthetic delay of 500ms for better UX
              await new Promise((resolve) => setTimeout(resolve, 500));

              const bindAddress = getCurrentBindAddress();
              const ports = [
                networkConfig.port.default,
                ...networkConfig.port.autoFallback,
              ];
              const results = await window.electron.checkPortsAvailability(
                ports,
                bindAddress
              );
              const availabilityMap = new Map<number, boolean>();
              results.forEach((result) => {
                availabilityMap.set(result.port, result.available);
              });
              setPortAvailability(availabilityMap);
            } catch (error) {
              console.error("Error re-checking ports after stop:", error);
            } finally {
              setCheckingPorts(false);
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
            <div className="flex items-center justify-start w-[100px] sm:w-[120px]">
              <button className="text-card-foreground hover:text-card-foreground/80 transition-colors">
                <Settings className="w-5 h-5 sm:w-6 sm:h-6" />
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <img src={logo} alt="broadify" className="h-14 sm:h-16 md:h-20" />
            </div>
            <div className="flex items-center justify-end gap-2 w-[100px] sm:w-[120px]">
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
              <div className="space-y-3 sm:space-y-4">
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px]">
                    Interface
                  </label>
                  <Select
                    value={networkBindingId}
                    onValueChange={(value) => {
                      setNetworkBindingId(value);
                      // Update port based on interface portConfig
                      const option = networkBindingOptions.find(
                        (opt) => opt.id === value
                      );

                      // If "All Interfaces" is selected, automatically switch to custom port
                      if (value === "all" || option?.advanced) {
                        const port =
                          option?.portConfig?.defaultPort ||
                          networkConfig?.port.default ||
                          8787;
                        setCustomPort(port.toString());
                        setShowAdvanced(true);
                      } else if (option?.portConfig) {
                        const port =
                          option.portConfig.defaultPort ||
                          networkConfig?.port.default ||
                          8787;
                        if (option.portConfig.customOnly) {
                          setCustomPort(port.toString());
                          setShowAdvanced(true);
                        } else {
                          setNetworkPort(port.toString());
                          setShowAdvanced(false);
                        }
                      } else {
                        // Fallback to global default
                        const port = networkConfig?.port.default || 8787;
                        setNetworkPort(port.toString());
                        setShowAdvanced(false);
                      }
                    }}
                    disabled={bridgeStatus.running}
                  >
                    <SelectTrigger className="w-full sm:w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {networkBindingOptions.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          <div className="flex items-center gap-2">
                            {option.recommended && (
                              <span className="text-xs text-green-400">★</span>
                            )}
                            <span>{option.label}</span>
                            {option.bindAddress !== "0.0.0.0" &&
                              option.bindAddress !== "127.0.0.1" && (
                                <span className="text-xs text-card-foreground/60">
                                  ({option.bindAddress})
                                </span>
                              )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px]">
                    Port
                  </label>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const portConfig = getCurrentPortConfig();
                      const useCustomOnly =
                        portConfig?.customOnly ||
                        (showAdvanced &&
                          networkConfig?.port.customAdvancedOnly);

                      if (useCustomOnly) {
                        return (
                          <Input
                            type="number"
                            placeholder="Custom Port"
                            value={customPort}
                            onChange={(e) => setCustomPort(e.target.value)}
                            disabled={bridgeStatus.running}
                            min={1}
                            max={65535}
                            className="w-full sm:w-24 border border-card-foreground/15 bg-white/20 hover:bg-white/25 active:bg-white/30 text-card-foreground font-medium placeholder:text-card-foreground/60 focus-visible:ring-card-foreground/30 focus-visible:border-card-foreground/30 shadow-lg shadow-card-foreground/15 hover:shadow-xl hover:shadow-card-foreground/20 focus-visible:shadow-xl focus-visible:shadow-card-foreground/25 transition-all h-9 px-3 py-2 text-sm"
                          />
                        );
                      } else {
                        return (
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
                              {networkConfig &&
                                [
                                  networkConfig.port.default,
                                  ...networkConfig.port.autoFallback,
                                ].map((port) => {
                                  const available = portAvailability.get(port);
                                  const isSelected =
                                    networkPort === port.toString();
                                  const isDisabled =
                                    available === false && !isSelected;
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
                        );
                      }
                    })()}
                    {checkingPorts && (
                      <Loader2 className="w-4 h-4 text-card-foreground/60 animate-spin" />
                    )}
                    {!checkingPorts &&
                      networkPort &&
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
                {(() => {
                  const portConfig = getCurrentPortConfig();
                  const isAllInterfaces = networkBindingId === "all";
                  const showToggle =
                    networkConfig?.port.allowCustom &&
                    networkConfig.port.customAdvancedOnly &&
                    !portConfig?.customOnly;
                  if (!showToggle) return null;

                  return (
                    <div className="flex items-center gap-2 sm:gap-3">
                      <label className="text-card-foreground text-xs sm:text-sm font-semibold whitespace-nowrap w-[60px] sm:w-[70px] opacity-0 pointer-events-none">
                        {/* Invisible label for alignment */}
                      </label>
                      <button
                        type="button"
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className={`text-xs underline ${
                          isAllInterfaces
                            ? "text-card-foreground/30 cursor-not-allowed"
                            : "text-card-foreground/60 hover:text-card-foreground/80"
                        }`}
                        disabled={bridgeStatus.running || isAllInterfaces}
                      >
                        {showAdvanced ? "Default Ports" : "Custom Port"}
                      </button>
                    </div>
                  );
                })()}
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
                    1
                  </label>
                  <Select value={output1} onValueChange={setOutput1}>
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
                    2
                  </label>
                  <Select value={output2} onValueChange={setOutput2}>
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
          <div className="p-4 sm:p-5 md:p-6">
            <div className="flex justify-center">
              {!bridgeStatus.running ? (
                <Button
                  className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold px-8 sm:px-30 md:px-36 py-5 sm:py-6 md:py-6 text-base sm:text-lg rounded-lg border border-primary/20 shadow-lg w-full sm:w-auto"
                  onClick={handleLetsGo}
                  disabled={
                    isStarting ||
                    (() => {
                      const portConfig = getCurrentPortConfig();
                      const useCustomPort =
                        portConfig?.customOnly || (showAdvanced && customPort);
                      if (useCustomPort) {
                        return !customPort || customPort.trim() === "";
                      } else {
                        return !networkPort || networkPort.trim() === "";
                      }
                    })()
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
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
